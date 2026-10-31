import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from babysit_health import acknowledge_current_removals, capture_health


class HealthClassificationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.database = self.root / "pipeline.sqlite"
        self.monitoring = self.root / "monitoring.json"
        self.monitoring.write_text(json.dumps({"ledger_cursors": {"state_events": 42}, "cadence": "daily"}))
        self.db = sqlite3.connect(self.database)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE recordings(id TEXT PRIMARY KEY,state TEXT,block_reason TEXT,source_path TEXT);
            CREATE TABLE provider_removals(recording_id TEXT,provider TEXT,remote_id TEXT,reason TEXT,removed_at TEXT);
            CREATE TABLE short_parts(batch_id TEXT);
            CREATE TABLE manual_pieces(recording_id TEXT,part TEXT,reason TEXT);
            CREATE TABLE worker_heartbeat(id INTEGER,updated_at TEXT);
            CREATE TABLE upload_attempts(status TEXT);
            INSERT INTO recordings VALUES ('old-loss','blocked','porntrex removed video 100 after upload',NULL);
            INSERT INTO provider_removals VALUES ('old-loss','porntrex','100','provider copy removed','2026-10-01T00:00:00Z');
            INSERT INTO recordings VALUES ('short-a','short_waiting',NULL,NULL),('short-b','short_joined',NULL,NULL);
            INSERT INTO short_parts VALUES ('batch'),('batch');
            INSERT INTO worker_heartbeat VALUES (1,'2026-11-01T00:00:00Z');
            INSERT INTO upload_attempts VALUES ('failed');
        """)
        self.db.commit()

    def health(self):
        return capture_health(self.database, json.loads(self.monitoring.read_text()))

    def acknowledge(self):
        return acknowledge_current_removals(self.database, self.monitoring)

    def test_new_provider_loss_is_visible_until_acknowledged(self):
        before = self.health()
        self.assertEqual(before["queue_health"], "attention_required")
        self.assertEqual(before["actionable_blocked"], 1)
        self.assertEqual(len(before["unacknowledged_provider_removals"]), 1)

    def test_known_losses_and_normal_waiting_are_not_pipeline_failures(self):
        original = hashlib.sha256(self.database.read_bytes()).digest()
        self.acknowledge()
        after = self.health()
        self.assertEqual(after["queue_health"], "no_action_required")
        self.assertEqual(after["current_pipeline_failures"], 0)
        self.assertEqual(after["actionable_blocked"], 0)
        self.assertEqual(len(after["known_provider_removal_blocks"]), 1)
        self.assertEqual(after["normal_waiting"], {"short_recordings": 1, "joined_members": 1, "prepared_batches": 1})
        self.assertEqual(after["raw_workflow_states"]["blocked"], 1)
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).digest(), original)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM provider_removals").fetchone()[0], 1)

    def test_new_failure_on_same_recording_is_not_hidden_by_old_acknowledgement(self):
        self.acknowledge()
        self.db.execute("UPDATE recordings SET block_reason='source fingerprint changed' WHERE id='old-loss'")
        self.db.commit()
        health = self.health()
        self.assertEqual(health["queue_health"], "attention_required")
        self.assertEqual(health["actionable_blocked"], 1)
        self.assertEqual(health["known_provider_removal_blocks"], [])
        # Even an explicit bulk acknowledgement cannot hide an unrelated block.
        self.acknowledge()
        self.assertEqual(self.health()["actionable_blocked"], 1)

    def test_new_removed_copy_is_not_hidden_by_old_recording_acknowledgement(self):
        self.acknowledge()
        self.db.execute("INSERT INTO provider_removals VALUES ('old-loss','porntrex','200','new copy removed','2026-11-01T00:00:00Z')")
        self.db.commit()
        health = self.health()
        self.assertEqual([r["remote_id"] for r in health["unacknowledged_provider_removals"]], ["200"])
        self.assertEqual(health["queue_health"], "attention_required")

    def test_real_failed_recordings_and_manual_pieces_remain_actionable(self):
        self.acknowledge()
        self.db.execute("INSERT INTO recordings VALUES ('broken','failed','conversion failed',NULL)")
        self.db.execute("INSERT INTO manual_pieces VALUES ('broken','shape1','needs review')")
        self.db.commit()
        health = self.health()
        self.assertEqual(health["current_pipeline_failures"], 1)
        self.assertEqual(health["actionable_items"][0]["id"], "broken")
        self.assertEqual(len(health["manual_pieces"]), 1)

    def test_acknowledgements_preserve_cursors_and_are_private(self):
        result = self.acknowledge()
        self.assertEqual(result["ledger_cursors"], {"state_events": 42})
        self.assertEqual(result["cadence"], "daily")
        self.assertEqual(self.monitoring.stat().st_mode & 0o777, 0o600)
        self.acknowledge()
        self.assertEqual(len(self.health()["known_provider_removal_blocks"]), 1)

    def test_malformed_acknowledgement_does_not_hide_losses(self):
        self.monitoring.write_text(json.dumps({"acknowledged_provider_removals": [None, {"signature": 123}]}))
        self.assertEqual(len(self.health()["unacknowledged_provider_removals"]), 1)

    def test_cli_requires_apply_for_acknowledgement(self):
        old = self.monitoring.read_bytes()
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("babysit_health.py")),
                                 "--acknowledge-current-removals", "--database", str(self.database),
                                 "--monitoring", str(self.monitoring)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.monitoring.read_bytes(), old)


if __name__ == "__main__":
    unittest.main()
