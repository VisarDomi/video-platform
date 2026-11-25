"""Bounded, read-only dashboard snapshots. No provider calls or media decoding."""
from collections import Counter
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

REPOSITORY = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY / "scripts"))
from babysit_health import capture_health

TZ = ZoneInfo("Europe/Tirane")
CORE_UNITS = ("video-downloader", "video-server", "video-auth", "video-pipeline", "video-xvfb")


def extra_units(value=None):
    """A deployment's own services, "unit=Label;unit=Label" (VIDEO_DASHBOARD_EXTRA_UNITS)."""
    value = os.environ.get("VIDEO_DASHBOARD_EXTRA_UNITS", "") if value is None else value
    units = {}
    for item in value.split(";"):
        unit, _, label = item.partition("=")
        if re.fullmatch(r"[a-z0-9][a-z0-9-]*", unit.strip()):
            units[unit.strip()] = label.strip() or unit.strip()
    return units


EXTRA_UNITS = extra_units()
UNITS = CORE_UNITS + tuple(unit for unit in EXTRA_UNITS if unit not in CORE_UNITS)


def source_sites(data_root):
    """The sites the recordings come from, in the sites file's order."""
    sites_file = Path(os.environ.get("VIDEO_SITES_FILE") or data_root / "sites.json")
    sites = (read_json(sites_file, {}) or {}).get("sites", [])
    return [site["id"] for site in sites if isinstance(site, dict) and isinstance(site.get("id"), str)]


def uplink_setting(data_root):
    """The sites file's "uplink" section (a second network uploads leave from), or None."""
    sites_file = Path(os.environ.get("VIDEO_SITES_FILE") or data_root / "sites.json")
    uplink = (read_json(sites_file, {}) or {}).get("uplink")
    if not isinstance(uplink, dict) or not isinstance(uplink.get("id"), str):
        return None
    return uplink


STAGES = {"server_ready": "convert", "remuxed": "validate", "artifact_valid": "describe",
          "described": "metadata", "metadata_ready": "ready", "upload_admitted": "upload",
          "uploading": "upload", "upload_uncertain": "verify", "upload_verified": "verified",
          "cleanup_eligible": "verified", "short_waiting": "shorts", "short_joined": "shorts",
          "short_cancelled": "history", "blocked": "history", "failed": "attention"}
ACTIVE_STATES = ("server_ready", "remuxed", "artifact_valid", "described", "metadata_ready", "upload_admitted", "uploading")


def read_json(path, fallback=None):
    try:
        if path.stat().st_size > 4_000_000:
            return fallback
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return fallback


