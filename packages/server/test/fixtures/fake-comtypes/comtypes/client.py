"""A stand-in for comtypes.client that fakes just enough of Outlook's object
model for outlook_export.py. The calendar comes from FAKE_OUTLOOK_SCENARIO."""

import datetime as dt
import os
import time

D = dt.datetime


class Entry:
    def __init__(self, name, smtp, kind=0):
        self.Name = name
        self.Address = f"/o=Bank/cn={name}" if kind in (0, 1) else smtp
        self.AddressEntryUserType = kind
        self._smtp = smtp

    def GetExchangeUser(self):
        return type("U", (), {"PrimarySmtpAddress": self._smtp})()

    def GetExchangeDistributionList(self):
        return type("L", (), {"PrimarySmtpAddress": self._smtp})()


class Recipient:
    def __init__(self, entry, kind=1, response=3):
        self.Name = entry.Name
        self.AddressEntry = entry
        self.Type = kind
        self.MeetingResponseStatus = response


class Recipients:
    def __init__(self, items):
        self._items = items
        self.Count = len(items)

    def Item(self, i):
        return self._items[i - 1]


ME = Entry("Me", "Me@Bank.com")
ANNA = Entry("Anna Kowalska", "Anna@Bank.com")
TEAM = Entry("Team DL", "team@bank.com", kind=1)
VENDOR = Entry("John Vendor", "john@vendor.com", kind=10)


class Appointment:
    def __init__(self, gid, subject, start, minutes, **kw):
        self.GlobalAppointmentID = gid
        self.EntryID = "E" + gid
        self.Subject = subject
        self.Start = start
        self.End = start + dt.timedelta(minutes=minutes)
        # pretend local time is UTC+2
        self.StartUTC = self.Start - dt.timedelta(hours=2)
        self.EndUTC = self.End - dt.timedelta(hours=2)
        self.Location = kw.get("location", "")
        self.Organizer = kw.get("organizer", ANNA).Name
        self._organizer = kw.get("organizer", ANNA)
        self.Recipients = Recipients(kw.get("recipients", []))
        self.MeetingStatus = kw.get("meeting_status", 3)
        self.ResponseStatus = kw.get("response", 3)
        self.BusyStatus = kw.get("busy", 2)
        self.IsRecurring = kw.get("recurring", False)
        self.Categories = kw.get("categories", "")
        self.Sensitivity = 0
        self.AllDayEvent = kw.get("all_day", False)

    def GetOrganizer(self):
        return self._organizer


def calendar():
    people = [Recipient(ANNA, 1, 1), Recipient(ME), Recipient(VENDOR, 2, 5), Recipient(TEAM)]
    return [
        Appointment("OLD", "Last month", D(2026, 9, 1, 9), 30, recipients=people),
        Appointment("S", "Standup", D(2026, 10, 5, 9), 15, recipients=people, recurring=True),
        Appointment("S", "Standup", D(2026, 10, 6, 9), 15, recipients=people, recurring=True),
        Appointment("R", "Roadmap: Q4", D(2026, 10, 6, 14), 60, recipients=people,
                    location="Room 4", categories="Planning; Team"),
        Appointment("F", "Focus", D(2026, 10, 7, 8), 120, meeting_status=0),
        Appointment("LATE", "Out of window", D(2026, 11, 30, 9), 30, recipients=people),
    ]


class Items(list):
    IncludeRecurrences = False

    def Sort(self, key):
        self.sort(key=lambda a: a.Start)

    def Restrict(self, _filter):
        raise AssertionError("Restrict is not expected without a locale pattern")

    def GetFirst(self):
        self._i = 0
        return self.GetNext()

    def GetNext(self):
        if os.environ.get("FAKE_OUTLOOK_SCENARIO") == "slow":
            time.sleep(5)
        if self._i >= len(self):
            return None
        self._i += 1
        return self[self._i - 1]


class Folder:
    @property
    def Items(self):
        return Items(calendar())


class Namespace:
    CurrentUser = type("CU", (), {"AddressEntry": ME})()

    def GetDefaultFolder(self, n):
        assert n == 9
        return Folder()


class Outlook:
    Version = "16.0.fake"

    def GetNamespace(self, name):
        return Namespace()


def CreateObject(progid, dynamic=False):
    if os.environ.get("FAKE_OUTLOOK_SCENARIO") == "down":
        raise OSError("Server execution failed")
    assert progid == "Outlook.Application" and dynamic
    return Outlook()
