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
UNITS = ("video-downloader", "video-server", "video-auth", "video-pipeline", "video-xvfb", "video-bunkr-downloads")
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


def safe_reason(value):
    text = str(value or "").split("\n", 1)[0]
    text = re.sub(r"https?://\S+", "[provider link]", text)
    text = re.sub(r"/(?:home|tmp|run)/[^\s,;]+", "[local file]", text)
    text = re.sub(r"(?i)\b(?:password|PHPSESSID|kt_member|pkey|token)\s*[=:]\s*\S+", "[redacted]", text)
    return text[:240]


def identity(row):
    name = row["id"]
    return {"id": name, "alias": row.get("alias") or name[18:] or name,
            "provider": row.get("provider"), "captured_at": name[:17],
            "state": row["state"], "stage": STAGES.get(row["state"], row["state"]),
            "seconds": row.get("duration_seconds"), "updated_at": row.get("updated_at"),
            "joined": " joined-" in name}


def read_services(previous=None):
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


def latest_worker_step():
    try:
        result = subprocess.run(["journalctl", "--user", "-u", "video-pipeline", "-n", "30", "-o", "json", "--no-pager"],
                                capture_output=True, text=True, timeout=2, check=True)
        if len(result.stdout) > 300_000:
            return None
        for line in reversed(result.stdout.splitlines()):
            try:
                event = json.loads(json.loads(line).get("MESSAGE", ""))
                if event.get("event") == "campaign-step":
                    step = event.get("result", {}).get("step", {})
                    return {"disposition": step.get("disposition"), "reason": safe_reason(step.get("reason"))}
            except (ValueError, AttributeError):
                pass
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def captures(data_root, downloads_root):
    data = read_json(data_root / "live-status.json", {}) or {}
    result = []
    for item in data.get("downloads", [])[:100]:
        folder = Path(item.get("segmentsDirPath", "/nonexistent"))
        # Signed URLs and filesystem paths are deliberately never returned.
        row = {"alias": str(item.get("alias") or item.get("streamerId") or "Recording"),
               "provider": folder.parent.parent.parent.name if folder.parent.name == ".active" else None,
               "segments": None, "seconds": None, "last_media_at": None}
        if row["provider"] not in ("tango", "fc2", "sc"):
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