def stamp(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (TypeError, ValueError, AttributeError):
        return None


def secret_names(value=None):
    """The names whose values a reason never shows: the core's, plus a deployment's own
    cookie or field names, "name,name" (VIDEO_DASHBOARD_SECRET_NAMES)."""
    value = os.environ.get("VIDEO_DASHBOARD_SECRET_NAMES", "") if value is None else value
    extra = [name.strip() for name in value.split(",") if re.fullmatch(r"[A-Za-z0-9_-]+", name.strip())]
    return ("password", "PHPSESSID", "pkey", "token", *extra)


SECRET_VALUE = re.compile(r"(?i)\b(?:" + "|".join(map(re.escape, secret_names())) + r")\s*[=:]\s*\S+")


def safe_reason(value):
    text = str(value or "").split("\n", 1)[0]
    text = re.sub(r"https?://\S+", "[provider link]", text)
    text = re.sub(r"/(?:home|tmp|run)/[^\s,;]+", "[local file]", text)
    text = SECRET_VALUE.sub("[redacted]", text)
    return text[:240]


def identity(row):
    name = row["id"]
    return {"id": name, "alias": row.get("alias") or name[18:] or name,
            "source_path": row.get("source_path"),
            "provider": row.get("provider"), "captured_at": name[:17],
            "state": row["state"], "stage": STAGES.get(row["state"], row["state"]),
            "seconds": row.get("duration_seconds"), "updated_at": row.get("updated_at"),
            "joined": " joined-" in name}


def supervised_report(path=None, now=None):
    """The services as a supervisor other than systemd reports them (the demo pod's), from
    the file VIDEO_DASHBOARD_SERVICES_FILE names: {"written_at": epoch seconds, "services":
    {unit: {"state", "restarts", "uptime_seconds"}}, "worker_step": {"disposition",
    "reason"} or null}. None without such a file; a report older than a minute (its
    supervisor is gone) reads as every unit unknown."""
    path = path or os.environ.get("VIDEO_DASHBOARD_SERVICES_FILE")
    if not path:
        return None
    report = read_json(Path(path), {}) or {}
    fresh = isinstance(report.get("written_at"), (int, float)) and abs((now or time.time()) - report["written_at"]) <= 60
    reported = report.get("services") if fresh and isinstance(report.get("services"), dict) else {}
    services = {}
    for name in UNITS:
        row = reported.get(name) if isinstance(reported.get(name), dict) else {}
        services[name] = {"state": row.get("state") if isinstance(row.get("state"), str) else "unknown",
                          "restarts": row.get("restarts") if isinstance(row.get("restarts"), int) else 0,
                          "cpu_percent": None, "anonymous_bytes": None,
                          "uptime_seconds": row.get("uptime_seconds") if isinstance(row.get("uptime_seconds"), (int, float)) else None}
    step = report.get("worker_step") if fresh and isinstance(report.get("worker_step"), dict) else None
    return {"services": services,
            "worker_step": {"disposition": step.get("disposition"), "reason": safe_reason(step.get("reason"))} if step else None}


def read_services(previous=None):
    supervised = supervised_report()
    if supervised is not None:
        return supervised["services"], previous
    command = ["systemctl", "--user", "show", *(name + ".service" for name in UNITS),
               "-p", "Id,ActiveState,SubState,NRestarts,MainPID,ControlGroup,CPUUsageNSec,ActiveEnterTimestampMonotonic,InvocationID"]
    now = time.monotonic()
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=3, check=True)
    except (OSError, subprocess.SubprocessError):
        return {name: {"state": "unknown"} for name in UNITS}, previous
    output, next_sample = {}, {}
    for block in result.stdout.strip().split("\n\n"):
        fields = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        name = fields.get("Id", "").removesuffix(".service")
        if name not in UNITS:
            continue
        row = {"state": fields.get("ActiveState", "unknown"), "restarts": int(fields.get("NRestarts", 0)),
               "cpu_percent": None, "anonymous_bytes": None}
        try:
            cpu = int(fields["CPUUsageNSec"])
            invocation = fields["InvocationID"]
            old = (previous or {}).get(name)
            if old and old[0] == invocation and 0 < now - old[2] <= 60 and cpu >= old[1]:
                row["cpu_percent"] = round((cpu - old[1]) / 1e9 / (now - old[2]) / (os.cpu_count() or 1) * 100, 1)
            next_sample[name] = (invocation, cpu, now)
        except (ValueError, KeyError):
            pass
        group = fields.get("ControlGroup")
        if group:
            try:
                values = dict(line.split() for line in (Path("/sys/fs/cgroup") / group.lstrip("/") / "memory.stat").read_text().splitlines())
                row["anonymous_bytes"] = int(values["anon"])
            except (OSError, ValueError, KeyError):
                pass
        try:
            uptime = float(Path("/proc/uptime").read_text().split()[0])
            row["uptime_seconds"] = max(0, uptime - int(fields["ActiveEnterTimestampMonotonic"]) / 1e6)
        except (OSError, ValueError, KeyError):
            row["uptime_seconds"] = None
        output[name] = row
    return output, next_sample


# A lane's own wait that the campaign card shows (conversion first, then description).
LANE_WAITS = ("upload_quota_wait", "resource_wait", "full_ahead")


def merge_worker_steps(events):
    """The worker's current step from its campaign-step journal events, oldest first. With
    lanes (the event's "lane"), each lane's latest step counts: a wait of the convert or the
    describe lane is the campaign's, else the newest step; "uploads" is the upload lane's."""
    latest = {}
    for event in events:
        step = (event.get("result") or {}).get("step") or {}
        lane = event.get("lane") if event.get("lane") in ("convert", "describe", "upload") else None
        latest[lane] = step
    if not latest:
        return None
    if set(latest) == {None}:
        step = latest[None]
    else:
        waiting = [latest[lane] for lane in ("convert", "describe") if (latest.get(lane) or {}).get("disposition") in LANE_WAITS]
        step = waiting[0] if waiting else list(latest.values())[-1]
    uploads = (latest.get("upload") or latest.get(None) or {}).get("uploads")
    return {"disposition": step.get("disposition"), "reason": safe_reason(step.get("reason")),
            "uploads": uploads if isinstance(uploads, str) else None,
            "lanes": {lane: (latest[lane] or {}).get("disposition") for lane in latest if lane}}


