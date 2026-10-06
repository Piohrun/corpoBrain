"""Export calendar items and flagged mail from the local classic Outlook as NDJSON (read-only).

corpoBrain runs this with the configured Python; it needs only `comtypes`
(pure Python). PowerShell is not used because work laptops may run it in
ConstrainedLanguage mode, which blocks COM.

    python outlook_export.py --calendar-from 2026-09-29 --calendar-to 2026-10-21 \\
                             --mail-since 2026-09-06

stdout, one JSON object per line:
    {"type": "start", "outlook": "16.0...", "me": "me@corp.com"}
    {"type": "filter", "mode": "restrict"}     calendar: Restrict, or "scan" fallback
    {"type": "progress", "scanned": 25}
    {"type": "meeting", ...}            see OutlookMeeting in packages/core
    {"type": "calendar-end", "count": 12, "scanned": 40, "truncated": false}
    {"type": "mail", ...}               see OutlookMail in packages/core
    {"type": "mail-end", "count": 3, "scanned": 9, "source": "todo", "truncated": false}
    {"type": "end"}
Errors go to stderr with a non-zero exit code.
"""

import argparse
import ctypes
import datetime as dt
import json
import re
import sys

MAX_SCANNED = 20000
MAX_ATTENDEES = 150

BUSY = {0: "free", 1: "tentative", 2: "busy", 3: "oof", 4: "elsewhere"}
RESPONSE = {0: None, 1: "organizer", 2: "tentative", 3: "accepted", 4: "declined", 5: "none"}
RECIPIENT_KIND = {1: "required", 2: "optional", 3: "resource"}
EXCHANGE_USER = (0, 5)  # olExchangeUserAddressEntry, olExchangeRemoteUserAddressEntry
EXCHANGE_GROUP = (1,)  # olExchangeDistributionListAddressEntry


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def short_date_pattern():
    """The user's Windows short-date pattern, e.g. 'dd.MM.yyyy' or 'M/d/yyyy'.

    Outlook's Restrict parses dates with the regional settings, so a fixed
    format would silently mis-filter on non-US machines.
    """
    try:
        buf = ctypes.create_unicode_buffer(80)
        if ctypes.windll.kernel32.GetLocaleInfoEx(None, 0x1F, buf, 80):  # LOCALE_SSHORTDATE
            return buf.value
    except (AttributeError, OSError):
        pass
    return None


def format_short_date(day, pattern):
    tokens = {
        "yyyy": f"{day.year:04d}", "yy": f"{day.year % 100:02d}",
        "MM": f"{day.month:02d}", "M": str(day.month),
        "dd": f"{day.day:02d}", "d": str(day.day),
    }
    return re.sub(r"yyyy|yy|MM|M|dd|d", lambda m: tokens[m.group(0)], pattern)


def iso_utc(value):
    return value.replace(microsecond=0).isoformat() + "Z"


class Directory:
    """Resolves Outlook address entries to SMTP addresses, cached per run."""

    def __init__(self, addresses):
        self.addresses = addresses
        self.cache = {}

    def resolve(self, entry, fallback_name=""):
        if entry is None:
            return {"name": fallback_name, "email": None, "group": False}
        try:
            key = entry.Address or entry.Name
        except Exception:  # noqa: BLE001
            key = None
        if key and key in self.cache:
            return self.cache[key]
        name = entry.Name or fallback_name
        email, group = None, False
        try:
            kind = entry.AddressEntryUserType
            group = kind in EXCHANGE_GROUP
            if self.addresses:
                if kind in EXCHANGE_USER:
                    user = entry.GetExchangeUser()
                    email = user.PrimarySmtpAddress if user is not None else None
                elif kind in EXCHANGE_GROUP:
                    dl = entry.GetExchangeDistributionList()
                    email = dl.PrimarySmtpAddress if dl is not None else None
                else:
                    email = entry.Address
        except Exception:  # noqa: BLE001 - one bad entry must not stop the export
            email = None
        if email and "@" not in email:
            email = None
        out = {"name": name, "email": email.lower() if email else None, "group": group}
        if key:
            self.cache[key] = out
        return out


