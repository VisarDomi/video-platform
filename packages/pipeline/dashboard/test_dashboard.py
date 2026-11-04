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

from collector import snapshot, upload_budget, transfer_progress
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
          CREATE TABLE campaign_control(id INTEGER,state TEXT,monthly_upload_limit_bytes INTEGER,resume_at TEXT,attention_reason TEXT);
          CREATE TABLE upload_attempts(id TEXT,recording_id TEXT,phase TEXT,status TEXT,started_at TEXT,evidence_json TEXT,transfer_started INTEGER,reservation_id TEXT,progress_bytes INTEGER,remote_id TEXT);
          CREATE TABLE upload_reservations(id TEXT,calendar_month TEXT,reserved_bytes INTEGER,status TEXT);
          CREATE TABLE upload_confirmations(attempt_id TEXT,recording_id TEXT,confirm_after TEXT,status TEXT);
          CREATE TABLE short_parts(batch_id TEXT,recording_id TEXT,duration_seconds REAL,aspect_ratio REAL);
          CREATE TABLE state_events(id INTEGER,recording_id TEXT,from_state TEXT,to_state TEXT,reason TEXT,created_at TEXT);
          CREATE TABLE bandwidth_events(calendar_month TEXT,transmitted_bytes INTEGER);
          CREATE TABLE provider_session_events(id INTEGER,provider TEXT,kind TEXT,logged_in INTEGER,occurred_at TEXT);
          CREATE TABLE provider_removals(recording_id TEXT,provider TEXT,remote_id TEXT,reason TEXT,removed_at TEXT);
          CREATE TABLE worker_heartbeat(id INTEGER,updated_at TEXT);
          CREATE TABLE manual_pieces(recording_id TEXT,part TEXT,reason TEXT);
          INSERT INTO campaign_control VALUES (1,'running',700000000000,NULL,NULL);
          INSERT INTO worker_heartbeat VALUES (1,'2026-11-01T00:00:00Z');
          INSERT INTO recordings VALUES ('2026-01-01 010000 alice','tango','/unused','edited',600,'uploading',NULL,NULL,'2026-11-01T00:00:00Z');
          INSERT INTO recordings VALUES ('2026-01-02 010000 bob','tango','/unused','edited',500,'upload_verified',NULL,NULL,'2026-11-01T00:00:00Z');
          INSERT INTO recordings VALUES ('2026-01-03 010000 carol','sc','/unused','edited',20,'short_waiting',NULL,NULL,'2026-11-01T00:00:00Z');
          INSERT INTO artifacts VALUES ('2026-01-01 010000 alice','/private/file.mp4',1000000000);
          INSERT INTO upload_attempts VALUES ('attempt','2026-01-01 010000 alice','started','started','2026-10-31T23:00:00Z','[]',1,'ticket',1000000000,NULL);
          INSERT INTO upload_reservations VALUES ('ticket','2026-10',1016777216,'reserved');
          INSERT INTO bandwidth_events VALUES ('2026-11',2000000000),('2026-11',1000000000);
          INSERT INTO upload_reservations VALUES ('other','2026-11',4000000000,'reserved');
          INSERT INTO state_events VALUES (1,'2026-01-02 010000 bob','upload_uncertain','upload_verified','verified','2026-10-31T23:45:00Z');
          INSERT INTO state_events VALUES (2,'legacy-copy','upload_uncertain','upload_verified','verified','2026-10-31T23:50:00Z');
        """)
        self.db.commit()
        self.now = datetime(2026, 11, 1, 0, 1, tzinfo=timezone.utc)
        self.services = {"video-pipeline": {"state": "active"}}

    def read(self, **kwargs):
        return snapshot(self.root, self.downloads, now=self.now, services=self.services, **kwargs)

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
        self.assertEqual(data["active"]["size_bytes"], 1000000000)
        self.assertIsNone(data["active"]["progress"])
        self.assertEqual(data["active"]["reservation_month"], "2026-10")
        self.assertEqual(data["budget"]["reserved"], 4000000000)

    def test_active_job_includes_exact_source_path_and_final_upload_title_only(self):
        source = '/home/visar/Videos/downloads/tango/edited/2026-01-01 010000 alice'
        self.db.execute("UPDATE recordings SET source_path=? WHERE state='uploading'", (source,))
        self.db.execute("INSERT INTO upload_metadata VALUES ('2026-01-01 010000 alice',?)", ('Generated title [2026-01-01 010000 alice]',))
        self.db.execute("INSERT INTO descriptions VALUES ('2026-01-01 010000 alice',?)", (json.dumps({'title':'Earlier descriptor title'}),))
        self.db.commit()
        data = self.read()
        self.assertEqual(data['active']['source_path'], source)
        self.assertEqual(data['active']['generated_title'], 'Generated title [2026-01-01 010000 alice]')
        self.assertNotIn('/private/file.mp4', json.dumps(data))
        self.assertTrue(all('source_path' not in row and 'generated_title' not in row for row in data['queue']))

    def test_active_title_can_appear_before_upload_metadata_and_be_absent_before_description(self):
        self.assertIsNone(self.read()['active']['generated_title'])
        self.db.execute("INSERT INTO descriptions VALUES ('2026-01-01 010000 alice',?)", (json.dumps({'title':'Fresh descriptor title'}),))
        self.db.commit()
        self.assertEqual(self.read()['active']['generated_title'], 'Fresh descriptor title')
        self.db.execute("UPDATE descriptions SET output_json='{}'")
        self.db.commit()
        self.assertIsNone(self.read()['active']['generated_title'])

    def test_repeated_foreground_snapshots_close_readonly_database_handles(self):
        before = len(os.listdir('/proc/self/fd'))
        for _ in range(12):self.read()
        self.assertLessEqual(len(os.listdir('/proc/self/fd')),before+1)

    def test_real_acknowledgements_drive_percentage_rate_and_staleness(self):
        evidence = [{"stage": "file_transfer_progress", "bytesAcknowledged": 100000000, "checkedAt": "2026-11-01T00:00:00Z"},
                    {"stage": "file_transfer_progress", "bytesAcknowledged": 200000000, "checkedAt": "2026-11-01T00:00:30Z"}]
        self.db.execute("UPDATE upload_attempts SET evidence_json=?", (json.dumps(evidence),))
        self.db.commit()
        progress = self.read()["active"]["progress"]
        self.assertEqual(progress["percent"], 20)
        self.assertAlmostEqual(progress["bytes_per_second"], 100000000/30)
        self.assertTrue(progress["fresh"])
        self.assertFalse(transfer_progress({"evidence_json": json.dumps(evidence)},1000000000,
                         datetime(2026,11,1,1,tzinfo=timezone.utc))["fresh"])

    def test_tirane_budget_boundaries_count_failed_bytes_and_outstanding_claims(self):
        self.db.row_factory = sqlite3.Row
        control = dict(self.db.execute("SELECT * FROM campaign_control").fetchone())
        for date, expected in [("2026-11-10T22:59:59+00:00",100e9),("2026-11-10T23:00:00+00:00",300e9),("2026-11-20T23:00:00+00:00",700e9)]:
            with self.subTest(date=date):
                budget=upload_budget(self.db,control,datetime.fromisoformat(date))
                self.assertEqual(budget["released"],expected)
                self.assertEqual(budget["remaining"],expected-7000000000)
        control["monthly_upload_limit_bytes"]=200000000000
        self.assertEqual(upload_budget(self.db,control,datetime(2026,11,25,tzinfo=timezone.utc))["released"],200000000000)

    def test_history_uses_both_sides_of_tirane_dst_day(self):
        for index,at in [(3,'2026-10-24T22:30:00Z'),(4,'2026-10-25T22:30:00Z')]:
            self.db.execute("INSERT INTO state_events VALUES (?,'fixture','uploading','upload_uncertain','metadata submitted; awaiting verification',?)",(index,at))
        self.db.commit()
        day=next(row for row in self.read()['history'] if row['date']=='2026-10-25')
        self.assertEqual(day['submitted'],2)

    def test_acknowledged_provider_history_is_not_an_attention_banner(self):
        self.db.execute("INSERT INTO recordings VALUES ('old-loss','tango','/unused','edited',60,'blocked','porntrex removed video 99 after upload',NULL,'2026-10-01T00:00:00Z')")
        self.db.execute("INSERT INTO provider_removals VALUES ('old-loss','porntrex','99','provider removed its copy','2026-10-01T00:00:00Z')")
        self.db.commit()
        acknowledge_current_removals(self.path,self.root/'babysit/monitoring.json')
        data=self.read()
        self.assertEqual(data['health']['historical_removals'],1)
        self.assertEqual(data['health']['attention'],0)

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
        data=self.read(worker_step={"disposition":"monthly_quota_wait","reason":"old wait"})
        self.assertEqual(data["campaign"]["state"],"running")

    def test_missing_idle_worker_telemetry_is_unknown_until_the_next_successful_read(self):
        self.db.execute("UPDATE recordings SET state='metadata_ready' WHERE state='uploading'")
        self.db.execute("UPDATE upload_attempts SET status='submitted'")
        self.db.commit()
        before = hashlib.sha256(self.path.read_bytes()).digest()
        self.assertEqual(self.read(worker_step=None)['campaign']['state'], 'status_unavailable')
        data = self.read(worker_step={'disposition':'monthly_quota_wait', 'reason':''})
        self.assertEqual(data['campaign']['state'], 'monthly_quota_wait')
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

    def test_recording_status_exposes_no_signed_urls_or_private_paths(self):
        folder=self.downloads/'sc/downloaded/.active/2026-11-01 010000 capture';folder.mkdir(parents=True)
        (folder/'playlist.m3u8').write_text('#EXTM3U\n#EXTINF:2,\n1.ts\n')
        (self.root/'live-status.json').write_text(json.dumps({'downloads':[{'alias':'capture','segmentsDirPath':str(folder),
            'masterPlaylistUrl':'https://private.invalid/?secret=must-not-leak','liveUrl':'https://private.invalid/?pkey=must-not-leak'}]}))
        data=self.read();body=json.dumps(data)
        self.assertEqual(data['captures'][0]['provider'],'sc')
        self.assertEqual(data['captures'][0]['segments'],1)
        for forbidden in ['must-not-leak','masterPlaylistUrl','segmentsDirPath','/private/file.mp4',str(folder)]:
            self.assertNotIn(forbidden,body)

    def test_new_capture_without_a_media_directory_keeps_the_api_available(self):
        folder = self.downloads/'sc/downloaded/.active/2026-11-03 133300 active'
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
