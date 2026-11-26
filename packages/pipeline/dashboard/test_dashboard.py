from datetime import datetime, timezone
import gzip
import hashlib
import http.client
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from collector import snapshot, upload_budget, transfer_progress, merge_worker_steps, current_run_events
from babysit_health import acknowledge_current_removals
from server import Snapshot, allowed_client, create_server


class DashboardDataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "pipeline").mkdir()
        (self.root / "babysit").mkdir()
        self.downloads = self.root / "downloads"
        self.downloads.mkdir()
        (self.root / "sites.json").write_text(json.dumps({"sites": [{"id": "live-a"}, {"id": "live-b"}, {"id": "live-c"}]}))
        self.path = self.root / "pipeline/pipeline.sqlite"
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
          CREATE TABLE recordings(id TEXT PRIMARY KEY,provider TEXT,source_path TEXT,source_kind TEXT,
            duration_seconds REAL,state TEXT,block_reason TEXT,lease_owner TEXT,updated_at TEXT);
          CREATE TABLE recording_provenance(recording_id TEXT,alias TEXT);
          CREATE TABLE artifacts(recording_id TEXT,path TEXT,size_bytes INTEGER);
          CREATE TABLE upload_metadata(recording_id TEXT,title TEXT);
          CREATE TABLE descriptions(recording_id TEXT,output_json TEXT);
          CREATE TABLE campaign_control(id INTEGER,state TEXT,daily_upload_limit_bytes INTEGER,resume_at TEXT,attention_reason TEXT,upload_provider TEXT);
          CREATE TABLE upload_attempts(id TEXT,recording_id TEXT,phase TEXT,status TEXT,started_at TEXT,evidence_json TEXT,transfer_started INTEGER,reservation_id TEXT,progress_bytes INTEGER,remote_id TEXT,uplink TEXT DEFAULT 'home');
          CREATE TABLE upload_reservations(id TEXT,calendar_month TEXT,reserved_bytes INTEGER,status TEXT,uplink TEXT NOT NULL DEFAULT 'home',recording_id TEXT);
          CREATE TABLE upload_confirmations(attempt_id TEXT,recording_id TEXT,confirm_after TEXT,status TEXT);
          CREATE TABLE short_parts(batch_id TEXT,recording_id TEXT,duration_seconds REAL,aspect_ratio REAL);
          CREATE TABLE state_events(id INTEGER,recording_id TEXT,from_state TEXT,to_state TEXT,reason TEXT,created_at TEXT);
          CREATE TABLE bandwidth_events(calendar_month TEXT,transmitted_bytes INTEGER,created_at TEXT,uplink TEXT NOT NULL DEFAULT 'home');
          CREATE TABLE provider_session_events(id INTEGER,provider TEXT,kind TEXT,logged_in INTEGER,occurred_at TEXT);
          CREATE TABLE provider_removals(recording_id TEXT,provider TEXT,remote_id TEXT,reason TEXT,removed_at TEXT);
          CREATE TABLE worker_heartbeat(id INTEGER,updated_at TEXT);
          CREATE TABLE manual_pieces(recording_id TEXT,part TEXT,reason TEXT);
          CREATE TABLE carrier_files(carrier_id TEXT,file_name TEXT,recording_id TEXT,size_bytes INTEGER,state TEXT);
          CREATE TABLE carrier_state(carrier_id TEXT,location TEXT,seen_at TEXT,free_bytes INTEGER,note TEXT,last_notice TEXT);
          CREATE TABLE uplink_holds(uplink TEXT,resume_at TEXT,reason TEXT,failures INTEGER);
          INSERT INTO campaign_control VALUES (1,'running',25000000000,NULL,NULL,'video-host');
          INSERT INTO worker_heartbeat VALUES (1,'2026-11-01T00:00:00Z');
          INSERT INTO recordings VALUES ('2026-01-01 010000 alice','live-a','/unused','edited',600,'uploading',NULL,NULL,'2026-11-01T00:00:00Z');
          INSERT INTO recordings VALUES ('2026-01-02 010000 bob','live-a','/unused','edited',500,'upload_verified',NULL,NULL,'2026-11-01T00:00:00Z');
          INSERT INTO recordings VALUES ('2026-01-03 010000 carol','live-c','/unused','edited',20,'short_waiting',NULL,NULL,'2026-11-01T00:00:00Z');
          INSERT INTO artifacts VALUES ('2026-01-01 010000 alice','/private/file.mp4',1000000000);
          INSERT INTO upload_attempts VALUES ('attempt','2026-01-01 010000 alice','started','started','2026-10-31T23:00:00Z','[]',1,'ticket',1000000000,NULL,'home');
          INSERT INTO upload_reservations VALUES ('ticket','2026-10',1016777216,'reserved','home','2026-01-01 010000 alice');
          INSERT INTO bandwidth_events VALUES ('2026-11',2000000000,'2026-11-01T00:00:00Z','home'),('2026-11',1000000000,'2026-10-31T23:30:00Z','home');
          INSERT INTO upload_reservations VALUES ('other','2026-11',4000000000,'reserved','home',NULL);
          INSERT INTO state_events VALUES (1,'2026-01-02 010000 bob','upload_uncertain','upload_verified','verified','2026-10-31T23:45:00Z');
          INSERT INTO state_events VALUES (2,'legacy-copy','upload_uncertain','upload_verified','verified','2026-10-31T23:50:00Z');
        """)
        self.db.commit()
        self.now = datetime(2026, 11, 1, 0, 1, tzinfo=timezone.utc)
        self.services = {"video-pipeline": {"state": "active"}}

    def read(self, **kwargs):
        return snapshot(self.root, self.downloads, now=self.now, services=self.services, **kwargs)

    def job(self, lane, data=None):
        data = data or self.read()
        return next(item for item in data["lanes"] if item["lane"] == lane)["job"]

    def test_read_only_counts_do_not_confuse_verification_events_with_safe_recordings(self):
        before = hashlib.sha256(self.path.read_bytes()).digest()
        data = self.read()
        self.assertEqual(data["counts"]["verified"], 1)
        self.assertEqual(data["counts"]["receipts_verified"], 2)
        self.assertEqual(data["counts"]["short_waiting"], 1)
        self.assertEqual(data["health"]["attention"], 0)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).digest(), before)

    def test_full_file_byte_claim_is_never_used_as_100_percent_progress(self):
        data = self.read()
        upload = self.job("upload", data)
        self.assertEqual(upload["size_bytes"], 1000000000)
        self.assertIsNone(upload["progress"])
        self.assertEqual(upload["reservation_month"], "2026-10")
        self.assertEqual(data["budget"]["reserved"], 4000000000)

    def test_active_queue_and_activity_include_source_paths_without_private_artifacts(self):
        active_source = '/data/downloads/live-a/edited/2026-01-01 010000 alice'
        queued_source = '/data/downloads/live-b/edited/2026-01-04 020000 dave'
        verified_source = '/data/downloads/live-a/edited/2026-01-02 010000 bob'
        self.db.execute("UPDATE recordings SET source_path=? WHERE id='2026-01-01 010000 alice'", (active_source,))
        self.db.execute("UPDATE recordings SET source_path=? WHERE id='2026-01-02 010000 bob'", (verified_source,))
        self.db.execute("INSERT INTO recordings VALUES ('2026-01-04 020000 dave','live-b',?,'edited',420,'server_ready',NULL,NULL,'2026-11-01T00:00:00Z')", (queued_source,))
        self.db.execute("INSERT INTO upload_metadata VALUES ('2026-01-01 010000 alice',?)", ('Generated title [2026-01-01 010000 alice]',))
        self.db.execute("INSERT INTO descriptions VALUES ('2026-01-01 010000 alice',?)", (json.dumps({'title':'Earlier descriptor title'}),))
        self.db.commit()
        data = self.read()
        self.assertEqual(self.job('upload', data)['source_path'], active_source)
        self.assertEqual(self.job('upload', data)['generated_title'], 'Generated title [2026-01-01 010000 alice]')
        self.assertEqual(data['queue'][0]['source_path'], queued_source)
        bob_event = next(e for e in data['activity'] if e['recording'] == '2026-01-02 010000 bob')
        self.assertEqual(bob_event['source_path'], verified_source)
        self.assertEqual(bob_event['from_state'], 'upload_uncertain')
        self.assertEqual(bob_event['to_state'], 'upload_verified')
        self.assertEqual(bob_event['provider'], 'live-a')
        self.assertNotIn('/private/file.mp4', json.dumps(data))

    def test_active_title_can_appear_before_upload_metadata_and_be_absent_before_description(self):
        self.assertIsNone(self.job('upload')['generated_title'])
        self.db.execute("INSERT INTO descriptions VALUES ('2026-01-01 010000 alice',?)", (json.dumps({'title':'Fresh descriptor title'}),))
        self.db.commit()
        self.assertEqual(self.job('upload')['generated_title'], 'Fresh descriptor title')
        self.db.execute("UPDATE descriptions SET output_json='{}'")
        self.db.commit()
        self.assertIsNone(self.job('upload')['generated_title'])

    def test_each_lane_shows_its_own_recording_at_once(self):
        self.db.execute("ALTER TABLE recordings ADD COLUMN lease_expires_at TEXT")
        for name, state, owner in [("2026-01-04 010000 dave", "server_ready", "pipeline-campaign-7-convert"),
                                   ("2026-01-05 010000 erin", "artifact_valid", "pipeline-campaign-7-describe"),
                                   ("2026-01-06 010000 finn", "server_ready", None),
                                   ("2026-01-07 010000 gus", "metadata_ready", None)]:
            self.db.execute("INSERT INTO recordings VALUES (?,'live-a','/data/'||?,'edited',300,?,NULL,?,'2026-11-01T00:00:00Z','2026-11-01T12:00:00Z')",
                            (name, name, state, owner))
        self.db.commit()
        data = self.read(worker_step={"disposition": "stage_completed", "lanes": {"convert": {"disposition": "stage_completed", "reason": None}}})
        self.assertEqual([item["lane"] for item in data["lanes"]], ["convert", "describe", "upload"])
        self.assertEqual({item["lane"]: item["job"]["id"] for item in data["lanes"]},
                         {"convert": "2026-01-04 010000 dave", "describe": "2026-01-05 010000 erin", "upload": "2026-01-01 010000 alice"})
        self.assertEqual({item["lane"]: item["waiting"] for item in data["lanes"]}, {"convert": 1, "describe": 0, "upload": 1})
        self.assertEqual(data["lanes"][0]["step"], {"disposition": "stage_completed", "reason": None})
        self.assertIsNone(data["lanes"][1]["step"])
        self.assertEqual([item["id"] for item in data["queue"]], ["2026-01-06 010000 finn", "2026-01-07 010000 gus"])
        self.assertEqual([item["lane"] for item in data["queue"]], ["convert", "upload"])
        self.assertFalse(data["parallel"])

    def test_an_expired_lease_works_on_nothing_and_a_serial_lease_counts_for_its_stage(self):
        self.db.execute("ALTER TABLE recordings ADD COLUMN lease_expires_at TEXT")
        self.db.execute("INSERT INTO recordings VALUES ('2026-01-04 010000 dave','live-a','/d','edited',300,'remuxed',NULL,'pipeline-campaign-7-convert','2026-11-01T00:00:00Z','2026-10-31T00:00:00Z')")
        self.db.execute("INSERT INTO recordings VALUES ('2026-01-05 010000 erin','live-a','/e','edited',300,'described',NULL,'pipeline-campaign-7','2026-11-01T00:00:00Z','2026-11-01T12:00:00Z')")
        self.db.commit()
        data = self.read()
        self.assertIsNone(self.job("convert", data))
        self.assertEqual(self.job("describe", data)["id"], "2026-01-05 010000 erin")
        self.assertEqual(self.job("describe", data)["stage"], "metadata")

    def test_an_office_upload_is_not_the_home_upload_lane(self):
        self.db.execute("UPDATE upload_attempts SET uplink='office'")
        self.db.execute("UPDATE upload_reservations SET uplink='office' WHERE id='ticket'")
        self.db.commit()
        data = self.read()
        self.assertIsNone(self.job("upload", data))
        self.assertEqual((data["queue"][0]["id"], data["queue"][0]["uplink"]), ("2026-01-01 010000 alice", "office"))
        self.assertEqual(data["lanes"][2]["waiting"], 0)
        self.db.execute("UPDATE upload_attempts SET status='failed'")
        self.db.execute("UPDATE recordings SET state='upload_admitted' WHERE id='2026-01-01 010000 alice'")
        self.db.commit()
        self.assertIsNone(self.job("upload"), "an admission for the office is the office's, before its attempt starts")

    def test_repeated_foreground_snapshots_close_readonly_database_handles(self):
        before = len(os.listdir('/proc/self/fd'))
        for _ in range(12):self.read()
        self.assertLessEqual(len(os.listdir('/proc/self/fd')),before+1)

    def test_real_acknowledgements_drive_percentage_rate_and_staleness(self):
        evidence = [{"stage": "file_transfer_progress", "bytesAcknowledged": 100000000, "checkedAt": "2026-11-01T00:00:00Z"},
                    {"stage": "file_transfer_progress", "bytesAcknowledged": 200000000, "checkedAt": "2026-11-01T00:00:30Z"}]
        self.db.execute("UPDATE upload_attempts SET evidence_json=?", (json.dumps(evidence),))
        self.db.commit()
        progress = self.job("upload")["progress"]
        self.assertEqual(progress["percent"], 20)
        self.assertAlmostEqual(progress["bytes_per_second"], 100000000/30)
        self.assertTrue(progress["fresh"])
        self.assertFalse(transfer_progress({"evidence_json": json.dumps(evidence)},1000000000,
                         datetime(2026,11,1,1,tzinfo=timezone.utc))["fresh"])

    def test_daily_allowance_releases_at_tirane_midnight_and_caps_a_day_at_twice_the_amount(self):
        self.db.row_factory = sqlite3.Row
        control = dict(self.db.execute("SELECT * FROM campaign_control").fetchone())
        # 3 GB billed on Nov 1 (local), 4 GB reserved for November.
        for date, released, today in [("2026-11-10T22:59:59+00:00", 250e9, 0), ("2026-11-10T23:00:00+00:00", 275e9, 0),
                                      ("2026-11-01T12:00:00+00:00", 25e9, 3e9), ("2026-10-31T23:00:00+00:00", 25e9, 3e9)]:
            with self.subTest(date=date):
                budget = upload_budget(self.db, control, datetime.fromisoformat(date))
                self.assertEqual(budget["released"], released)
                self.assertEqual(budget["spent_today"], today)
                self.assertEqual(budget["available"], released - 7e9)
                self.assertEqual(budget["today_room"], 50e9 - today - 4e9)
                self.assertEqual(budget["remaining"], min(released - 7e9, 50e9 - today - 4e9))
                self.assertEqual([u["id"] for u in budget["uplinks"]], ["home"])
        budget = upload_budget(self.db, control, datetime(2026, 11, 24, 10, tzinfo=timezone.utc))
        self.assertEqual((budget["month_total"], budget["next_amount"], budget["next_release"]),
                         (750e9, 25e9, "2026-11-25T00:00:00+01:00"))
        self.db.execute("INSERT INTO bandwidth_events VALUES ('2026-11',9000000000,'2026-11-24T08:00:00Z','office')")
        office = upload_budget(self.db, control, datetime(2026, 11, 24, 10, tzinfo=timezone.utc), [{"id": "office", "daily": 50e9}])["uplinks"][1]
        self.assertEqual((office["id"], office["spent"], office["spent_today"], office["remaining"]), ("office", 9e9, 9e9, 91e9))

    def test_converting_ahead_shows_ready_bytes_against_the_cap_and_held_uploads(self):
        self.assertIsNone(self.read()["ahead"], "no uplink, no converting ahead")
        (self.root / "sites.json").write_text(json.dumps({"sites": [{"id": "live-a"}], "uplink": {
            "id": "office", "dailyBytes": 50000000000, "carrier": {"label": "CARRIER1", "capacityBytes": 230000000000}}}))
        self.db.execute("UPDATE recordings SET state='metadata_ready' WHERE id='2026-01-01 010000 alice'")
        self.db.execute("UPDATE campaign_control SET state='paused', attention_reason='Destination shared session is logged out'")
        self.db.commit()
        data = self.read(worker_step={"disposition": "stage_completed"})
        self.assertEqual(data["ahead"], {"ready_bytes": 1000000000, "limit_bytes": 280000000000,
                                         "uploads_held": "Destination shared session is logged out"})
        self.assertEqual(data["campaign"]["state"], "uploads_held")
        self.assertEqual([u["id"] for u in data["budget"]["uplinks"]], ["home", "office"])
        self.assertEqual(data["carrier"]["id"], "CARRIER1")
        self.assertIsNone(data["carrier"]["location"])
        self.assertEqual((data["carrier"]["on_drive_bytes"], data["carrier"]["files"], data["carrier"]["capacity_bytes"]), (0, 0, 230000000000))
        self.assertEqual(data["office"], {"id": "office", "hold": None, "uploading": None, "progress": None})
        self.db.execute("INSERT INTO uplink_holds VALUES ('office','2026-11-01T06:00:00Z','page timeout',2)")
        self.db.execute("UPDATE upload_attempts SET uplink='office'")
        self.db.commit()
        office = self.read(worker_step={"disposition": "stage_completed"})["office"]
        self.assertEqual((office["hold"]["reason"], office["uploading"]), ("page timeout", "alice"))
        self.assertEqual(data["budget"]["uplinks"][1]["daily"], 50000000000)
        self.db.execute("UPDATE campaign_control SET state='running', attention_reason=NULL")
        self.db.execute("UPDATE recordings SET state='metadata_ready'")
        self.db.execute("UPDATE upload_attempts SET status='failed'")
        self.db.commit()
        data = self.read(worker_step={"disposition": "full_ahead", "uploads": "held: the daily verification failed: x"})
        self.assertEqual(data["campaign"]["state"], "full_ahead")
        self.assertEqual(data["ahead"]["uploads_held"], "the daily verification failed: x")

    def test_history_uses_both_sides_of_tirane_dst_day(self):
        for index,at in [(3,'2026-10-24T22:30:00Z'),(4,'2026-10-25T22:30:00Z')]:
            self.db.execute("INSERT INTO state_events VALUES (?,'fixture','uploading','upload_uncertain','metadata submitted; awaiting verification',?)",(index,at))
        self.db.commit()
        day=next(row for row in self.read()['history'] if row['date']=='2026-10-25')
        self.assertEqual(day['submitted'],2)

    def test_recorded_provider_removal_is_not_an_attention_banner(self):
        self.db.execute("INSERT INTO recordings VALUES ('old-loss','live-a','/unused','edited',60,'blocked','video-host removed video 99 after upload',NULL,'2026-10-01T00:00:00Z')")
        self.db.execute("INSERT INTO provider_removals VALUES ('old-loss','video-host','99','provider removed its copy','2026-10-01T00:00:00Z')")
        self.db.commit()
        data=self.read()
        self.assertEqual(data['health']['historical_removals'],1)
        self.assertEqual(data['health']['attention'],0)
        self.assertEqual(data['health']['alerts'],[])

    def test_manual_pause_is_normal_and_does_not_affect_capture(self):
        (self.root/"pipeline/user-pause.json").write_text('{}')
        self.services["video-pipeline"]["state"]="inactive"
        data=self.read()
        self.assertEqual(data["campaign"]["state"],"user_paused")
        self.assertEqual(data["health"]["attention"],0)

    def test_unknown_service_status_and_stale_wait_messages_do_not_claim_worker_stopped(self):
        self.services["video-pipeline"]["state"]="unknown"
        data=self.read()
        self.assertEqual(data["campaign"]["state"],"status_unavailable")
        self.assertEqual(data["health"]["attention"],0)
        self.services["video-pipeline"]["state"]="active"
        data=self.read(worker_step={"disposition":"upload_quota_wait","reason":"old wait"})
        self.assertEqual(data["campaign"]["state"],"running")

    def test_missing_idle_worker_telemetry_is_unknown_until_the_next_successful_read(self):
        self.db.execute("UPDATE recordings SET state='metadata_ready' WHERE state='uploading'")
        self.db.execute("UPDATE upload_attempts SET status='submitted'")
        self.db.commit()
        before = hashlib.sha256(self.path.read_bytes()).digest()
        self.assertEqual(self.read(worker_step=None)['campaign']['state'], 'status_unavailable')
        data = self.read(worker_step={'disposition':'upload_quota_wait', 'reason':''})
        self.assertEqual(data['campaign']['state'], 'upload_quota_wait')
        self.assertEqual(data['health']['attention'], 0)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).digest(), before)
        self.db.execute("UPDATE campaign_control SET state='paused'")
        self.db.commit()
        self.assertEqual(self.read(worker_step=None)['campaign']['state'], 'paused')

    def test_active_unit_without_a_fresh_heartbeat_is_not_reported_as_running_normally(self):
        self.db.execute("UPDATE worker_heartbeat SET updated_at='2026-10-31T23:00:00Z'")
        self.db.commit()
        data=self.read()
        self.assertEqual(data['campaign']['state'],'worker_unresponsive')
        self.assertEqual(data['health']['alerts'][0]['message'],'The upload worker heartbeat is late')

    def test_sites_destination_and_extra_units_come_from_the_deployment(self):
        from collector import extra_units, secret_names
        self.assertEqual(extra_units("video-x=X files;bad unit=no;video-y"), {"video-x": "X files", "video-y": "video-y"})
        self.assertEqual(secret_names("site_session, bad name,"), ("password", "PHPSESSID", "pkey", "token", "site_session"))
        # The newest check is another destination's: the active one's is what counts.
        self.db.execute("INSERT INTO provider_session_events VALUES (1,'video-host','keepalive',1,'2026-11-01T00:00:00Z')")
        self.db.execute("INSERT INTO provider_session_events VALUES (2,'other-host','keepalive',0,'2026-11-01T00:01:00Z')")
        self.db.commit()
        data = self.read()
        self.assertEqual(data['destination'], 'video-host')
        self.assertEqual(data['sources'], ['live-a', 'live-b', 'live-c'])
        self.assertTrue(data['authentication']['confirmed'])

    def test_a_supervisor_other_than_systemd_reports_the_services(self):
        from collector import supervised_report
        report = self.root / 'services.json'
        self.assertIsNone(supervised_report(''))
        report.write_text(json.dumps({'written_at': 1000, 'services': {
            'video-pipeline': {'state': 'active', 'restarts': 2, 'uptime_seconds': 30}, 'video-auth': {'state': 'activating'}},
            'worker_step': {'disposition': 'idle', 'reason': None}}))
        fresh = supervised_report(str(report), now=1030)
        self.assertEqual(fresh['services']['video-pipeline'], {'state': 'active', 'restarts': 2, 'cpu_percent': None, 'anonymous_bytes': None, 'uptime_seconds': 30})
        self.assertEqual(fresh['services']['video-auth']['state'], 'activating')
        self.assertEqual(fresh['services']['video-xvfb']['state'], 'unknown')
        self.assertEqual(fresh['worker_step'], {'disposition': 'idle', 'reason': ''})
        # Its supervisor is gone: nothing it said holds.
        stale = supervised_report(str(report), now=1100)
        self.assertEqual({row['state'] for row in stale['services'].values()}, {'unknown'})
        self.assertIsNone(stale['worker_step'])
        data = snapshot(self.root, self.downloads, now=self.now, services=fresh['services'], worker_step=fresh['worker_step'])
        self.assertNotEqual(data['campaign']['state'], 'status_unavailable')

    def test_recording_status_exposes_no_signed_urls_or_private_paths(self):
        folder=self.downloads/'live-c/downloaded/.active/2026-11-01 010000 capture';folder.mkdir(parents=True)
        (folder/'playlist.m3u8').write_text('#EXTM3U\n#EXTINF:2,\n1.ts\n')
        (self.root/'live-status.json').write_text(json.dumps({'downloads':[{'alias':'capture','segmentsDirPath':str(folder),
            'masterPlaylistUrl':'https://private.invalid/?secret=must-not-leak','liveUrl':'https://private.invalid/?pkey=must-not-leak'}]}))
        data=self.read();body=json.dumps(data)
        self.assertEqual(data['captures'][0]['provider'],'live-c')
        self.assertEqual(data['captures'][0]['segments'],1)
        for forbidden in ['must-not-leak','masterPlaylistUrl','segmentsDirPath','/private/file.mp4',str(folder)]:
            self.assertNotIn(forbidden,body)

    def test_new_capture_without_a_media_directory_keeps_the_api_available(self):
        folder = self.downloads/'live-c/downloaded/.active/2026-11-03 133300 active'
        folder.mkdir(parents=True)
        (folder/'playlist.m3u8').write_text('#EXTM3U\n#EXTINF:2,\n1.ts\n')
        (self.root/'live-status.json').write_text(json.dumps({'downloads':[
            {'alias':'starting','segmentsDirPath':None},
            {'alias':'active','segmentsDirPath':str(folder)},
        ]}))
        with patch('server.read_services', return_value=({},None)), patch('server.latest_worker_step',return_value=None):
            server=create_server('127.0.0.1',0,self.root,self.downloads,reader=lambda *a,**k:self.read())
            thread=threading.Thread(target=server.serve_forever);thread.start()
            try:
                conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
                conn.request('GET','/api/dashboard');response=conn.getresponse();body=json.loads(response.read());conn.close()
                self.assertEqual(response.status,200)
                self.assertTrue(body['ok']);self.assertTrue(body['snapshot']['fresh'])
                self.assertEqual([r['alias'] for r in body['snapshot']['captures']],['active'])
                self.assertEqual(body['snapshot']['captures'][0]['segments'],1)
            finally:
                server.shutdown();thread.join();server.server_close()


class DashboardHTTPTests(unittest.TestCase):
    def test_private_network_allowlist(self):
        for ip in ['127.0.0.1','192.168.1.8','100.64.0.1','100.127.255.254','::ffff:192.168.1.8']:
            self.assertTrue(allowed_client(ip),ip)
        for ip in ['8.8.8.8','100.128.0.1','not-an-ip']:
            self.assertFalse(allowed_client(ip),ip)

    def test_shared_snapshot_retains_last_good_instead_of_live_zeroes(self):
        calls=[]
        def reader(*args,**kwargs):
            calls.append(1)
            if len(calls)>1:raise OSError('fixture unavailable')
            return {'generated_at':'first','counts':{'verified':123}}
        with patch('server.read_services',return_value=({},None)),patch('server.latest_worker_step',return_value=None):
            cache=Snapshot('/unused','/unused',reader)
            first=cache.get();self.assertEqual(cache.get(),first);self.assertEqual(len(calls),1)
            cache.last_read=0;failed=cache.get()
            self.assertEqual(failed[0],503);self.assertFalse(failed[1]['ok'])
            self.assertEqual(failed[1]['snapshot']['counts']['verified'],123)

    def test_allowlisted_assets_and_read_only_api(self):
        with tempfile.TemporaryDirectory() as folder,patch('server.read_services',return_value=({},None)),patch('server.latest_worker_step',return_value=None):
            server=create_server('127.0.0.1',0,folder,folder,reader=lambda *a,**k:{'value':'abc'*2000})
            thread=threading.Thread(target=server.serve_forever);thread.start()
            try:
                conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
                conn.request('GET','/api/dashboard',headers={'Accept-Encoding':'gzip'})
                response=conn.getresponse();self.assertEqual(response.status,200)
                self.assertEqual(response.getheader('Cache-Control'),'no-store')
                self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
                self.assertEqual(json.loads(gzip.decompress(response.read()))['snapshot']['value'],'abc'*2000)
                conn.request('POST','/api/campaign-resume');r=conn.getresponse();self.assertEqual(r.status,405);r.read()
                conn.request('GET','/../../pipeline/pipeline.sqlite');r=conn.getresponse();self.assertEqual(r.status,404);r.read()
                conn.request('HEAD','/manifest.webmanifest');r=conn.getresponse();self.assertEqual(r.status,200);self.assertEqual(r.read(),b'')
                conn.close()
            finally:
                server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()


class WorkerStepTests(unittest.TestCase):
    def step(self, disposition, lane=None, **extra):
        event = {"event": "campaign-step", "result": {"step": {"disposition": disposition, **extra}}}
        if lane:
            event["lane"] = lane
        return event

    def test_one_serial_loop_is_its_newest_step(self):
        merged = merge_worker_steps([self.step("idle", uploads="nothing ready"), self.step("stage_completed")])
        self.assertEqual((merged["disposition"], merged["uploads"], merged["lanes"]), ("stage_completed", None, {}))
        self.assertIsNone(merge_worker_steps([]))

    def test_lanes_show_a_conversion_wait_and_the_upload_lanes_hold(self):
        merged = merge_worker_steps([
            self.step("full_ahead", "convert", uploads="in the upload lane"),
            self.step("stage_completed", "describe"),
            self.step("idle", "upload", uploads="held: the daily verification failed: x"),
        ])
        self.assertEqual(merged["disposition"], "full_ahead")
        self.assertEqual(merged["uploads"], "held: the daily verification failed: x")
        self.assertEqual({lane: step["disposition"] for lane, step in merged["lanes"].items()},
                         {"convert": "full_ahead", "describe": "stage_completed", "upload": "idle"})

    def test_lanes_without_a_wait_show_the_newest_step(self):
        merged = merge_worker_steps([self.step("stage_completed", "convert"), self.step("upload_completed", "upload")])
        self.assertEqual(merged["disposition"], "upload_completed")

    def test_lanes_carry_their_own_wait_reason(self):
        merged = merge_worker_steps([self.step("resource_wait", "describe", reason="15.2 GiB available, below 16 GiB, at /home/x/y")])
        self.assertEqual(merged["lanes"], {"describe": {"disposition": "resource_wait", "reason": "15.2 GiB available, below 16 GiB, at [local file]"}})

    def test_steps_from_before_a_restart_are_not_the_current_runs(self):
        def entry(run, message):
            return {"_SYSTEMD_INVOCATION_ID": run, "MESSAGE": message if isinstance(message, str) else json.dumps(message)}
        entries = [entry("old", self.step("resource_wait", "convert", reason="interrupted by a service stop")),
                   entry("new", self.step("idle", "upload")), entry("new", "not json"), entry("new", {"event": "carrier-pass"})]
        self.assertEqual([event["lane"] for event in current_run_events(entries)], ["upload"])
        self.assertEqual(current_run_events([entry("old", self.step("idle", "convert")), entry("new", "started")]), [])
        self.assertEqual(current_run_events([]), [])