def latest_worker_step():
    supervised = supervised_report()
    if supervised is not None:
        return supervised["worker_step"]
    try:
        # Each lane logs a step only when it changes: read far enough back to see all three.
        result = subprocess.run(["journalctl", "--user", "-u", "video-pipeline", "-n", "400", "-o", "json",
                                 "--output-fields=MESSAGE", "--no-pager"],
                                capture_output=True, text=True, timeout=2, check=True)
        if len(result.stdout) > 2_000_000:
            return None
        events = []
        for line in result.stdout.splitlines():
            try:
                event = json.loads(json.loads(line).get("MESSAGE", ""))
                if isinstance(event, dict) and event.get("event") == "campaign-step":
                    events.append(event)
            except (ValueError, AttributeError, TypeError):
                pass
        return merge_worker_steps(events)
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def captures(data_root, downloads_root, sources=()):
    data = read_json(data_root / "live-status.json", {}) or {}
    result = []
    for item in data.get("downloads", [])[:100]:
        # Discovery publishes this row before its first media directory exists.
        # It is not yet a recording and must not invalidate every other card.
        directory = item.get("segmentsDirPath")
        if not isinstance(directory, str) or not directory:
            continue
        folder = Path(directory)
        # Signed URLs and filesystem paths are deliberately never returned.
        row = {"alias": str(item.get("alias") or item.get("streamerId") or "Recording"),
               "provider": folder.parent.parent.parent.name if folder.parent.name == ".active" else None,
               "segments": None, "seconds": None, "last_media_at": None}
        if row["provider"] not in sources:
            row["provider"] = None
        try:
            if not folder.resolve().is_relative_to(downloads_root.resolve()):
                continue
            playlist = folder / "playlist.m3u8"
            text = playlist.read_text()
            row["segments"] = sum(bool(line.strip()) and not line.lstrip().startswith("#") for line in text.splitlines())
            row["seconds"] = sum(float(value) for value in re.findall(r"^#EXTINF:([\d.]+)", text, re.M))
            row["last_media_at"] = datetime.fromtimestamp(playlist.stat().st_mtime, timezone.utc).isoformat()
        except (OSError, ValueError):
            pass
        result.append(row)
    return result


