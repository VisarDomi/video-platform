import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from babysit_ledger import capture_ledger


class LedgerCursorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "pipeline.sqlite"
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE production_version (id INTEGER PRIMARY KEY,version TEXT);
            INSERT INTO production_version VALUES (1,'production-v6');
            CREATE TABLE state_events (id INTEGER PRIMARY KEY,from_state TEXT,to_state TEXT,reason TEXT,created_at TEXT);
            CREATE TABLE remote_uploads (recording_id TEXT,verified_at TEXT);
            CREATE TABLE provider_removals (recording_id TEXT,removed_at TEXT);
        """)
        self.monitor = {"last_completed_window_end": "2026-10-31T01:00:00Z"}

    def test_backdated_results_after_snapshot_are_counted_once_without_writing(self):
        first = capture_ledger(self.path, self.monitor)
        self.monitor["ledger_cursors"] = first["next_cursors"]
        # The long reconciliation began BEFORE the previous monitoring window
        # closed, then committed these results AFTER that snapshot was taken.
        self.db.execute("INSERT INTO state_events VALUES (1,'uploading','upload_uncertain','metadata submitted; awaiting verification','2026-10-31T00:55:00Z')")
        self.db.execute("INSERT INTO remote_uploads VALUES ('late-copy','2026-10-31T00:55:00Z')")
        self.db.execute("INSERT INTO provider_removals VALUES ('late-removal','2026-10-31T00:55:00Z')")
        self.db.commit()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM remote_uploads WHERE verified_at>=?",
                                        (self.monitor["last_completed_window_end"],)).fetchone()[0], 0)
        original = hashlib.sha256(self.path.read_bytes()).digest()
        second = capture_ledger(self.path, self.monitor)
        self.assertEqual(second["counts"], {"submissions": 1, "verified": 1, "provider_removals": 1})
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).digest(), original)
        self.monitor["ledger_cursors"] = second["next_cursors"]
        self.assertEqual(capture_ledger(self.path, self.monitor)["counts"],
                         {"submissions": 0, "verified": 0, "provider_removals": 0})

    def test_explicit_bootstrap_does_not_repeat_existing_history(self):
        self.db.execute("INSERT INTO remote_uploads VALUES ('old','2026-10-30T23:00:00Z')")
        self.db.execute("INSERT INTO remote_uploads VALUES ('new','2026-10-31T01:01:00Z')")
        self.db.commit()
        snapshot = capture_ledger(self.path, self.monitor)
        self.assertEqual([r["recording_id"] for r in snapshot["remote_uploads"]], ["new"])
        self.monitor["ledger_cursors"] = snapshot["next_cursors"]
        self.assertEqual(capture_ledger(self.path, self.monitor)["remote_uploads"], [])
        self.assertEqual(json.loads(json.dumps(snapshot))["next_cursors"], snapshot["next_cursors"])

    def test_generation_rollover_rebaselines_but_same_generation_rewind_is_an_error(self):
        self.monitor["ledger_cursors"] = {"production_version": "production-v6", "state_events": 10,
                                          "remote_uploads": 10, "provider_removals": 10}
        with self.assertRaisesRegex(ValueError, "rewound"):
            capture_ledger(self.path, self.monitor)
        self.db.execute("UPDATE production_version SET version='production-v7'")
        self.db.execute("INSERT INTO remote_uploads VALUES ('new-generation','2026-10-31T01:01:00Z')")
        self.db.commit()
        snapshot = capture_ledger(self.path, self.monitor)
        self.assertTrue(snapshot["production_version_changed"])
        self.assertEqual(snapshot["counts"]["verified"], 1)


if __name__ == "__main__":
    unittest.main()
