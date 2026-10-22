"""iCalendar (RFC 5545) minimo per la posta: lettura degli eventi (fusi IANA e di Windows), risposte agli inviti
(METHOD:REPLY), inviti nuovi (METHOD:REQUEST) e scrittura degli eventi del calendario."""
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# fusi orari di Windows usati da Outlook/Exchange nei TZID
WIN_TZ = {"W. Europe Standard Time": "Europe/Rome", "Central Europe Standard Time": "Europe/Budapest", "Romance Standard Time": "Europe/Paris",
          "Central European Standard Time": "Europe/Warsaw", "GMT Standard Time": "Europe/London", "UTC": "UTC", "Coordinated Universal Time": "UTC",
          "Eastern Standard Time": "America/New_York", "Pacific Standard Time": "America/Los_Angeles", "E. Europe Standard Time": "Europe/Chisinau",
          "GTB Standard Time": "Europe/Athens", "FLE Standard Time": "Europe/Kiev", "Russian Standard Time": "Europe/Moscow"}


def unfold(text: str) -> list:
    return re.sub(r"\r?\n[ \t]", "", text).replace("\r", "").split("\n")


def parse_line(line):
    m = re.match(r"([^:;]+)((?:;[^:;=]+=(?:\"[^\"]*\"|[^:;]*))*):(.*)$", line)
    if not m:
        return None, {}, ""
    params = {}
    for p in re.findall(r";([^:;=]+)=(\"[^\"]*\"|[^:;]*)", m.group(2)):
        params[p[0].upper()] = p[1].strip('"')
    return m.group(1).upper(), params, m.group(3)


