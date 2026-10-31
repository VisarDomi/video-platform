#!/usr/bin/env python3
"""Read newly committed pipeline ledger entries without missing backdated batches.

Prints a snapshot and its next cursors; never changes the database or monitor.
Persist next_cursors in monitoring.json only after the full hourly report succeeds.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3


TABLES = {
    "state_events": ("id", "created_at"),
    "remote_uploads": ("rowid", "verified_at"),
    "provider_removals": ("rowid", "removed_at"),
}


def utc(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Ledger window must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def capture_ledger(database_path, monitoring, since=None, now=None):
    observed = now or datetime.now(timezone.utc)
    start = utc(since or monitoring.get("last_completed_window_end")
                or (observed - timedelta(hours=1)).isoformat())
    previous = monitoring.get("ledger_cursors")
    with sqlite3.connect(Path(database_path).resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        # All high-water marks and rows must belong to the same SQLite snapshot.
        db.execute("BEGIN")
        version = db.execute("SELECT version FROM production_version WHERE id=1").fetchone()[0]
        reset = bool(previous and previous.get("production_version") != version)
        cursor = None if reset else previous
        next_cursors = {"production_version": version}
        entries = {}
        for table, (key, timestamp) in TABLES.items():
            maximum = db.execute(f"SELECT COALESCE(MAX({key}),0) FROM {table}").fetchone()[0]
            next_cursors[table] = maximum
            if cursor is not None:
                last = cursor[table]
                if type(last) is not int or last < 0 or last > maximum:
                    raise ValueError(f"Invalid or rewound {table} cursor in unchanged production version")
                rows = db.execute(f"SELECT {key} AS ledger_cursor,* FROM {table} WHERE {key}>? ORDER BY {key}", (last,))
            else:
                rows = db.execute(f"SELECT {key} AS ledger_cursor,* FROM {table} WHERE {timestamp}>=? ORDER BY {key}", (start,))
            entries[table] = [dict(row) for row in rows]
    return {
        "observed_at": observed.isoformat(),
        "bootstrap_since": start if cursor is None else None,
        "production_version_changed": reset,
        "next_cursors": next_cursors,
        "counts": {
            "submissions": sum(row["from_state"] == "uploading" and row["to_state"] == "upload_uncertain"
                               and row["reason"].startswith("metadata submitted;")
                               for row in entries["state_events"]),
            "verified": len(entries["remote_uploads"]),
            "provider_removals": len(entries["provider_removals"]),
        },
        **entries,
    }


def main():
    data = Path.home() / ".local/share/video-services"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=data / "pipeline/pipeline.sqlite")
    parser.add_argument("--monitoring", type=Path, default=data / "babysit/monitoring.json")
    parser.add_argument("--since", help="Bootstrap window start, with timezone; existing cursors take precedence")
    args = parser.parse_args()
    monitoring = json.loads(args.monitoring.read_text()) if args.monitoring.exists() else {}
    print(json.dumps(capture_ledger(args.database, monitoring, args.since), indent=2))


if __name__ == "__main__":
    main()
