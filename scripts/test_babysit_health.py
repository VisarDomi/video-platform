import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from babysit_health import capture_health


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
            INSERT INTO recordings VALUES ('removed-one','blocked','form-host removed video 100 after upload; retained locally and excluded from re-upload',NULL);
            INSERT INTO provider_removals VALUES ('removed-one','form-host','100','provider copy removed','2026-10-01T00:00:00Z');
            INSERT INTO recordings VALUES ('short-a','short_waiting',NULL,NULL),('short-b','short_joined',NULL,NULL);
            INSERT INTO short_parts VALUES ('batch'),('batch');
            INSERT INTO worker_heartbeat VALUES (1,'2026-11-01T00:00:00Z');
            INSERT INTO upload_attempts VALUES ('failed');
        """)
        self.db.commit()

    def health(self):
        return capture_health(self.database, json.loads(self.monitoring.read_text()))

    def test_recorded_provider_removals_require_no_manual_acknowledgement(self):
        original = hashlib.sha256(self.database.read_bytes()).digest()
        result = self.health()
        self.assertEqual(result["queue_health"], "no_action_required")
        self.assertEqual(result["current_pipeline_failures"], 0)
        self.assertEqual(result["actionable_blocked"], 0)
        self.assertEqual(result["actionable_items"], [])
        self.assertEqual(result["unacknowledged_provider_removals"], [])
        self.assertEqual(len(result["known_provider_removal_blocks"]), 1)
        self.assertEqual(result["known_provider_removal_blocks"][0]["status"], "recorded_provider_removal")
        self.assertEqual(result["known_provider_removal_events"], 1)
        self.assertEqual(result["normal_waiting"], {"short_recordings": 1, "joined_members": 1, "prepared_batches": 1})
        self.assertEqual(result["raw_workflow_states"]["blocked"], 1)
        self.assertEqual(hashlib.sha256(self.database.read_bytes()).digest(), original)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM provider_removals").fetchone()[0], 1)

    def test_new_provider_removal_is_classified_automatically_from_database(self):
        self.db.execute(
            "INSERT INTO recordings VALUES ('removed-two','blocked','form-host removed video 200 after upload (404); retained locally and excluded from re-upload',NULL)"
        )
        self.db.execute(
            "INSERT INTO provider_removals VALUES ('removed-two','form-host','200','provider copy removed','2026-11-23T16:00:00Z')"
        )
        self.db.commit()
        result = self.health()
        self.assertEqual(result["queue_health"], "no_action_required")
        self.assertEqual(result["actionable_blocked"], 0)
        self.assertEqual(result["unacknowledged_provider_removals"], [])
        self.assertEqual(len(result["known_provider_removal_blocks"]), 2)
        self.assertEqual(result["known_provider_removal_events"], 2)

    def test_unrelated_block_on_removed_recording_remains_actionable(self):
        self.db.execute("UPDATE recordings SET block_reason='source fingerprint changed' WHERE id='removed-one'")
        self.db.commit()
        result = self.health()
        self.assertEqual(result["queue_health"], "attention_required")
        self.assertEqual(result["actionable_blocked"], 1)
        self.assertEqual(result["known_provider_removal_blocks"], [])

    def test_blocked_row_without_provider_removal_record_remains_actionable(self):
        self.db.execute("INSERT INTO recordings VALUES ('mystery','blocked','form-host removed video 999 after upload',NULL)")
        self.db.commit()
        result = self.health()
        self.assertEqual(result["queue_health"], "attention_required")
        self.assertEqual(result["actionable_blocked"], 1)
        self.assertEqual([r["id"] for r in result["actionable_items"]], ["mystery"])

    def test_real_failed_recordings_and_manual_pieces_remain_actionable(self):
        self.db.execute("INSERT INTO recordings VALUES ('broken','failed','conversion failed',NULL)")
        self.db.execute("INSERT INTO manual_pieces VALUES ('broken','shape1','needs review')")
        self.db.commit()
        result = self.health()
        self.assertEqual(result["queue_health"], "attention_required")
        self.assertEqual(result["current_pipeline_failures"], 1)
        self.assertEqual(result["actionable_items"][0]["id"], "broken")
        self.assertEqual(len(result["manual_pieces"]), 1)


if __name__ == "__main__":
    unittest.main()
