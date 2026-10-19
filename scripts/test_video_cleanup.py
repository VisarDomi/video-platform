import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("video_cleanup", Path(__file__).with_name("video_cleanup.py"))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
NOW = dt.datetime(2026, 10, 16, 12, tzinfo=dt.timezone.utc)
SCHEMA = """
CREATE TABLE recordings(id TEXT PRIMARY KEY, provider TEXT, source_kind TEXT, source_path TEXT,
 playlist_path TEXT, source_fingerprint TEXT, state TEXT, lease_owner TEXT);
CREATE TABLE artifacts(recording_id TEXT, path TEXT, size_bytes INTEGER, sha256 TEXT, validated_at TEXT, part TEXT);
CREATE TABLE artifact_variants(recording_id TEXT, path TEXT, size_bytes INTEGER, validated_at TEXT);
CREATE TABLE resolution_review_artifacts(recording_id TEXT, path TEXT, size_bytes INTEGER, validated_at TEXT);
CREATE TABLE production_artifact_queue(recording_id TEXT, path TEXT, size_bytes INTEGER, validated_at TEXT, part TEXT);
CREATE TABLE remux_outputs(recording_id TEXT, path TEXT, created_at TEXT);
CREATE TABLE remote_uploads(recording_id TEXT, artifact_part TEXT, attempt_id TEXT, remote_id TEXT, remote_url TEXT, verified_at TEXT);
CREATE TABLE upload_attempts(id TEXT, recording_id TEXT, provider TEXT, status TEXT);
CREATE TABLE upload_confirmations(recording_id TEXT, status TEXT);
CREATE TABLE upload_reservations(recording_id TEXT, status TEXT);
CREATE TABLE provider_removals(recording_id TEXT, provider TEXT, remote_id TEXT);
CREATE TABLE manual_pieces(recording_id TEXT);
"""


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="video-cleanup-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db_path = self.root / "pipeline/pipeline.sqlite"
        self.db_path.parent.mkdir()
        self.artifacts = self.db_path.parent / "artifacts"
        self.artifacts.mkdir()
        self.sources = self.root / "downloads"
        self.sources.mkdir()
        self.desktop = self.root / "Desktop"
        self.desktop.mkdir()
        self.db = sqlite3.connect(self.db_path)
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(SCHEMA)
        self.id = "2026-01-01 120000 fixture"
        self.source = self.sources / "tango/edited" / self.id
        self.source.mkdir(parents=True)
        (self.source / "one.ts").write_bytes(b"original media")
        (self.source / "init.mp4").write_bytes(b"init bytes")
        (self.source / "playlist.m3u8").write_text('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3,\none.ts\n#EXT-X-ENDLIST\n')
        fingerprint = cleanup.source_evidence(self.source)["fingerprint"]
        self.db.execute("INSERT INTO recordings VALUES(?,?,?,?,?,?,?,?)",
                        (self.id, "tango", "edited", str(self.source), str(self.source / "playlist.m3u8"), fingerprint, "xvideos_verified", None))
        self.conversion = self.artifacts / "production-v6" / (self.id + ".production-v6.mp4")
        self.conversion.parent.mkdir()
        self.conversion.write_bytes(b"converted media")
        old = (NOW - dt.timedelta(days=10)).timestamp()
        os.utime(self.conversion, (old, old))
        self.db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?)", (self.id, str(self.conversion), self.conversion.stat().st_size, "hash", (NOW - dt.timedelta(days=9)).isoformat(), "full"))
        self.db.execute("INSERT INTO upload_attempts VALUES(?,?,?,?)", ("attempt", self.id, "porntrex", "accepted"))
        self.db.execute("INSERT INTO remote_uploads VALUES(?,?,?,?,?,?)", (self.id, "full", "attempt", "123", "https://www.porntrex.com/video/123/fixture", NOW.isoformat()))
        self.db.commit()

    def args(self, mode="move-conversions", dry=True):
        return SimpleNamespace(mode=mode, database=self.db_path, artifacts_root=self.artifacts,
                               recordings_root=self.sources, desktop=self.desktop, dry_run=dry,
                               destination=self.desktop / "video-pipeline" / mode,
                               cutoff=NOW - dt.timedelta(days=7) if mode == "move-conversions" else cleanup.month_before(NOW))

    def execute(self, sql, params=()):
        self.db.execute(sql, params)
        self.db.commit()

    def test_dry_run_does_not_write_or_move(self):
        result = cleanup.run(self.args())
        self.assertEqual(result["eligible_count"], 1)
        self.assertTrue(self.conversion.exists())
        self.assertEqual(list(self.desktop.iterdir()), [])

    def test_conversion_age_is_file_and_validation_age_not_capture_date(self):
        os.utime(self.conversion, (NOW.timestamp(), NOW.timestamp()))
        self.assertEqual(cleanup.run(self.args())["eligible_count"], 0)
        old = (NOW - dt.timedelta(days=10)).timestamp()
        os.utime(self.conversion, (old, old))
        self.execute("UPDATE artifacts SET validated_at=?", (NOW.isoformat(),))
        self.assertEqual(cleanup.run(self.args())["eligible_count"], 0)

    def test_conversions_needed_by_unfinished_or_blocked_work_stay(self):
        for state in ["server_ready", "metadata_ready", "xvideos_uploading", "xvideos_uncertain", "blocked", "failed"]:
            with self.subTest(state=state):
                self.execute("UPDATE recordings SET state=?", (state,))
                self.assertEqual(cleanup.run(self.args())["eligible_count"], 0)

    def test_verified_state_alone_is_insufficient(self):
        self.execute("DELETE FROM remote_uploads")
        self.assertEqual(cleanup.run(self.args("move-recordings"))["eligible_count"], 0)

    def test_joined_receipt_covers_original_only_after_batch_verification(self):
        self.execute('CREATE TABLE short_parts(recording_id TEXT, part TEXT, batch_id TEXT, verified INTEGER)')
        batch_id = '2026-01-01 120000 fixture joined-123'
        self.execute('INSERT INTO recordings SELECT ?,provider,source_kind,?, ?,source_fingerprint,?,NULL FROM recordings WHERE id=?',
                     (batch_id, str(self.root/'joined'), str(self.root/'joined/playlist.m3u8'), 'xvideos_verified', self.id))
        self.execute('UPDATE remote_uploads SET recording_id=?', (batch_id,))
        self.execute('UPDATE upload_attempts SET recording_id=?', (batch_id,))
        self.execute('INSERT INTO short_parts VALUES(?,?,?,?)', (self.id,'full',batch_id,1))
        self.execute("UPDATE recordings SET state='cleanup_eligible' WHERE id=?", (self.id,))
        self.assertEqual(cleanup.run(self.args('move-recordings'))['eligible_count'], 1)
        self.execute("UPDATE recordings SET state='xvideos_uncertain' WHERE id=?", (batch_id,))
        self.assertEqual(cleanup.run(self.args('move-recordings'))['eligible_count'], 0)

    def test_removed_joined_upload_keeps_its_original(self):
        self.execute('CREATE TABLE short_parts(recording_id TEXT, part TEXT, batch_id TEXT, verified INTEGER)')
        batch_id = '2026-01-01 120000 fixture joined-123'
        self.execute('INSERT INTO recordings SELECT ?,provider,source_kind,?, ?,source_fingerprint,?,NULL FROM recordings WHERE id=?',
                     (batch_id, str(self.root/'joined'), str(self.root/'joined/playlist.m3u8'), 'xvideos_verified', self.id))
        self.execute('UPDATE remote_uploads SET recording_id=?', (batch_id,))
        self.execute('UPDATE upload_attempts SET recording_id=?', (batch_id,))
        self.execute('INSERT INTO short_parts VALUES(?,?,?,?)', (self.id,'full',batch_id,1))
        self.execute('INSERT INTO provider_removals VALUES(?,?,?)', (batch_id,'porntrex','123'))
        self.assertEqual(cleanup.run(self.args('move-recordings'))['eligible_count'], 0)

    def test_removal_of_this_destination_prevents_move(self):
        self.execute("INSERT INTO provider_removals VALUES(?,?,?)", (self.id, "porntrex", "123"))
        self.assertEqual(cleanup.run(self.args("move-recordings"))["eligible_count"], 0)

    def test_old_removal_does_not_invalidate_other_verified_upload(self):
        self.execute("INSERT INTO provider_removals VALUES(?,?,?)", (self.id, "porntrex", "older-id"))
        self.assertEqual(cleanup.run(self.args("move-recordings"))["eligible_count"], 1)

    def test_unuploaded_short_piece_and_pending_upload_keep_source(self):
        for table, values in [("manual_pieces", (self.id,)), ("upload_confirmations", (self.id, "pending")),
                              ("upload_reservations", (self.id, "active"))]:
            with self.subTest(table=table):
                self.execute(f"INSERT INTO {table} VALUES({','.join('?' for _ in values)})", values)
                self.assertEqual(cleanup.run(self.args("move-recordings"))["eligible_count"], 0)
                self.execute(f"DELETE FROM {table}")
        self.execute("INSERT INTO upload_attempts VALUES(?,?,?,?)", ("inflight", self.id, "porntrex", "started"))
        self.assertEqual(cleanup.run(self.args("move-recordings"))["eligible_count"], 0)

    def test_all_split_parts_must_be_verified(self):
        self.execute("UPDATE artifacts SET part='shape2'")
        self.execute("UPDATE remote_uploads SET artifact_part='shape2'")
        self.assertEqual(cleanup.run(self.args("move-recordings"))["eligible_count"], 0)

    def test_active_lease_prevents_both_moves(self):
        self.execute("UPDATE recordings SET lease_owner='worker'")
        for mode in ("move-conversions", "move-recordings"):
            self.assertEqual(cleanup.run(self.args(mode))["eligible_count"], 0)

    def test_changed_source_and_unreferenced_media_stay(self):
        (self.source / "one.ts").write_bytes(b"changed original")
        self.assertEqual(cleanup.run(self.args("move-recordings"))["eligible_count"], 0)
        fingerprint = cleanup.source_evidence(self.source)["fingerprint"]
        self.execute("UPDATE recordings SET source_fingerprint=?", (fingerprint,))
        (self.source / "extra.ts").write_bytes(b"not uploaded")
        self.assertEqual(cleanup.run(self.args("move-recordings"))["eligible_count"], 0)

    def test_fingerprint_matches_node_millisecond_rounding(self):
        # Real ext4 timestamp: Node's floating-point mtimeMs rounds this up.
        os.utime(self.source / "one.ts", ns=(1759971573965999908, 1759971573965999908))
        os.utime(self.source / "init.mp4", ns=(1759971573000000000, 1759971573000000000))
        expected = hashlib.sha256((self.source / "playlist.m3u8").read_bytes())
        expected.update(("\0one.ts\0" + str(len(b"original media")) + "\0" + "1759971573966").encode())
        expected.update(("\0init.mp4\0" + str(len(b"init bytes")) + "\0" + "1759971573000").encode())
        self.assertEqual(cleanup.source_evidence(self.source)["fingerprint"], expected.hexdigest())

    def test_same_name_raw_folder_is_not_the_uploaded_edited_source(self):
        raw = self.sources / "tango/downloaded" / self.id
        raw.mkdir(parents=True)
        result = cleanup.run(self.args("move-recordings"))
        self.assertEqual(result["eligible_count"], 1)
        self.assertEqual(result["skipped"]["different_folder_from_uploaded_source"], 1)

    def test_symlinked_conversion_is_not_moved(self):
        self.conversion.unlink()
        self.conversion.symlink_to(self.source / "one.ts")
        self.assertEqual(cleanup.run(self.args())["eligible_count"], 0)

    def test_derived_joined_input_links_are_not_conversion_candidates(self):
        inputs = self.artifacts / 'production-v6/joined-sources/fixture'
        inputs.mkdir(parents=True)
        (inputs/'init.mp4').symlink_to(self.source/'init.mp4')
        result = cleanup.run(self.args())
        self.assertEqual(result['eligible_count'], 1)
        self.assertEqual(result['skipped'], {})

    def test_move_preserves_media_and_ledger_and_can_be_rerun(self):
        before = list(self.db.execute("SELECT * FROM remote_uploads").fetchone())
        result = cleanup.run(self.args(dry=False))
        self.assertEqual(result["moved_count"], 1)
        self.assertFalse(self.conversion.exists())
        target = self.args().destination / self.conversion.relative_to(self.artifacts)
        self.assertEqual(target.read_bytes(), b"converted media")
        self.assertTrue(self.source.exists())
        self.assertEqual(list(self.db.execute("SELECT * FROM remote_uploads").fetchone()), before)
        self.assertEqual(cleanup.run(self.args(dry=False))["moved_count"], 0)
        events = [json.loads(line) for line in Path(result["manifest"]).read_text().splitlines()]
        self.assertEqual([x["status"] for x in events], ["started", "intent", "moved", "finished"])

    def test_source_folder_moves_as_a_whole(self):
        result = cleanup.run(self.args("move-recordings", False))
        self.assertEqual(result["moved_count"], 1)
        target = self.args("move-recordings").destination / "tango/edited" / self.id
        self.assertEqual((target / "one.ts").read_bytes(), b"original media")
        self.assertTrue((target / "init.mp4").is_file())
        self.assertFalse(self.source.exists())

    def test_atomic_move_never_overwrites_existing_destination(self):
        destination = self.desktop / "collision"
        destination.write_bytes(b"keep me")
        with self.assertRaises(FileExistsError):
            cleanup.move_no_replace(self.conversion, destination)
        self.assertEqual(destination.read_bytes(), b"keep me")
        self.assertTrue(self.conversion.exists())

    def test_existing_recording_directory_is_never_replaced(self):
        destination = self.desktop / "existing-recording"
        destination.mkdir()
        with self.assertRaises(FileExistsError):
            cleanup.move_no_replace(self.source, destination)
        self.assertTrue((self.source / "one.ts").exists())

    def test_symlinked_desktop_destination_is_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.desktop / "video-pipeline").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "unsafe_destination"):
            cleanup.run(self.args(dry=False))
        self.assertTrue(self.conversion.exists())
        self.assertEqual(list(outside.iterdir()), [])

    def test_state_is_checked_again_under_database_lock(self):
        original = cleanup.ensure_directory
        changed = False
        def change_state(path):
            nonlocal changed
            if not changed:
                changed = True
                self.execute("UPDATE recordings SET state='blocked'")
            return original(path)
        with patch.object(cleanup, "ensure_directory", change_state):
            result = cleanup.run(self.args(dry=False))
        self.assertEqual(result["moved_count"], 0)
        self.assertTrue(self.conversion.exists())

    def test_retired_conversion_requires_unchanged_original(self):
        history = self.db_path.parent / "history/production-v5"
        history.mkdir(parents=True)
        snapshot = sqlite3.connect(history / "snapshot.sqlite")
        self.db.backup(snapshot)
        snapshot.close()
        retired = self.artifacts / "production-v5" / self.conversion.name
        retired.parent.mkdir()
        self.conversion.rename(retired)
        self.execute("DELETE FROM artifacts")
        self.execute("DELETE FROM recordings")
        self.assertEqual(cleanup.run(self.args())["eligible_count"], 1)
        (self.source / "one.ts").write_bytes(b"changed")
        self.assertEqual(cleanup.run(self.args())["eligible_count"], 0)

    def test_calendar_month_handles_month_ends(self):
        self.assertEqual(cleanup.month_before(dt.datetime(2026, 3, 31, tzinfo=dt.timezone.utc)).day, 28)
        self.assertEqual(cleanup.month_before(dt.datetime(2026, 1, 31, tzinfo=dt.timezone.utc)).year, 2025)


if __name__ == "__main__":
    unittest.main()
