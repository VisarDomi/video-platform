#!/usr/bin/env python3
"""Classify queue health without treating acknowledged provider losses as failures.

SQLite is always read-only. Acknowledgements change only monitoring.json; they
never unblock recordings, grant cleanup coverage or erase provider-removal bans.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile


def removal_signature(row):
    values = [row[key] for key in ("recording_id", "provider", "remote_id", "reason")]
    return hashlib.sha256(json.dumps(values, ensure_ascii=True).encode()).hexdigest()


def queue_snapshot(database_path):
    with sqlite3.connect(Path(database_path).resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        return {
            "recordings": [dict(r) for r in db.execute("SELECT id,state,block_reason,source_path FROM recordings ORDER BY id")],
            "removals": [dict(r) for r in db.execute("SELECT * FROM provider_removals ORDER BY recording_id,provider,remote_id")],
            "prepared_batches": db.execute("SELECT COUNT(DISTINCT batch_id) FROM short_parts WHERE batch_id IS NOT NULL").fetchone()[0],
            "manual_pieces": [dict(r) for r in db.execute("SELECT recording_id,part,reason FROM manual_pieces")],
            "heartbeat": db.execute("SELECT updated_at FROM worker_heartbeat WHERE id=1").fetchone(),
        }


def capture_health(database_path, monitoring):
    snapshot = queue_snapshot(database_path)
    rows = snapshot["recordings"]
    acknowledgements = monitoring.get("acknowledged_provider_removals", [])
    if not isinstance(acknowledgements, list):
        acknowledgements = []
    acknowledged = {entry.get("signature"): entry for entry in acknowledgements
                    if isinstance(entry, dict) and isinstance(entry.get("signature"), str)}
    known, new = [], []
    known_for_recording = {}
    for removal in snapshot["removals"]:
        entry = acknowledged.get(removal_signature(removal))
        if entry:
            known.append(removal)
            known_for_recording.setdefault(removal["recording_id"], []).append(entry)
        else:
            new.append(removal)
    historical, actionable = [], []
    for row in rows:
        if row["state"] not in ("blocked", "failed", "provenance_review_required"):
            continue
        accepted = any(entry.get("block_reason") == row["block_reason"]
                       for entry in known_for_recording.get(row["id"], []))
        # A newer source/integrity failure must not disappear merely because
        # this recording also has an older, acknowledged provider-removal row.
        if row["state"] == "blocked" and row["block_reason"] and accepted:
            historical.append({"recording_id": row["id"], "status": "acknowledged_provider_removal",
                               "local_source_present": bool(row["source_path"] and Path(row["source_path"]).is_dir())})
        else:
            actionable.append(row)
    counts = Counter(row["state"] for row in rows)
    return {
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "queue_health": "attention_required" if actionable or new or snapshot["manual_pieces"] else "no_action_required",
        "current_pipeline_failures": counts["failed"],
        "actionable_blocked": sum(row["state"] == "blocked" for row in actionable),
        "actionable_items": actionable,
        "known_provider_removal_blocks": historical,
        "known_provider_removal_events": len(known),
        "unacknowledged_provider_removals": new,
        "manual_pieces": snapshot["manual_pieces"],
        "normal_waiting": {"short_recordings": counts["short_waiting"],
                           "joined_members": counts["short_joined"],
                           "prepared_batches": snapshot["prepared_batches"]},
        "worker_heartbeat": snapshot["heartbeat"][0] if snapshot["heartbeat"] else None,
        "raw_workflow_states": dict(counts),
        "scope": "Queue classification only; service, journal, storage and provider checks remain separate.",
    }


def acknowledge_current_removals(database_path, monitoring_path):
    snapshot = queue_snapshot(database_path)
    path = Path(monitoring_path)
    monitoring = json.loads(path.read_text()) if path.exists() else {}
    existing = monitoring.get("acknowledged_provider_removals", [])
    entries = {item["signature"]: item for item in existing
               if isinstance(item, dict) and isinstance(item.get("signature"), str)} if isinstance(existing, list) else {}
    records = {row["id"]: row for row in snapshot["recordings"]}
    now = datetime.now(timezone.utc).isoformat()
    for removal in snapshot["removals"]:
        row = records.get(removal["recording_id"], {})
        reason = row.get("block_reason") if row.get("state") == "blocked" else None
        # Acknowledge only a block explicitly attributed to this removal.
        # An unrelated failure remains actionable even during a bulk acknowledgement.
        prefix = f'{removal["provider"]} removed video {removal["remote_id"]} '
        if reason and not reason.startswith(prefix):
            reason = None
        signature = removal_signature(removal)
        entries[signature] = {"signature": signature, "recording_id": removal["recording_id"],
                              "provider": removal["provider"], "remote_id": removal["remote_id"],
                              "block_reason": reason, "acknowledged_at": now,
                              "disposition": "acknowledged_external_provider_loss; not a pipeline malfunction"}
    # Re-read immediately before publishing so other monitor/cursor fields survive.
    monitoring = json.loads(path.read_text()) if path.exists() else {}
    monitoring["acknowledged_provider_removals"] = list(entries.values())
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
            temporary = stream.name
            json.dump(monitoring, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)
    return monitoring


def main():
    root = Path.home() / ".local/share/video-services"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=root / "pipeline/pipeline.sqlite")
    parser.add_argument("--monitoring", type=Path, default=root / "babysit/monitoring.json")
    parser.add_argument("--acknowledge-current-removals", action="store_true",
                        help="Acknowledge already investigated/reported losses; never suppress a new loss unread")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.acknowledge_current_removals and not args.apply:
        parser.error("Acknowledging history requires --apply")
    if args.apply and not args.acknowledge_current_removals:
        parser.error("--apply is only for acknowledging investigated provider removals")
    monitoring = acknowledge_current_removals(args.database, args.monitoring) if args.apply else (
        json.loads(args.monitoring.read_text()) if args.monitoring.exists() else {})
    result = capture_health(args.database, monitoring)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("Queue:", result["queue_health"].replace("_", " "))
        print(f'Current pipeline failures: {result["current_pipeline_failures"]}; actionable blocks: {result["actionable_blocked"]}')
        print(f'Historical provider removals: {len(result["known_provider_removal_blocks"])} acknowledged; re-upload/cleanup bans preserved')
        print(f'Unacknowledged provider removals: {len(result["unacknowledged_provider_removals"])}')
        waiting = result["normal_waiting"]
        print(f'Shorts: {waiting["short_recordings"]} waiting normally; {waiting["prepared_batches"]} compatible batches prepared')


if __name__ == "__main__":
    main()
