#!/usr/bin/env python3
"""Build one app of a registry, signed for a phone or (SIMULATOR=1) unsigned for the simulator:

    python3 scripts/build-app.py live-a-local
    SIMULATOR=1 python3 engine/scripts/build-app.py --registry . <app>

Generates its project (scripts/project.py) and builds the shared VideoApp target in
<registry>/build/app (DerivedData and native), so every app of a registry reuses the compiled
modules; the finished bundle is cloned to <registry>/build/<app>/native/Release-<platform>/.
A signed build uses the team $DEVELOPMENT_TEAM and the device $SIGNING_DEVICE (or
$SIGNING_DESTINATION). On the Mac it enters the workload guard (ios-tools) and the shared signing
lock first. An app with `overrides` is built by that folder's build-provider.py."""
import argparse
import fcntl
import os
import pathlib
import shutil
import subprocess
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from registry import ENGINE, Registry

parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
parser.add_argument('--registry')
parser.add_argument('app')
args = parser.parse_args()
registry = Registry(args.registry)
root = registry.root
if args.app not in registry.apps: raise SystemExit('Supply exactly one app: ' + ', '.join(registry.apps))
key = args.app
config = registry.apps[key]
if config.get('overrides'):
    os.execv(sys.executable, [sys.executable, str(root / config['overrides'] / 'build-provider.py'), key])
guard = pathlib.Path.home() / 'Developer/ios-tools/native/scripts/mac-workload'
if not os.environ.get('IOS_WORKLOAD_ACTIVE') and guard.exists():
    os.execv(sys.executable, [sys.executable, str(guard), 'build', '--timeout', '900', '--',
                              sys.executable, str(pathlib.Path(__file__).resolve()), *sys.argv[1:]])
product = config['product']
shared = root / 'build' / 'app'
project = [sys.executable, str(ENGINE / 'scripts/project.py'), '--registry', str(root), key]

def publish(platform):
    # Clone (APFS copy-on-write) the shared product to the app's own output path.
    built = shared / 'native' / ('Release-' + platform) / (product + '.app')
    app = root / 'build' / key / 'native' / ('Release-' + platform) / (product + '.app')
    app.parent.mkdir(parents=True, exist_ok=True)
    staging = app.with_name(app.name + '.publishing')
    if staging.exists(): shutil.rmtree(staging)
    subprocess.run(['/bin/cp', '-cR', str(built), str(staging)], check=True)
    if app.exists(): shutil.rmtree(app)
    staging.rename(app)

limits = ['-jobs', '2', 'OTHER_SWIFT_FLAGS=$(inherited) -j2 -num-threads 2']
if os.environ.get('SIMULATOR'):
    subprocess.run(project, check=True)
    subprocess.run(['xcodebuild', '-project', str(shared / 'VideoApp.xcodeproj'), '-scheme', 'VideoApp',
        '-derivedDataPath', str(shared / 'DerivedData'), '-configuration', 'Release', '-sdk', 'iphonesimulator',
        '-destination', 'generic/platform=iOS Simulator', *limits, 'SYMROOT=' + str(shared / 'native'), 'CODE_SIGNING_ALLOWED=NO', 'build'],
        cwd=root, check=True)
    publish('iphonesimulator')
    raise SystemExit(0)
lockpath = pathlib.Path.home() / 'Library/Caches/ios-app-refresh/signing.lock'
lockpath.parent.mkdir(parents=True, exist_ok=True)
with lockpath.open('a') as lock:
    inherited = os.environ.get('IOS_REFRESH_LOCK_FD')
    if inherited:
        expected = lockpath.stat(); actual = os.fstat(int(inherited))
        if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino): raise SystemExit('Invalid inherited signing lock')
    else: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    subprocess.run(project, check=True)
    subprocess.run(['xcodebuild', '-project', str(shared / 'VideoApp.xcodeproj'), '-scheme', 'VideoApp',
        '-derivedDataPath', str(shared / 'DerivedData'), '-configuration', 'Release', '-sdk', 'iphoneos',
        '-destination', os.environ.get('SIGNING_DESTINATION') or 'platform=iOS,id=' + os.environ['SIGNING_DEVICE'], '-destination-timeout', '30',
        *limits, 'SYMROOT=' + str(shared / 'native'), 'DEVELOPMENT_TEAM=' + os.environ['DEVELOPMENT_TEAM'],
        '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'build'], cwd=root, check=True)
    publish('iphoneos')
