"""The wrong diagnostic variant must be rejected before any simulator boot."""
import os
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import unittest


class ProbeVariant(unittest.TestCase):
    def test_artifact_preflight_needs_no_guest_and_rejects_older_variant(self):
        script = pathlib.Path(__file__).resolve().parents[1] / 'scripts/check-inline-simulator.py'
        environment = {k: v for k, v in os.environ.items() if k != 'IOS_WORKLOAD_ACTIVE'}
        with tempfile.TemporaryDirectory() as folder:
            app = pathlib.Path(folder) / 'OriginalVideoProbe.app'
            app.mkdir()
            info = dict(CFBundleIdentifier='com.visar.OriginalVideoProbe.paid')
            command = [sys.executable, str(script), '--app', str(app), '--validate-build']
            for quick, expected in [(False, 1), (True, 0)]:
                with self.subTest(quick=quick):
                    info['InlineCodecQuickProbe'] = quick
                    info['CFBundleURLTypes'] = [dict(CFBundleURLSchemes=['inline-codec-probe'])]
                    info['UIApplicationSceneManifest'] = dict(UIApplicationSupportsMultipleScenes=False)
                    (app / 'Info.plist').write_bytes(plistlib.dumps(info))
                    result = subprocess.run(command, env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, expected, result.stderr)
