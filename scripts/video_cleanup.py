"""Move ledger-approved media to the Desktop for manual review; never delete it."""
import argparse
import calendar
import collections
from contextlib import contextmanager
import csv
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys

FINAL_STATES = {"upload_verified", "cleanup_eligible"}
MEDIA_TABLES = ("artifacts", "artifact_variants", "resolution_review_artifacts",
                "production_artifact_queue", "remux_outputs")
UTC = dt.timezone.utc


@contextmanager
def connect(path, writable=False):
    connection = sqlite3.connect(Path(path).as_uri() + ("?mode=rw" if writable else "?mode=ro"), timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


def safe_path(path, root):
    path, root = Path(path).absolute(), Path(root).absolute()
    if not path.is_relative_to(root) or path.resolve(strict=True) != path:
        raise ValueError("unsafe_or_symlinked_path")
    return path


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def month_before(now):
    year, month = (now.year - 1, 12) if now.month == 1 else (now.year, now.month - 1)
    return now.replace(year=year, month=month, day=min(now.day, calendar.monthrange(year, month)[1]))


def file_identity(path):
    s = path.lstat()
    return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns]


def source_evidence(path):
    """Same fingerprint as pipeline/discovery/inspectRecording.ts, plus file accounting."""
    safe_path(path, path)
    playlist = path / "playlist.m3u8"
    if not stat.S_ISREG(playlist.lstat().st_mode):
        raise ValueError("unsafe_playlist_file")
    raw = playlist.read_bytes()
    text = raw.decode("utf8")
    lines = [line.strip() for line in text.splitlines()]
    if "#EXT-X-ENDLIST" not in lines:
        raise ValueError("live_or_unfinalized")
    names = [line for line in lines if line and not line.startswith("#")]
    if not names:
        raise ValueError("empty_playlist")
    for line in lines:
        match = re.match(r'^#EXT-X-MAP:.*\bURI="([^"]+)"', line)
        if match and match[1] not in names:
            names.append(match[1])
    digest = hashlib.sha256(raw)
    for name in names:
        if Path(name).name != name or name in (".", ".."):
            raise ValueError("unsafe_playlist_entry")
        # A basename under the already checked folder needs only lstat; resolving
        # every parent again for every segment is costly on million-file libraries.
        s = (path / name).lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_size == 0:
            raise ValueError("missing_or_empty_media")
        seconds, nanos = divmod(s.st_mtime_ns, 1_000_000_000)
        # Node fs.Stats forms a double (sec * 1000 + nsec / 1e6), then the
        # pipeline truncates it. Integer division would disagree near .999999ms.
        mtime_ms = int(seconds * 1000 + nanos / 1_000_000)
        digest.update(f"\0{name}\0{s.st_size}\0{mtime_ms}".encode())
    allocated = size = files = 0
    for parent, directories, filenames in os.walk(path, followlinks=False):
        for name in directories + filenames:
            p = Path(parent) / name
            if p.is_symlink():
                raise ValueError("symlink_in_recording")
        for name in filenames:
            p = Path(parent) / name
            s = p.lstat()
            if not stat.S_ISREG(s.st_mode):
                raise ValueError("special_file_in_recording")
            if p.suffix in (".ts", ".mp4", ".m4s", ".aac") and name not in names and s.st_size:
                raise ValueError("unreferenced_media_not_uploaded")
            allocated += s.st_blocks * 512
            size += s.st_size
            files += 1
    return {"fingerprint": digest.hexdigest(), "allocated_bytes": allocated,
            "size_bytes": size, "file_count": files}