def attendees_of(item, directory):
    out, total = [], 0
    recipients = item.Recipients
    for i in range(1, recipients.Count + 1):
        total += 1
        if len(out) >= MAX_ATTENDEES:
            continue
        r = recipients.Item(i)
        person = directory.resolve(r.AddressEntry, r.Name)
        kind = "group" if person["group"] else RECIPIENT_KIND.get(r.Type, "required")
        out.append({
            "name": person["name"],
            "email": person["email"],
            "kind": kind,
            "response": RESPONSE.get(r.MeetingResponseStatus),
        })
    return out, total


def occurrence_id(item, day):
    gid = item.GlobalAppointmentID or item.EntryID
    # occurrences of a series share the global id; the day tells them apart
    return f"{gid}:{day}" if item.IsRecurring else gid


def export(ns, start, end, directory, filter_mode):
    folder = ns.GetDefaultFolder(9)  # olFolderCalendar
    items = folder.Items
    items.Sort("[Start]")
    items.IncludeRecurrences = True
    source = items
    if filter_mode == "restrict":
        pattern = short_date_pattern()
        # month names or weekdays in the short date cannot be rebuilt reliably
        if pattern and not re.search(r"MMM|ddd|g", pattern):
            begin = format_short_date(start, pattern)
            finish = format_short_date(end, pattern)
            source = items.Restrict(f"[Start] < '{finish} 00:00' AND [End] > '{begin} 00:00'")
        else:
            filter_mode = "scan"
    emit({"type": "filter", "mode": filter_mode})

    window_start = dt.datetime.combine(start, dt.time())
    count = scanned = 0
    item = source.GetFirst()
    while item is not None and scanned < MAX_SCANNED:
        scanned += 1
        if scanned % 25 == 0:
            emit({"type": "progress", "scanned": scanned})
        local_start = item.Start
        if local_start.date() >= end:
            break  # sorted by start: nothing later can be in the window
        if item.End > window_start:
            day = local_start.date().isoformat()
            attendees, total = attendees_of(item, directory)
            try:
                organizer = directory.resolve(item.GetOrganizer(), item.Organizer)
            except Exception:  # noqa: BLE001
                organizer = {"name": item.Organizer or "", "email": None}
            categories = [c.strip() for c in re.split(r"[,;]", item.Categories or "") if c.strip()]
            meeting_status = item.MeetingStatus
            emit({
                "type": "meeting",
                "id": occurrence_id(item, day),
                "subject": item.Subject or "",
                "startUtc": iso_utc(item.StartUTC),
                "endUtc": iso_utc(item.EndUTC),
                "day": day,
                "startLocal": local_start.strftime("%H:%M"),
                "endLocal": item.End.strftime("%H:%M"),
                "endDay": item.End.date().isoformat(),
                "allDay": bool(item.AllDayEvent),
                "location": item.Location or None,
                "organizer": {"name": organizer["name"], "email": organizer["email"]},
                "attendees": attendees,
                "attendeeCount": total,
                "busy": BUSY.get(item.BusyStatus, "busy"),
                "isMeeting": meeting_status != 0,
                "cancelled": meeting_status in (5, 7),
                "response": RESPONSE.get(item.ResponseStatus),
                "recurring": bool(item.IsRecurring),
                "categories": categories,
                "private": item.Sensitivity == 2,
            })
            count += 1
        item = source.GetNext()
    return count, scanned


NO_DATE_YEAR = 4500  # Outlook's "none" date is 4501-01-01
PR_INTERNET_MESSAGE_ID = "http://schemas.microsoft.com/mapi/proptag/0x1035001F"


def real_date(value):
    return None if value is None or value.year >= NO_DATE_YEAR else value


def sender_of(item, directory):
    try:
        if item.SenderEmailType == "EX":
            return directory.resolve(item.Sender, item.SenderName)
        address = item.SenderEmailAddress or ""
        return {"name": item.SenderName or address, "email": address.lower() if "@" in address else None}
    except Exception:  # noqa: BLE001
        return {"name": getattr(item, "SenderName", "") or "", "email": None}


