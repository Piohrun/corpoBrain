"""Feasibility probe for the Outlook connector (read-only).

Checks that Python can drive the local classic Outlook through COM, and whether
Outlook's security guard allows reading addresses. It prints only counts and
yes/no answers, never subjects, names or addresses, so the output is safe to
paste into a chat or an issue.

    pip install comtypes
    python scripts/outlook-probe.py

If Outlook shows "A program is trying to access e-mail address information",
note it and answer Deny: that result is what we need to know.
"""

import platform
import sys
import time


def step(label, fn):
    started = time.monotonic()
    try:
        result = fn()
        print(f"[ok]   {label}: {result} ({time.monotonic() - started:.1f}s)")
        return True
    except Exception as e:  # noqa: BLE001 - a probe reports every failure
        print(f"[fail] {label}: {type(e).__name__}: {e}")
        return False


print(f"python {platform.python_version()} on {platform.platform()}")
try:
    import comtypes.client as cc
except ImportError:
    sys.exit("[fail] comtypes is not installed: pip install comtypes")

state = {}


def connect():
    # dynamic=True uses late binding, so comtypes never needs to write
    # generated wrappers into site-packages.
    state["ol"] = cc.CreateObject("Outlook.Application", dynamic=True)
    state["ns"] = state["ol"].GetNamespace("MAPI")
    return f"Outlook {state['ol'].Version}"


if not step("connect to Outlook", connect):
    sys.exit(1)

ns = state["ns"]
step("default store is Exchange", lambda: ns.ExchangeConnectionMode != 0)
step("calendar item count", lambda: ns.GetDefaultFolder(9).Items.Count)
step("inbox item count", lambda: ns.GetDefaultFolder(6).Items.Count)


def first(folder_id):
    items = ns.GetDefaultFolder(folder_id).Items
    items.Sort("[ReceivedTime]" if folder_id == 6 else "[Start]", True)
    item = items.GetFirst()
    if item is None:
        raise RuntimeError("folder is empty")
    return item


step("meeting subject readable", lambda: bool(first(9).Subject))
step("meeting attendees readable (may prompt)", lambda: bool(first(9).RequiredAttendees))
step("meeting organizer readable (may prompt)", lambda: bool(first(9).Organizer))
step("mail sender address readable (may prompt)", lambda: "@" in first(6).SenderEmailAddress
     or first(6).SenderEmailType == "EX")
step("mail body readable (may prompt)", lambda: len(first(6).Body) > 0)