def verified_recording(db, recording_id):
    row = db.execute("SELECT * FROM recordings WHERE id=?", (recording_id,)).fetchone()
    if not row:
        raise ValueError("not_in_current_ledger")
    recording = dict(row)
    if recording["state"] not in FINAL_STATES:
        raise ValueError("not_fully_verified:" + recording["state"])
    if recording["lease_owner"]:
        raise ValueError("active_lease")
    for table in ("production_artifact_queue", "manual_pieces"):
        if db.execute(f"SELECT 1 FROM {table} WHERE recording_id=? LIMIT 1", (recording_id,)).fetchone():
            raise ValueError("unfinished_parts")
    if db.execute("SELECT 1 FROM upload_confirmations WHERE recording_id=? AND status='pending'", (recording_id,)).fetchone():
        raise ValueError("pending_confirmation")
    if db.execute("SELECT 1 FROM upload_reservations WHERE recording_id=? AND status NOT IN ('consumed','released')", (recording_id,)).fetchone():
        raise ValueError("active_reservation")
    if db.execute("SELECT 1 FROM upload_attempts WHERE recording_id=? AND status IN ('started','uncertain')", (recording_id,)).fetchone():
        raise ValueError("active_or_uncertain_upload")
    uploads = [dict(r) for r in db.execute("""
        SELECT u.*, a.provider, a.recording_id AS upload_owner, a.status AS attempt_status FROM remote_uploads u
        JOIN upload_attempts a ON a.id=u.attempt_id WHERE u.recording_id=?
    """, (recording_id,))]
    short_parts = []
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='short_parts'").fetchone():
        short_parts = [dict(r) for r in db.execute('SELECT * FROM short_parts WHERE recording_id=?', (recording_id,))]
        if any(not p['verified'] for p in short_parts):
            raise ValueError("unverified_joined_parts")
        if any(p.get('source_fingerprint', recording['source_fingerprint']) != recording['source_fingerprint'] for p in short_parts):
            raise ValueError("joined_source_changed_since_upload")
        joined = [dict(r) for r in db.execute("""
            SELECT u.*, s.part AS source_part, a.provider, a.recording_id AS upload_owner,
                a.status AS attempt_status FROM short_parts s
            JOIN recordings b ON b.id=s.batch_id AND b.state IN ('upload_verified','cleanup_eligible')
            JOIN remote_uploads u ON u.recording_id=b.id AND u.artifact_part='full'
            JOIN upload_attempts a ON a.id=u.attempt_id
            WHERE s.recording_id=? AND s.verified=1
        """, (recording_id,))]
        for upload in joined:
            upload['artifact_part'] = upload.pop('source_part')
        uploads.extend(joined)
    if not uploads:
        raise ValueError("no_verified_destination")
    for upload in uploads:
        if upload["attempt_status"] != "accepted" or upload["provider"] not in ("porntrex",):
            raise ValueError("unverified_destination_identity")
        if not upload["remote_id"] or not upload["remote_url"] or not upload["verified_at"]:
            raise ValueError("incomplete_destination_evidence")
        if db.execute("SELECT 1 FROM provider_removals WHERE recording_id IN (?,?) AND provider=? AND remote_id=?",
                      (recording_id, upload['upload_owner'], upload["provider"], upload["remote_id"])).fetchone():
            raise ValueError("destination_removed")
    parts = {u["artifact_part"] for u in uploads}
    artifact = db.execute("SELECT part FROM artifacts WHERE recording_id=?", (recording_id,)).fetchone()
    final_part = artifact["part"] if artifact else "full"
    if not artifact and short_parts and 'full' not in {p['part'] for p in short_parts}:
        final_part = max((p['part'] for p in short_parts), key=lambda p: int(p.removeprefix('shape')))
    if final_part == "full":
        expected = {"full"}
    else:
        match = re.fullmatch(r"shape([1-9]\d*)", final_part)
        if not match:
            raise ValueError("unknown_artifact_part")
        expected = {f"shape{n}" for n in range(1, int(match[1]) + 1)}
    if not expected.issubset(parts):
        raise ValueError("unverified_parts")
    return recording, uploads


def media_rows(db, path=None):
    for table in MEDIA_TABLES:
        sql = f"SELECT m.*, r.source_path, r.provider FROM {table} m JOIN recordings r ON r.id=m.recording_id"
        params = ()
        if path is not None:
            sql += " WHERE m.path=?"
            params = (str(path),)
        for row in db.execute(sql, params):
            yield dict(row)