def message_id(item):
    # stable across folder moves, unlike EntryID
    try:
        value = item.PropertyAccessor.GetProperty(PR_INTERNET_MESSAGE_ID)
        if value:
            return str(value)
    except Exception:  # noqa: BLE001
        pass
    return item.EntryID


def export_mail(ns, since, directory):
    """Flagged mail received on or after `since`, from Outlook's To-Do search folder."""
    try:
        folder, source = ns.GetDefaultFolder(28), "todo"  # olFolderToDo: flagged items, all folders
    except Exception:  # noqa: BLE001
        folder, source = ns.GetDefaultFolder(6), "inbox"  # olFolderInbox
    items = folder.Items
    count = scanned = 0
    item = items.GetFirst()
    while item is not None and scanned < MAX_SCANNED:
        scanned += 1
        try:
            is_mail = item.Class == 43  # olMail
        except Exception:  # noqa: BLE001
            is_mail = False
        if is_mail and (item.FlagStatus != 0 or item.IsMarkedAsTask):
            received = item.ReceivedTime
            if received.date() >= since:
                sender = sender_of(item, directory)
                due = real_date(item.TaskDueDate)
                body = re.sub(r"\s+", " ", item.Body or "").strip()
                categories = [c.strip() for c in re.split(r"[,;]", item.Categories or "") if c.strip()]
                emit({
                    "type": "mail",
                    "id": message_id(item),
                    "subject": item.Subject or "",
                    "from": {"name": sender["name"], "email": sender["email"]},
                    "received": received.replace(microsecond=0).isoformat(),
                    "due": due.date().isoformat() if due else None,
                    "completed": item.FlagStatus == 1 or real_date(item.TaskCompletedDate) is not None,
                    "flag": item.FlagRequest or None,
                    "importance": {0: "low", 2: "high"}.get(item.Importance, "normal"),
                    "categories": categories,
                    "preview": body[:280],
                })
                count += 1
        item = items.GetNext()
    return count, scanned, source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calendar-from", help="first calendar day, YYYY-MM-DD")
    parser.add_argument("--calendar-to", help="day after the last calendar day, YYYY-MM-DD")
    parser.add_argument("--mail-since", help="flagged mail received on or after, YYYY-MM-DD")
    parser.add_argument("--no-addresses", action="store_true", help="names only, no SMTP lookups")
    parser.add_argument("--scan", action="store_true", help="skip Restrict (locale problems)")
    args = parser.parse_args()
    calendar = bool(args.calendar_from or args.calendar_to)
    if calendar and not (args.calendar_from and args.calendar_to):
        sys.exit("--calendar-from and --calendar-to go together")
    if not calendar and not args.mail_since:
        sys.exit("nothing to export: give a calendar window and/or --mail-since")
    if calendar:
        start = dt.date.fromisoformat(args.calendar_from)
        end = dt.date.fromisoformat(args.calendar_to)
        if end <= start:
            sys.exit("--calendar-to must be after --calendar-from")
    since = dt.date.fromisoformat(args.mail_since) if args.mail_since else None

    try:
        import comtypes.client as cc
    except ImportError:
        sys.exit("comtypes is not installed for this Python: pip install comtypes")
    try:
        ol = cc.CreateObject("Outlook.Application", dynamic=True)
        ns = ol.GetNamespace("MAPI")
    except Exception as e:  # noqa: BLE001
        sys.exit(f"could not connect to Outlook: {e}")

    directory = Directory(addresses=not args.no_addresses)
    try:
        me = directory.resolve(ns.CurrentUser.AddressEntry)["email"]
    except Exception:  # noqa: BLE001
        me = None
    emit({"type": "start", "outlook": ol.Version, "me": me})
    if calendar:
        count, scanned = export(ns, start, end, directory, "scan" if args.scan else "restrict")
        emit({"type": "calendar-end", "count": count, "scanned": scanned,
              "truncated": scanned >= MAX_SCANNED})
    if since:
        count, scanned, source = export_mail(ns, since, directory)
        emit({"type": "mail-end", "count": count, "scanned": scanned, "source": source,
              "truncated": scanned >= MAX_SCANNED})
    emit({"type": "end"})


if __name__ == "__main__":
    main()