def unesc(v: str) -> str:
    return v.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def esc(v: str) -> str:
    return (v or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _tz(name):
    if not name:
        return None
    try:
        return ZoneInfo(WIN_TZ.get(name, name))
    except Exception:  # noqa: BLE001
        return None


def to_ts(value, params) -> tuple[float, bool]:
    """Valore DTSTART/DTEND -> (secondi epoch, giornata intera)."""
    v = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", v):
        d = datetime.strptime(v[:8], "%Y%m%d")
        return d.timestamp(), True
    utc = v.endswith("Z")
    d = datetime.strptime(v.rstrip("Z")[:15], "%Y%m%dT%H%M%S")
    if utc:
        d = d.replace(tzinfo=timezone.utc)
    else:
        tz = _tz(params.get("TZID"))
        if tz:
            d = d.replace(tzinfo=tz)
    return d.timestamp(), False


def events(text: str) -> list:
    """Eventi (VEVENT) con i campi utili per elenco e calendario."""
    out, cur, depth = [], None, 0
    method = ""
    for line in unfold(text):
        name, params, value = parse_line(line)
        if not name:
            continue
        if name == "METHOD" and cur is None:
            method = value.strip().upper()
        if name == "BEGIN" and value.upper() == "VEVENT":
            cur, depth = {"props": [], "attendees": []}, 0
            continue
        if cur is None:
            continue
        if name == "BEGIN":
            depth += 1
            continue
        if name == "END" and value.upper() == "VEVENT":
            out.append(cur)
            cur = None
            continue
        if name == "END":
            depth -= 1
            continue
        if depth:
            continue
        cur["props"].append((name, params, value))
        if name == "UID":
            cur["uid"] = value.strip()
        elif name == "SUMMARY":
            cur["summary"] = unesc(value)
        elif name == "LOCATION":
            cur["location"] = unesc(value)
        elif name == "DESCRIPTION":
            cur["description"] = unesc(value)
        elif name == "DTSTART":
            cur["start"], cur["allday"] = to_ts(value, params)
        elif name == "DTEND":
            cur["end"], _ = to_ts(value, params)
        elif name == "DURATION":
            cur["duration"] = _dur(value)
        elif name == "RRULE":
            cur["rrule"] = value.strip()
        elif name == "SEQUENCE":
            cur["sequence"] = int(value or 0)
        elif name == "STATUS":
            cur["status"] = value.strip().upper()
        elif name == "ORGANIZER":
            cur["organizer"] = {"a": value.split(":", 1)[-1].strip().lower() if value.lower().startswith("mailto:") else value, "n": params.get("CN", "")}
        elif name == "ATTENDEE":
            cur["attendees"].append({"a": value.split(":", 1)[-1].strip().lower(), "n": params.get("CN", ""), "stato": params.get("PARTSTAT", ""),
                                     "ruolo": params.get("ROLE", "")})
    for e in out:
        e["method"] = method
        if "end" not in e and "start" in e:
            e["end"] = e["start"] + (e.get("duration") or (86400 if e.get("allday") else 3600))
    return out


def _dur(v: str) -> int:
    m = re.fullmatch(r"([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", v.strip())
    if not m:
        return 0
    s = int(m.group(2) or 0) * 7 * 86400 + int(m.group(3) or 0) * 86400 + int(m.group(4) or 0) * 3600 + int(m.group(5) or 0) * 60 + int(m.group(6) or 0)
    return -s if m.group(1) == "-" else s


def fold(line: str) -> str:
    out, b = [], line.encode("utf-8")
    while len(b) > 74:
        cut = 74
        while cut > 0 and (b[cut] & 0xC0) == 0x80:
            cut -= 1
        out.append(b[:cut].decode("utf-8"))
        b = b" " + b[cut:]
    out.append(b.decode("utf-8"))
    return "\r\n".join(out)


def stamp(ts=None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else datetime.now().timestamp(), timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def reply(ev: dict, me: str, my_name: str, partstat: str) -> str:
    """METHOD:REPLY per l'organizzatore: stesse proprieta' chiave dell'invito, un solo ATTENDEE (io) con la risposta."""
    keep = {"UID", "DTSTART", "DTEND", "DURATION", "SUMMARY", "LOCATION", "SEQUENCE", "ORGANIZER", "RECURRENCE-ID", "RRULE"}
    lines = ["BEGIN:VCALENDAR", "PRODID:-//MB Visual//Posta//IT", "VERSION:2.0", "METHOD:REPLY", "BEGIN:VEVENT"]
    for name, params, value in ev["props"]:
        if name in keep:
            p = "".join(f";{k}={v}" if not re.search(r"[:;,\s]", v) else f';{k}="{v}"' for k, v in params.items())
            lines.append(f"{name}{p}:{value}")
    lines.append(f"DTSTAMP:{stamp()}")
    cn = f';CN="{my_name}"' if my_name else ""
    lines.append(f"ATTENDEE;PARTSTAT={partstat}{cn}:mailto:{me}")
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(fold(x) for x in lines) + "\r\n"


def fmt_dt(ts: float, allday=False) -> str:
    if allday:
        return ";VALUE=DATE:" + datetime.fromtimestamp(ts).strftime("%Y%m%d")
    return ":" + stamp(ts)


def make_event(e: dict, method: str = "", organizer: dict | None = None) -> str:
    """Evento -> VCALENDAR (per CalDAV o per un invito con METHOD:REQUEST/CANCEL)."""
    lines = ["BEGIN:VCALENDAR", "PRODID:-//MB Visual//Posta//IT", "VERSION:2.0"]
    if method:
        lines.append("METHOD:" + method)
    lines += ["BEGIN:VEVENT", f"UID:{e.get('uid') or uuid.uuid4().hex + '@mbvisual'}", f"DTSTAMP:{stamp()}",
              "DTSTART" + fmt_dt(e["start"], e.get("allday")), "DTEND" + fmt_dt(e["end"], e.get("allday")),
              "SUMMARY:" + esc(e.get("summary", ""))]
    if e.get("location"):
        lines.append("LOCATION:" + esc(e["location"]))
    if e.get("description"):
        lines.append("DESCRIPTION:" + esc(e["description"]))
    if e.get("rrule"):
        lines.append("RRULE:" + e["rrule"])
    lines.append(f"SEQUENCE:{int(e.get('sequence') or 0)}")
    if method == "CANCEL":
        lines.append("STATUS:CANCELLED")
    if organizer:
        lines.append(f'ORGANIZER;CN="{organizer.get("n", "")}":mailto:{organizer["a"]}')
    for a in e.get("attendees") or []:
        cn = f';CN="{a["n"]}"' if a.get("n") else ""
        lines.append(f"ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT={a.get('stato') or 'NEEDS-ACTION'};RSVP=TRUE{cn}:mailto:{a['a']}")
    for m in e.get("promemoria") or []:
        lines += ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(e.get("summary", "")), f"TRIGGER:-PT{int(m)}M", "END:VALARM"]
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(fold(x) for x in lines) + "\r\n"


def today_ts():
    return datetime.combine(date.today(), datetime.min.time()).timestamp()


_ = timedelta
