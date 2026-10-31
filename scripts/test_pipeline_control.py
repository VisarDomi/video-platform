import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline_control


class PipelineStop(unittest.TestCase):
    def pause(self, home, runner):
        from pipeline_control import pause_upload_pipeline
        with patch('pipeline_control.Path.home', return_value=home), patch('pipeline_control.subprocess.run', runner):
            pause_upload_pipeline()

    def test_stop_has_one_service_target_and_writes_durable_hold_before_stopping(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            commands = []
            def runner(args, **kwargs):
                commands.append(args)
                if 'disable' in args:
                    self.assertEqual(kwargs['timeout'], 1, 'manual stop must not wait on a lingering worker')
                    marker = home / '.local/share/video-services/pipeline/user-pause.json'
                    data = json.loads(marker.read_text())
                    self.assertEqual(data['services'], ['video-pipeline.service'])
                    self.assertTrue(data['requires_explicit_user_resume'])
                    self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
                return subprocess.CompletedProcess(args, 0)
            self.pause(home, runner)
            self.assertEqual(commands[0], ['systemctl', '--user', 'daemon-reload'])
            self.assertEqual(commands[1], ['systemctl', '--user', 'disable', '--now', 'video-pipeline.service'])
            self.assertEqual(commands[-1][-2:], ['campaign-pause', '--apply'])
            override = home / '.config/systemd/user/video-pipeline.service.d/90-user-requested-pause.conf'
            self.assertIn('Restart=no', override.read_text())
            self.assertIn('ConditionPathExists=!', override.read_text())
            self.assertFalse(any(name in ' '.join(cmd) for cmd in commands for name in
                                 ('video-downloader', 'video-server', 'video-auth', 'video-xvfb')))
            # A second manual stop preserves the existing reason/initial timestamp.
            marker = home / '.local/share/video-services/pipeline/user-pause.json'
            first = json.loads(marker.read_text())
            self.pause(home, runner)
            self.assertEqual(json.loads(marker.read_text())['paused_at'], first['paused_at'])

    def test_unresponsive_worker_is_killed_only_in_its_service_cgroup(self):
        with tempfile.TemporaryDirectory() as folder:
            commands = []
            def runner(args, **kwargs):
                commands.append(args)
                if 'disable' in args and sum('disable' in cmd for cmd in commands) == 1:
                    raise subprocess.TimeoutExpired(args, kwargs['timeout'])
                return subprocess.CompletedProcess(args, 0)
            self.pause(Path(folder), runner)
            self.assertIn(['systemctl', '--user', 'kill', '--kill-whom=all', '--signal=SIGKILL',
                           'video-pipeline.service'], commands)
            self.assertEqual(sum('disable' in cmd for cmd in commands), 2)

    def test_stop_failure_is_not_swallowed(self):
        with tempfile.TemporaryDirectory() as folder:
            def runner(args, **kwargs):
                if 'disable' in args:
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, 0)
            with self.assertRaises(subprocess.CalledProcessError):
                self.pause(Path(folder), runner)


class PipelineStart(unittest.TestCase):
    def test_start_clears_only_owned_hold_then_resumes_before_starting_service(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            marker = home / '.local/share/video-services/pipeline/user-pause.json'
            marker.parent.mkdir(parents=True); marker.write_text('{}')
            override = home / '.config/systemd/user/video-pipeline.service.d/90-user-requested-pause.conf'
            override.parent.mkdir(parents=True); override.write_text('# User-requested operational hold.\n')
            calls = []
            def run(args, **kwargs):
                self.assertFalse(marker.exists()); self.assertFalse(override.exists())
                calls.append(args)
                return subprocess.CompletedProcess(args, 0)
            with patch('pipeline_control.Path.home', return_value=home), patch('pipeline_control.subprocess.run', side_effect=run):
                pipeline_control.resume_upload_pipeline()
            self.assertEqual(calls[0], ['systemctl', '--user', 'daemon-reload'])
            self.assertEqual(calls[1][-2:], ['campaign-resume', '--apply'])
            self.assertEqual(calls[2], ['systemctl', '--user', 'enable', '--now', 'video-pipeline.service'])

    def test_start_refuses_foreign_override_without_clearing_the_hold(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            marker = home / '.local/share/video-services/pipeline/user-pause.json'
            marker.parent.mkdir(parents=True); marker.write_text('{}')
            override = home / '.config/systemd/user/video-pipeline.service.d/90-user-requested-pause.conf'
            override.parent.mkdir(parents=True); override.write_text('# unrelated override\n')
            with patch('pipeline_control.Path.home', return_value=home), patch('pipeline_control.subprocess.run') as run:
                with self.assertRaises(RuntimeError): pipeline_control.resume_upload_pipeline()
                run.assert_not_called()
            self.assertTrue(marker.exists()); self.assertTrue(override.exists())


if __name__ == '__main__':
    unittest.main()