def uplink_allowance(db, uplink, daily, now):
    """One uplink's allowance (the same rule as the pipeline's domain/uploadBudget.ts): day N
    of the local month has released N daily amounts; at most two daily amounts a day."""
    local = now.astimezone(TZ)
    month = local.strftime("%Y-%m")
    released = daily * local.day
    spent = db.execute("SELECT COALESCE(SUM(transmitted_bytes),0) FROM bandwidth_events WHERE calendar_month=? AND uplink=?",
                       (month, uplink)).fetchone()[0]
    reserved = db.execute("SELECT COALESCE(SUM(reserved_bytes),0) FROM upload_reservations WHERE calendar_month=? AND status='reserved' AND uplink=?",
                          (month, uplink)).fetchone()[0]
    since = (now - timedelta(days=2)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    today = local.date()
    spent_today = sum(bytes_ for bytes_, at in db.execute(
        "SELECT transmitted_bytes, created_at FROM bandwidth_events WHERE uplink=? AND created_at>=?", (uplink, since))
        if (stamp(at) or now).astimezone(TZ).date() == today)
    available = released - spent - reserved
    today_room = 2 * daily - spent_today - reserved
    return {"id": uplink, "daily": daily, "released": released, "spent": spent, "spent_today": spent_today,
            "reserved": reserved, "available": max(0, available), "today_room": max(0, today_room),
            "remaining": max(0, min(available, today_room))}


def upload_budget(db, control, now, uplinks=()):
    """Home's allowance at the top level, and every uplink's (home first) in "uplinks"."""
    local = now.astimezone(TZ)
    daily = control["daily_upload_limit_bytes"]
    home = uplink_allowance(db, "home", daily, now)
    next_month = (local.replace(day=28) + timedelta(days=4)).replace(day=1)
    days_in_month = (next_month - timedelta(days=1)).day
    next_release = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return {"month": local.strftime("%Y-%m"), "day": local.day, "days_in_month": days_in_month,
            "month_total": daily * days_in_month, **{key: value for key, value in home.items() if key != "id"},
            "next_release": next_release.isoformat(), "next_amount": daily,
            "uplinks": [home] + [uplink_allowance(db, item["id"], item["daily"], now) for item in uplinks]}


def carrier_summary(db, uplink, ready_bytes, budget):
    """Where the carrier drive is, what it holds for the other uplink, and about how much waits for it."""
    carrier = uplink.get("carrier") or {}
    carrier_id = carrier.get("label") or Path(str(carrier.get("path") or "carrier")).name
    state = db.execute("SELECT * FROM carrier_state WHERE carrier_id=?", (carrier_id,)).fetchone()
    on_drive, files = db.execute("SELECT COALESCE(SUM(size_bytes),0), COUNT(*) FROM carrier_files WHERE carrier_id=? AND state='copied'",
                                 (carrier_id,)).fetchone()
    in_transit_ready = db.execute("""SELECT COALESCE(SUM(f.size_bytes),0) FROM carrier_files f JOIN recordings r ON r.id=f.recording_id
        WHERE f.state='copied' AND r.state='metadata_ready'""").fetchone()[0]
    reserve = budget["remaining"] + budget["daily"]
    return {"id": carrier_id, "location": state["location"] if state else None, "seen_at": state["seen_at"] if state else None,
            "free_bytes": state["free_bytes"] if state else None, "note": state["note"] if state else None,
            "notice": state["last_notice"] if state else None, "on_drive_bytes": on_drive, "files": files,
            "capacity_bytes": int(carrier.get("capacityBytes", 0)),
            "waiting_bytes": max(0, ready_bytes - in_transit_ready - reserve)}


def uploads_held(control, worker_step):
    """Why uploads are held while conversion goes on (None: they are not)."""
    if control["state"] == "paused" and control["attention_reason"]:
        return safe_reason(control["attention_reason"])
    if control["state"] == "paused" and control["resume_at"]:
        return "retry after " + control["resume_at"]
    uploads = (worker_step or {}).get("uploads") or ""
    return uploads[len("held: "):] if uploads.startswith("held: ") else None


def transfer_progress(attempt, artifact_size, now):
    if not attempt:
        return None
    try:
        evidence = json.loads(attempt["evidence_json"])
    except (TypeError, ValueError):
        return None
    points = [e for e in evidence if e.get("stage") in ("file_transfer_progress", "file_transfer_complete")
              and type(e.get("bytesAcknowledged")) is int and stamp(e.get("checkedAt"))]
    if not points:
        return None  # progress_bytes is a budget claim, never a transfer percentage.
    last = points[-1]
    size = artifact_size or last.get("totalBytes")
    acknowledged = last["bytesAcknowledged"]
    if not size or size <= 0 or not 0 <= acknowledged <= size:
        return None
    rate = None
    if len(points) > 1:
        before = points[-2]
        seconds = (stamp(last["checkedAt"]) - stamp(before["checkedAt"])).total_seconds()
        if seconds > 0 and acknowledged > before["bytesAcknowledged"]:
            rate = (acknowledged - before["bytesAcknowledged"]) / seconds
    age = (now - stamp(last["checkedAt"])).total_seconds()
    return {"acknowledged_bytes": acknowledged, "total_bytes": size, "percent": acknowledged / size * 100,
            "bytes_per_second": rate, "eta_seconds": (size - acknowledged) / rate if rate else None,
            "updated_at": last["checkedAt"], "fresh": 0 <= age <= 90,
            "basis": "provider_acknowledged_media"}


def snapshot(data_root, downloads_root, *, now=None, services=None, worker_step=None):
    now = now or datetime.now(timezone.utc)
    db_path = data_root / "pipeline/pipeline.sqlite"
    monitoring = read_json(data_root / "babysit/monitoring.json", {}) or {}
    health = capture_health(db_path, monitoring)
    with closing(sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        control = dict(db.execute("SELECT * FROM campaign_control WHERE id=1").fetchone())
        records = [dict(r) for r in db.execute("""SELECT r.*,p.alias FROM recordings r
            LEFT JOIN recording_provenance p ON p.recording_id=r.id ORDER BY r.id""")]
        counts = Counter(row["state"] for row in records)
        by_id = {row["id"]: row for row in records}
        artifact = {r["recording_id"]: dict(r) for r in db.execute("SELECT recording_id,path,size_bytes FROM artifacts")}
        metadata_titles = {r["recording_id"]: r["title"] for r in db.execute("SELECT recording_id,title FROM upload_metadata") if r["title"]}
        attempts = [dict(r) for r in db.execute("""SELECT a.id,a.recording_id,a.phase,a.started_at,a.evidence_json,a.transfer_started,
            a.uplink,u.calendar_month FROM upload_attempts a LEFT JOIN upload_reservations u ON u.id=a.reservation_id
            WHERE a.status='started' ORDER BY a.started_at DESC LIMIT 3""")]
        active_row = next((r for r in records if r["state"] in ("uploading", "upload_admitted")), None)
        if active_row is None:
            active_row = next((r for r in records if r["lease_owner"] and r["state"] in ACTIVE_STATES), None)
        active = identity(active_row) if active_row else None
        if active:
            active["generated_title"] = metadata_titles.get(active_row["id"])
            if not active["generated_title"]:
                description = db.execute("SELECT output_json FROM descriptions WHERE recording_id=?", (active_row["id"],)).fetchone()
                try:
                    output = json.loads(description["output_json"]) if description else None
                    title = output.get("title") if isinstance(output, dict) else None
                    active["generated_title"] = title if isinstance(title, str) and title.strip() else None
                except (ValueError, TypeError):
                    active["generated_title"] = None
            active["size_bytes"] = artifact.get(active_row["id"], {}).get("size_bytes")
            attempt = next((a for a in attempts if a["recording_id"] == active_row["id"]), None)
            active["started_at"] = attempt["started_at"] if attempt else active_row["updated_at"]
            active["progress"] = transfer_progress(attempt, active["size_bytes"], now)
            active["reservation_month"] = attempt["calendar_month"] if attempt else None
            active["uplink"] = attempt["uplink"] if attempt else None
            active["phase"] = attempt["phase"] if attempt else active["stage"]
            if active["stage"] == "convert":
                try:
                    output = [p.stat().st_size for p in (data_root / "pipeline/artifacts/production-v6").glob("*.partial.mp4")
                              if p.name.startswith(active_row["id"]) and not p.is_symlink()]
                    active["output_bytes"] = sum(output)
                except OSError:
                    active["output_bytes"] = None
        queue = []
        for row in records:
            if row["state"] in ACTIVE_STATES and not (active and row["id"] == active["id"]):
                item = identity(row)
                item["size_bytes"] = artifact.get(row["id"], {}).get("size_bytes")
                item["generated_title"] = metadata_titles.get(row["id"])
                queue.append(item)
        confirmations = [dict(r) for r in db.execute("""SELECT c.recording_id,c.confirm_after,a.remote_id
            FROM upload_confirmations c JOIN upload_attempts a ON a.id=c.attempt_id
            WHERE c.status='pending' ORDER BY c.confirm_after LIMIT 100""")]
        for row in confirmations:
            source = by_id.get(row["recording_id"])
            row["alias"] = identity(source)["alias"] if source else row["recording_id"]
            row["source_path"] = source.get("source_path") if source else None
            row["provider"] = source.get("provider") if source else None
            row["seconds"] = source.get("duration_seconds") if source else None
            row["captured_at"] = row["recording_id"][:17]
            row["generated_title"] = metadata_titles.get(row["recording_id"])
            row["size_bytes"] = artifact.get(row["recording_id"], {}).get("size_bytes")
        batches = []
        for row in db.execute("""SELECT s.batch_id,COUNT(*) clips,SUM(s.duration_seconds) seconds,
            MIN(s.aspect_ratio) aspect FROM short_parts s WHERE s.batch_id IS NOT NULL GROUP BY s.batch_id"""):
            r = dict(row)
            source = by_id.get(r["batch_id"])
            if source and source["state"] != "short_cancelled":
                batches.append({**identity(source), "clips": r["clips"], "seconds": r["seconds"],
                                "orientation": "Portrait" if r["aspect"] < 1 else "Landscape",
                                "size_bytes": artifact.get(source["id"], {}).get("size_bytes")})
        short_waiting = [identity(row) for row in records if row["state"] == "short_waiting"]
        since = (now - timedelta(days=13)).astimezone(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
        utc = lambda date: date.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        aggregate = """SELECT
            SUM(CASE WHEN from_state='uploading' AND to_state='upload_uncertain' AND reason LIKE 'metadata submitted;%' THEN 1 ELSE 0 END) submitted,
            SUM(CASE WHEN to_state='upload_verified' THEN 1 ELSE 0 END) verified,
            SUM(CASE WHEN to_state='remuxed' THEN 1 ELSE 0 END) converted
            FROM state_events WHERE created_at>=? AND created_at<?"""
        days = {}
        for i in range(14):
            begin = since + timedelta(days=i)
            counts_for_day = dict(db.execute(aggregate, (utc(begin), utc(begin + timedelta(days=1)))).fetchone())
            days[begin.date().isoformat()] = {key: counts_for_day[key] or 0 for key in ("submitted", "verified")}
        totals24 = {key: value or 0 for key, value in dict(db.execute(aggregate, (utc(now-timedelta(hours=24)), utc(now+timedelta(milliseconds=1)))).fetchone()).items()}
        events = [dict(r) for r in db.execute("""SELECT recording_id,from_state,to_state,reason,created_at FROM state_events
            WHERE created_at>=? AND from_state IS NOT to_state ORDER BY id DESC LIMIT 50""", (utc(since),))]
        activity = []
        for e in events:
            if e["from_state"] == e["to_state"]:
                continue
            source = by_id.get(e["recording_id"])
            activity.append({
                "recording": e["recording_id"],
                "alias": identity(source)["alias"] if source else e["recording_id"],
                "source_path": source.get("source_path") if source else None,
                "provider": source.get("provider") if source else None,
                "seconds": source.get("duration_seconds") if source else None,
                "from_state": e["from_state"],
                "to_state": e["to_state"],
                "stage": STAGES.get(e["to_state"], e["to_state"]),
                "reason": safe_reason(e["reason"]),
                "at": e["created_at"],
            })
        activity = activity[:50]
        uplink = uplink_setting(data_root)
        budget = upload_budget(db, control, now, [{"id": uplink["id"], "daily": int(uplink.get("dailyBytes", 0))}] if uplink else [])
        ahead = None
        carrier = None
        office = None
        if uplink:
            ready_bytes = db.execute("SELECT COALESCE(SUM(a.size_bytes),0) FROM recordings r JOIN artifacts a ON a.recording_id=r.id "
                                     "WHERE r.state='metadata_ready'").fetchone()[0]
            ahead = {"ready_bytes": ready_bytes,
                     "limit_bytes": int((uplink.get("carrier") or {}).get("capacityBytes", 0)) + 2 * control["daily_upload_limit_bytes"]}
            carrier = carrier_summary(db, uplink, ready_bytes, budget)
            hold = db.execute("SELECT resume_at, reason, failures FROM uplink_holds WHERE uplink=?", (uplink["id"],)).fetchone()
            sending = next((a for a in attempts if a["uplink"] == uplink["id"]), None)
            office = {"id": uplink["id"],
                      "hold": {"resume_at": hold["resume_at"], "reason": safe_reason(hold["reason"]), "failures": hold["failures"]}
                      if hold and hold["resume_at"] and (stamp(hold["resume_at"]) or now) > now else None,
                      "uploading": identity(by_id[sending["recording_id"]])["alias"] if sending and sending["recording_id"] in by_id else None,
                      "progress": transfer_progress(sending, artifact.get(sending["recording_id"], {}).get("size_bytes"), now) if sending else None}
        # The active destination's shared-session checks (none for a destination without one).
        session = db.execute("SELECT logged_in,occurred_at FROM provider_session_events WHERE provider=? AND kind='keepalive' ORDER BY id DESC LIMIT 1",
                             (control.get("upload_provider"),)).fetchone()
    sources = source_sites(data_root)
    live = captures(data_root, downloads_root, sources)
    for row in live:
        last_media = stamp(row["last_media_at"])
        row["active"] = bool(last_media and (now - last_media).total_seconds() <= 30
                             and (services or {}).get("video-downloader", {}).get("state") == "active")
    finalized = {"processing": None, "completed24": None}
    try:
        with closing(sqlite3.connect((data_root / "finalization.sqlite").resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as fdb:
            processing, completed = set(), set()
            since = (now - timedelta(hours=24)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            for path, body in fdb.execute("SELECT recording_path,report_json FROM integrity_checkpoints WHERE updated_at>=? ORDER BY updated_at DESC LIMIT 1000", (since,)):
                report = json.loads(body)
                folder = Path(path)
                if report.get("status") == "processing" and folder.is_dir():
                    processing.add(path)
                finished = stamp(report.get("completedAt"))
                if report.get("status") == "ready" and folder.parent.name == "downloaded" and finished and finished >= now - timedelta(hours=24):
                    completed.add((folder.parent.parent.name, folder.name))
            finalized = {"processing": len(processing), "completed24": len(completed)}
    except (OSError, sqlite3.Error, ValueError, AttributeError):
        pass
    manual_hold = (data_root / "pipeline/user-pause.json").exists() or (data_root / "babysit/PAUSED.json").exists()
    current_services = services or {}
    state = "running"
    if manual_hold:
        state = "user_paused"
    elif current_services.get("video-pipeline", {}).get("state") == "unknown":
        state = "status_unavailable"
    elif current_services.get("video-pipeline", {}).get("state") not in (None, "active"):
        state = "worker_stopped"
    elif ahead is not None and control["state"] == "paused" and (control["resume_at"] or control["attention_reason"]):
        # Converting ahead: a cooldown or an attention hold holds uploads only.
        state = "uploads_held"
    elif control["state"] == "paused":
        state = "cooldown" if control["resume_at"] else "finishing" if active else "paused"
    elif not active and worker_step is None:
        # A bounded journal lookup can fail during boot or disk contention.
        # Running intent plus a heartbeat cannot establish the current wait.
        state = "status_unavailable"
    elif not active and worker_step and worker_step["disposition"] in ("upload_quota_wait", "resource_wait", "full_ahead"):
        state = worker_step["disposition"]
    heartbeat = stamp(health["worker_heartbeat"])
    late_heartbeat = not manual_hold and current_services.get("video-pipeline", {}).get("state") == "active" and (
        heartbeat is None or (now - heartbeat).total_seconds() > 90)
    if late_heartbeat:
        state = "worker_unresponsive"
    alerts = [{"recording": r["id"], "source_path": by_id.get(r["id"], {}).get("source_path"),
               "message": safe_reason(r["block_reason"]), "kind": r["state"]} for r in health["actionable_items"]]
    if state == "worker_stopped":
        alerts.insert(0, {"message": "The upload worker is stopped", "kind": "service"})
    elif late_heartbeat:
        alerts.insert(0, {"message": "The upload worker heartbeat is late", "kind": "service"})
    for unit, label in (("video-downloader", "Recorder"), ("video-server", "Library service"), ("video-auth", "Authentication service")):
        if current_services.get(unit, {}).get("state") in ("inactive", "failed"):
            alerts.append({"message": label + " is stopped", "kind": "service"})
    report = read_json(Path(monitoring.get("latest_report", "/nonexistent")), {}) or {}
    disk = os.statvfs(data_root)
    storage = {"total": disk.f_blocks * disk.f_frsize, "free": disk.f_bavail * disk.f_frsize,
               "inventory": report.get("storage_bytes"), "inventory_at": report.get("storage_observed_at"),
               "planning_runway_days": report.get("runway", {}).get("days")}
    return {"generated_at": now.isoformat(), "fresh": True, "campaign": {"state": state, "resume_at": control["resume_at"],
            "attention": safe_reason(control["attention_reason"]), "worker_heartbeat": health["worker_heartbeat"], "step": worker_step},
            "health": {"attention": len(alerts), "historical_removals": len(health["known_provider_removal_blocks"]), "alerts": alerts},
            "counts": {"verified": counts["upload_verified"] + counts["cleanup_eligible"], "ready": len(queue),
                       "short_waiting": counts["short_waiting"], "short_joined": counts["short_joined"],
                       "prepared_batches": len(batches), "confirming": len(confirmations), "capturing": sum(r["active"] for r in live),
                       "submitted": totals24["submitted"], "receipts_verified": totals24["verified"], "converted": totals24["converted"]},
            "active": active, "captures": live, "finalization": finalized, "queue": queue,
            "confirmations": confirmations, "shorts": {"waiting": short_waiting, "batches": sorted(batches, key=lambda b: b["id"])},
            "budget": budget, "ahead": ahead and {**ahead, "uploads_held": uploads_held(control, worker_step)}, "carrier": carrier, "office": office, "history": [{"date": day, **values} for day, values in days.items()], "activity": activity,
            "services": current_services, "service_labels": EXTRA_UNITS, "sources": sources, "destination": control.get("upload_provider"), "storage": storage,
            "authentication": {"confirmed": bool(session and session[0]), "checked_at": session[1] if session else None},
            "monitoring": {"cadence": monitoring.get("cadence"), "last_check": monitoring.get("last_completed_window_end")}}