def archive_catalog(database, artifacts):
    catalog = collections.defaultdict(list)
    for snapshot in sorted((database.parent / "history").glob("*/*.sqlite")):
        safe_path(snapshot, database.parent / "history")
        with connect(snapshot) as db:
            # Schema inspection is read-only; older absent diagnostic tables are fine.
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in MEDIA_TABLES:
                if table not in tables:
                    continue
                for row in db.execute(f"SELECT m.*, r.source_path, r.provider, r.source_fingerprint AS recorded_source_fingerprint FROM {table} m JOIN recordings r ON r.id=m.recording_id"):
                    evidence = dict(row)
                    evidence["snapshot"] = str(snapshot)
                    relocated = artifacts / snapshot.parent.name / Path(evidence["path"]).name
                    for candidate in {Path(evidence["path"]), relocated}:
                        if candidate.is_relative_to(artifacts):
                            catalog[str(candidate)].append(evidence)
    return catalog


def conversion_candidate(db, path, args, archives):
    safe_path(path, args.artifacts_root)
    s = path.stat()
    if not stat.S_ISREG(s.st_mode):
        raise ValueError("not_regular_media")
    if s.st_mtime >= args.cutoff.timestamp():
        raise ValueError("too_recent")
    current = list(media_rows(db, path))
    entries = current or archives.get(str(path), [])
    if not entries:
        raise ValueError("not_in_artifact_ledgers")
    ids = {e["recording_id"] for e in entries}
    if len(ids) != 1:
        raise ValueError("ambiguous_artifact_owner")
    recording_id = ids.pop()
    row = db.execute("SELECT * FROM recordings WHERE id=?", (recording_id,)).fetchone()
    uploads = []
    if current or row:
        _, uploads = verified_recording(db, recording_id)
        reason = "completed recording; every upload part verified in current ledger"
    else:
        # Retired, unreferenced conversions are redundant only while their source remains.
        original_matches = False
        for entry in entries:
            try:
                original = safe_path(Path(entry["source_path"]), args.recordings_root)
                if source_evidence(original)["fingerprint"] == entry["recorded_source_fingerprint"]:
                    original_matches = True
                    break
            except (OSError, ValueError):
                continue
        if not original_matches:
            raise ValueError("archived_conversion_without_original")
        reason = "retired conversion; absent from active work; original recording retained"
    validated = [e for e in entries if e.get("validated_at") and e.get("size_bytes") == s.st_size]
    if not validated:
        raise ValueError("artifact_size_or_validation_mismatch")
    if max(timestamp(e["validated_at"]) for e in validated) >= args.cutoff.timestamp():
        raise ValueError("too_recent_validation")
    return {"recording_id": recording_id, "source": str(path),
            "destination": str(args.destination / path.relative_to(args.artifacts_root)),
            "identity": file_identity(path), "size_bytes": s.st_size,
            "allocated_bytes": s.st_blocks * 512, "file_count": 1, "links": s.st_nlink,
            "reason": reason, "verified_uploads": uploads}


def recording_candidate(db, path, args):
    safe_path(path, args.recordings_root)
    relative = path.relative_to(args.recordings_root)
    if len(relative.parts) != 3 or relative.parts[1] not in ("edited", "downloaded"):
        raise ValueError("not_a_pipeline_source_folder")
    try:
        recorded = dt.datetime.strptime(path.name[:17], "%Y-%m-%d %H%M%S").astimezone()
    except ValueError:
        raise ValueError("unknown_recording_date") from None
    if recorded >= args.cutoff:
        raise ValueError("too_recent")
    recording, uploads = verified_recording(db, path.name)
    if recording["source_path"] != str(path) or recording["playlist_path"] != str(path / "playlist.m3u8"):
        raise ValueError("different_folder_from_uploaded_source")
    if recording["provider"] != relative.parts[0] or recording["source_kind"] != relative.parts[1]:
        raise ValueError("source_identity_mismatch")
    evidence = source_evidence(path)
    if evidence["fingerprint"] != recording["source_fingerprint"]:
        raise ValueError("source_changed_since_upload")
    return {"recording_id": path.name, "source": str(path),
            "destination": str(args.destination / relative), "identity": file_identity(path),
            **evidence, "reason": "source unchanged; every upload part verified in current ledger",
            "verified_uploads": uploads}


