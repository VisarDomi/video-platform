#!/usr/bin/env python3
"""Classify queue health without treating recorded provider removals as failures.

SQLite is always read-only. Provider removals recorded in `provider_removals`
automatically exclude those recordings from re-upload to that provider and from
local cleanup; they are retained history, not actionable pipeline faults.
"""
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3


def removal_signature(row):
    values = [row[key] for key in ("recording_id", "provider", "remote_id", "reason")]
    return hashlib.sha256(json.dumps(values, ensure_ascii=True).encode()).hexdigest()


def is_provider_removal_block(row, removals_for_recording):
    """True only when a blocked row's reason explicitly matches a recorded removal."""
    if row["state"] != "blocked" or not row["block_reason"]:
        return False
    return any(
        row["block_reason"].startswith(f'{removal["provider"]} removed video {removal["remote_id"]} ')
        for removal in removals_for_recording
    )


def queue_snapshot(database_path):
    with closing(sqlite3.connect(Path(database_path).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        return {
            "recordings": [dict(r) for r in db.execute("SELECT id,state,block_reason,source_path FROM recordings ORDER BY id")],
            "removals": [dict(r) for r in db.execute("SELECT * FROM provider_removals ORDER BY recording_id,provider,remote_id")],
            "prepared_batches": db.execute("SELECT COUNT(DISTINCT batch_id) FROM short_parts WHERE batch_id IS NOT NULL").fetchone()[0],
            "manual_pieces": [dict(r) for r in db.execute("SELECT recording_id,part,reason FROM manual_pieces")],
            "heartbeat": db.execute("SELECT updated_at FROM worker_heartbeat WHERE id=1").fetchone(),
        }


def capture_health(database_path, monitoring=None):
    del monitoring  # Provider removals live authoritatively in SQLite; no manual ack state needed.
    snapshot = queue_snapshot(database_path)
    rows = snapshot["recordings"]
    removals_by_recording = {}
    for removal in snapshot["removals"]:
        removals_by_recording.setdefault(removal["recording_id"], []).append(removal)
    historical, actionable = [], []
    for row in rows:
        if row["state"] not in ("blocked", "failed", "provenance_review_required"):
            continue
        # A newer source/integrity failure must not disappear merely because
        # this recording also has a recorded provider-removal row.
        if is_provider_removal_block(row, removals_by_recording.get(row["id"], ())):
            historical.append({"recording_id": row["id"], "status": "recorded_provider_removal",
                               "local_source_present": bool(row["source_path"] and Path(row["source_path"]).is_dir())})
        else:
            actionable.append(row)
    counts = Counter(row["state"] for row in rows)
    return {
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "queue_health": "attention_required" if actionable or snapshot["manual_pieces"] else "no_action_required",
        "current_pipeline_failures": counts["failed"],
        "actionable_blocked": sum(row["state"] == "blocked" for row in actionable),
        "actionable_items": actionable,
        "known_provider_removal_blocks": historical,
        "known_provider_removal_events": len(snapshot["removals"]),
        "unacknowledged_provider_removals": [],
        "manual_pieces": snapshot["manual_pieces"],
        "normal_waiting": {"short_recordings": counts["short_waiting"],
                           "joined_members": counts["short_joined"],
                           "prepared_batches": snapshot["prepared_batches"]},
        "worker_heartbeat": snapshot["heartbeat"][0] if snapshot["heartbeat"] else None,
        "raw_workflow_states": dict(counts),
        "scope": "Queue classification only; service, journal, storage and provider checks remain separate.",
    }


def acknowledge_current_removals(database_path, monitoring_path):
    """Compatibility helper: provider removals are authoritative in SQLite and need no acknowledgement."""
    del database_path
    path = Path(monitoring_path)
    return json.loads(path.read_text()) if path.exists() else {}


def main():
    root = Path.home() / ".local/share/video-services"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=root / "pipeline/pipeline.sqlite")
    parser.add_argument("--monitoring", type=Path, default=root / "babysit/monitoring.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    monitoring = json.loads(args.monitoring.read_text()) if args.monitoring.exists() else {}
    result = capture_health(args.database, monitoring)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("Queue:", result["queue_health"].replace("_", " "))
        print(f'Current pipeline failures: {result["current_pipeline_failures"]}; actionable blocks: {result["actionable_blocked"]}')
        print(f'Recorded provider removals: {len(result["known_provider_removal_blocks"])} blocked from re-upload ({result["known_provider_removal_events"]} event(s))')
        waiting = result["normal_waiting"]
        print(f'Shorts: {waiting["short_recordings"]} waiting normally; {waiting["prepared_batches"]} compatible batches prepared')


if __name__ == "__main__":
    main()