def upload_budget(db, control, now):
    local = now.astimezone(TZ)
    month = local.strftime("%Y-%m")
    released = min(control["monthly_upload_limit_bytes"], 100e9 if local.day <= 10 else 300e9 if local.day <= 20 else 700e9)
    spent = db.execute("SELECT COALESCE(SUM(transmitted_bytes),0) FROM bandwidth_events WHERE calendar_month=?", (month,)).fetchone()[0]
    reserved = db.execute("SELECT COALESCE(SUM(reserved_bytes),0) FROM upload_reservations WHERE calendar_month=? AND status='reserved'", (month,)).fetchone()[0]
    if local.day <= 10:
        next_release = local.replace(day=11, hour=0, minute=0, second=0, microsecond=0)
        next_amount = min(control["monthly_upload_limit_bytes"], 300_000_000_000)
    elif local.day <= 20:
        next_release = local.replace(day=21, hour=0, minute=0, second=0, microsecond=0)
        next_amount = min(control["monthly_upload_limit_bytes"], 700_000_000_000)
    else:
        next_release = (local.replace(day=28) + timedelta(days=4)).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        next_amount = min(control["monthly_upload_limit_bytes"], 100_000_000_000)
    return {"month": month, "day": local.day, "released": int(released), "spent": spent, "reserved": reserved,
            "remaining": max(0, int(released) - spent - reserved), "monthly_limit": control["monthly_upload_limit_bytes"],
            "next_release": next_release.isoformat(), "next_amount": next_amount,
            "releases": [{"day": 1, "bytes": 100_000_000_000}, {"day": 11, "bytes": 300_000_000_000}, {"day": 21, "bytes": 700_000_000_000}]}


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
        attempts = [dict(r) for r in db.execute("""SELECT a.id,a.recording_id,a.phase,a.started_at,a.evidence_json,a.transfer_started,
            u.calendar_month FROM upload_attempts a LEFT JOIN upload_reservations u ON u.id=a.reservation_id
            WHERE a.status='started' ORDER BY a.started_at DESC LIMIT 3""")]
        active_row = next((r for r in records if r["state"] in ("uploading", "upload_admitted")), None)
        if active_row is None:
            active_row = next((r for r in records if r["lease_owner"] and r["state"] in ACTIVE_STATES), None)
        active = identity(active_row) if active_row else None
        if active:
            active["source_path"] = active_row["source_path"]
            metadata = db.execute("SELECT title FROM upload_metadata WHERE recording_id=?", (active_row["id"],)).fetchone()
            active["generated_title"] = metadata["title"] if metadata else None
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
            active["phase"] = attempt["phase"] if attempt else active["stage"]
            if active["stage"] == "convert":
                try:
                    output = [p.stat().st_size for p in (data_root / "pipeline/artifacts/production-v6").glob("*.partial.mp4")
                              if p.name.startswith(active_row["id"]) and not p.is_symlink()]
                    active["output_bytes"] = sum(output)
                except OSError:
                    active["output_bytes"] = None
        queue = [identity(row) for row in records if row["state"] in ACTIVE_STATES
                 and not (active and row["id"] == active["id"])]
        confirmations = [dict(r) for r in db.execute("""SELECT c.recording_id,c.confirm_after,a.remote_id
            FROM upload_confirmations c JOIN upload_attempts a ON a.id=c.attempt_id
            WHERE c.status='pending' ORDER BY c.confirm_after LIMIT 100""")]
        for row in confirmations:
            source = by_id.get(row["recording_id"])
            row["alias"] = identity(source)["alias"] if source else row["recording_id"]
        batches = []
        for row in db.execute("""SELECT s.batch_id,COUNT(*) clips,SUM(s.duration_seconds) seconds,
            MIN(s.aspect_ratio) aspect FROM short_parts s WHERE s.batch_id IS NOT NULL GROUP BY s.batch_id"""):
            r = dict(row)
            source = by_id.get(r["batch_id"])
            if source and source["state"] != "short_cancelled":
                batches.append({**identity(source), "clips": r["clips"], "seconds": r["seconds"],
                                "orientation": "Portrait" if r["aspect"] < 1 else "Landscape"})
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
        activity = [{"recording": e["recording_id"], "alias": identity(by_id[e["recording_id"]])["alias"] if e["recording_id"] in by_id else e["recording_id"],
                     "stage": STAGES.get(e["to_state"], e["to_state"]), "at": e["created_at"]}
                    for e in events if e["from_state"] != e["to_state"]][:50]
        budget = upload_budget(db, control, now)
        session = db.execute("SELECT logged_in,occurred_at FROM provider_session_events WHERE provider='porntrex' AND kind='keepalive' ORDER BY id DESC LIMIT 1").fetchone()
    live = captures(data_root, downloads_root)
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
    elif control["state"] == "paused":
        state = "cooldown" if control["resume_at"] else "finishing" if active else "paused"
    elif not active and worker_step and worker_step["disposition"] in ("monthly_quota_wait", "resource_wait"):
        state = worker_step["disposition"]
    heartbeat = stamp(health["worker_heartbeat"])
    late_heartbeat = not manual_hold and current_services.get("video-pipeline", {}).get("state") == "active" and (
        heartbeat is None or (now - heartbeat).total_seconds() > 90)
    if late_heartbeat:
        state = "worker_unresponsive"
    alerts = [{"recording": r["id"], "message": safe_reason(r["block_reason"]), "kind": r["state"]} for r in health["actionable_items"]]
    alerts.extend({"recording": r["recording_id"], "message": "A new provider copy is missing", "kind": "provider_loss"} for r in health["unacknowledged_provider_removals"])
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
            "budget": budget, "history": [{"date": day, **values} for day, values in days.items()], "activity": activity,
            "services": current_services, "storage": storage,
            "authentication": {"confirmed": bool(session and session[0]), "checked_at": session[1] if session else None},
            "monitoring": {"cadence": monitoring.get("cadence"), "last_check": monitoring.get("last_completed_window_end")}}