def candidate(db, path, args, archives):
    if args.mode == "move-conversions":
        return conversion_candidate(db, path, args, archives)
    return recording_candidate(db, path, args)


def paths(args):
    if args.mode == "move-conversions":
        for parent, directories, filenames in os.walk(args.artifacts_root, followlinks=False):
            directories[:] = sorted(d for d in directories if not d.startswith(".") and d != "joined-sources")
            for name in sorted(filenames):
                if name.endswith(".mp4") and not name.startswith(".") and ".partial" not in name:
                    yield Path(parent) / name
    else:
        for provider in ("tango", "sc", "fc2"):
            for kind in ("downloaded", "edited"):
                folder = args.recordings_root / provider / kind
                if folder.exists():
                    yield from sorted(p for p in folder.iterdir() if not p.name.startswith(".") and p.is_dir())


def ensure_directory(path):
    path = path.absolute()
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_dir() or path.resolve() != path:
            raise ValueError("unsafe_destination_directory")
    else:
        ensure_directory(path.parent)
        path.mkdir(exist_ok=True)
        if path.is_symlink():
            raise ValueError("unsafe_destination_directory")


def move_no_replace(source, destination):
    """Same-filesystem atomic rename; Linux RENAME_NOREPLACE never overwrites."""
    if source.stat().st_dev != destination.parent.stat().st_dev:
        raise ValueError("different_filesystem; refusing a copy")
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(destination))
    for folder in {source.parent, destination.parent}:
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def run(args):
    archives = archive_catalog(args.database, args.artifacts_root) if args.mode == "move-conversions" else {}
    eligible, skipped = [], collections.Counter()
    with connect(args.database) as db:
        for path in paths(args):
            try:
                item = candidate(db, path, args, archives)
                if Path(item["destination"]).exists() or Path(item["destination"]).is_symlink():
                    raise ValueError("destination_already_exists")
                eligible.append(item)
            except (ValueError, OSError) as error:
                skipped[str(error) if isinstance(error, ValueError) else type(error).__name__] += 1
    summary = {"command": args.mode, "dry_run": args.dry_run, "database": str(args.database), "cutoff": args.cutoff.isoformat(),
               "age_basis": "conversion file/validation date" if args.mode == "move-conversions" else "recording folder capture date",
               "destination": str(args.destination), "eligible_count": len(eligible),
               "eligible_allocated_bytes": sum(e["allocated_bytes"] for e in eligible),
               "skipped": dict(skipped), "moved_count": 0, "moved_allocated_bytes": 0, "errors": []}
    if args.dry_run:
        return {**summary, "items": eligible}
    ensure_directory(args.desktop / "video-pipeline")
    # Both requested review directories exist even when one command finds no candidates.
    for mode in ("move-conversions", "move-recordings"):
        ensure_directory(args.desktop / "video-pipeline" / mode)
    with (args.desktop / "video-pipeline" / ".moves.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        tag = dt.datetime.now(UTC).strftime("%Y%m%dT%H%M%S.%fZ")
        manifest = args.destination / f"moves-{tag}.jsonl"
        review = args.destination / f"review-{tag}.csv"
        with manifest.open("x") as journal, review.open("x", newline="") as sheet, connect(args.database, writable=True) as db:
            writer = csv.DictWriter(sheet, fieldnames=["recording", "from", "to", "allocated_GB", "providers", "provider_links", "reason"])
            writer.writeheader()
            def log(event):
                journal.write(json.dumps(event) + "\n")
                journal.flush()
                os.fsync(journal.fileno())
            log({"status": "started", **summary})
            for old in eligible:
                source, destination = Path(old["source"]), Path(old["destination"])
                try:
                    ensure_directory(destination.parent)
                    # The worker cannot admit/lease/change these rows between this check and rename.
                    db.execute("BEGIN IMMEDIATE")
                    try:
                        fresh = candidate(db, source, args, archives)
                        if fresh["identity"] != old["identity"]:
                            raise ValueError("source_changed_after_preview")
                        log({"status": "intent", **fresh})
                        move_no_replace(source, destination)
                    finally:
                        db.rollback()  # no ledger rows are modified
                    summary["moved_count"] += 1
                    summary["moved_allocated_bytes"] += fresh["allocated_bytes"]
                    log({"status": "moved", **fresh})
                    writer.writerow({"recording": fresh["recording_id"], "from": str(source), "to": str(destination),
                                     "allocated_GB": round(fresh["allocated_bytes"] / 1e9, 6),
                                     "providers": "; ".join(sorted({u["provider"] for u in fresh["verified_uploads"]})),
                                     "provider_links": "; ".join(u["remote_url"] for u in fresh["verified_uploads"]),
                                     "reason": fresh["reason"]})
                    sheet.flush()
                    os.fsync(sheet.fileno())
                except (ValueError, OSError, sqlite3.Error) as error:
                    failure = {"source": str(source), "error": str(error)}
                    summary["errors"].append(failure)
                    log({"status": "skipped_at_move", **failure})
            log({"status": "finished", **summary})
        summary.update(manifest=str(manifest), review_csv=str(review))
    return summary


def main(mode):
    parser = argparse.ArgumentParser(description="Move approved media to Desktop/video-pipeline for manual deletion. Default: move; --dry-run previews without writes.")
    data = Path(os.environ.get("VIDEO_SERVICES_DATA_ROOT", Path.home() / ".local/share/video-services"))
    parser.add_argument("--database", type=Path, default=Path(os.environ.get("VIDEO_PIPELINE_DB", data / "pipeline/pipeline.sqlite")))
    parser.add_argument("--artifacts-root", type=Path, default=Path(os.environ.get("VIDEO_PIPELINE_ARTIFACTS_ROOT", data / "pipeline/artifacts")))
    parser.add_argument("--recordings-root", type=Path, default=Path(os.environ.get("VIDEO_DOWNLOADS_ROOT", Path.home() / "Videos/downloads")))
    parser.add_argument("--desktop", type=Path, default=Path.home() / "Desktop")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true", help="print full machine-readable result")
    if mode == "move-conversions":
        parser.add_argument("--days", type=int, default=7, help="minimum conversion age; default 7 days")
    else:
        parser.add_argument("--days", type=int, help="override default of one calendar month")
    args = parser.parse_args()
    if args.days is not None and args.days < 1:
        parser.error("--days must be positive")
    args.mode = mode
    for name in ("database", "artifacts_root", "recordings_root", "desktop"):
        setattr(args, name, Path(os.path.abspath(getattr(args, name))))
    for root in (args.artifacts_root, args.recordings_root):
        safe_path(root, root)
        if args.desktop.is_relative_to(root) or root.is_relative_to(args.desktop):
            parser.error("Desktop and media roots must not overlap")
    args.destination = args.desktop / "video-pipeline" / mode
    now = dt.datetime.now().astimezone()
    args.cutoff = now - dt.timedelta(days=args.days) if args.days is not None else month_before(now)
    try:
        result = run(args)
    except (ValueError, OSError, sqlite3.Error) as error:
        parser.exit(1, f"{mode}: {error}\n")
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        action = "Would move" if args.dry_run else "Moved"
        count = result["eligible_count"] if args.dry_run else result["moved_count"]
        size = result["eligible_allocated_bytes"] if args.dry_run else result["moved_allocated_bytes"]
        print(f"{action} {count} items ({size / 1e9:.1f} GB) to {args.destination}")
        print("Skipped:", json.dumps(result["skipped"], sort_keys=True))
        if result.get("review_csv"):
            print("Review:", result["review_csv"])
        for error in result["errors"]:
            print(json.dumps(error), file=sys.stderr)
    return 1 if result["errors"] else 0
