#!/usr/bin/env python3
"""Build one app for a phone, signed: scripts/build-app.py live-a-local

Generates its project (scripts/project.py, with apps.local.json's settings) and builds it for
iOS with automatic signing in the team $DEVELOPMENT_TEAM, for the device $SIGNING_DEVICE (or
$SIGNING_DESTINATION), into build/<app>/native/Release-iphoneos/<product>.app. This is the build
command a signing service runs (scripts/renewal.py declares it, with these inputs); on the Mac
it runs inside the workload guard like any other build.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
registry = json.loads((root / 'apps.json').read_text())
if len(sys.argv) != 2 or sys.argv[1] not in registry:
    raise SystemExit('Supply exactly one app: ' + ', '.join(registry))
key = sys.argv[1]
build = root / 'build' / key
subprocess.run([sys.executable, str(root / 'scripts/project.py'), key], cwd=root, check=True)
destination = os.environ.get('SIGNING_DESTINATION') or 'platform=iOS,id=' + os.environ['SIGNING_DEVICE']
subprocess.run(['xcodebuild', '-project', str(root / 'build/app/VideoApp.xcodeproj'), '-scheme', 'VideoApp',
                '-derivedDataPath', str(build / 'DerivedData'), '-configuration', 'Release', '-sdk', 'iphoneos',
                '-destination', destination, '-destination-timeout', '30', '-jobs', '2',
                'SYMROOT=' + str(build / 'native'), 'DEVELOPMENT_TEAM=' + os.environ['DEVELOPMENT_TEAM'],
                'OTHER_SWIFT_FLAGS=$(inherited) -j2 -num-threads 2',
                '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'build'], cwd=root, check=True)
