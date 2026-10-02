#!/usr/bin/env python3
"""Build one prepared provider using the suite signing lock."""
import fcntl,json,os,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[1]
registry=json.loads((root/'build/providers.json').read_text())
if len(sys.argv)!=2 or sys.argv[1] not in registry: raise SystemExit('One supported provider is required')
key=sys.argv[1];config=registry[key]
lockpath=pathlib.Path.home()/'Library/Caches/ios-app-refresh/signing.lock'
lockpath.parent.mkdir(parents=True,exist_ok=True)
with lockpath.open('a') as lock:
    inherited=os.environ.get('IOS_REFRESH_LOCK_FD')
    if inherited:
        expected=lockpath.stat();actual=os.fstat(int(inherited))
        if (actual.st_dev,actual.st_ino)!=(expected.st_dev,expected.st_ino): raise SystemExit('Invalid inherited signing lock')
    else: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    subprocess.run([sys.executable,str(root/'scripts/project.py'),key],check=True)
    subprocess.run(['xcodebuild','-project',str(root/'build'/key/(config['name']+'.xcodeproj')),
        '-scheme',config['name'],'-derivedDataPath',str(root/'build'/key/'DerivedData'),'-configuration','Release','-sdk','iphoneos',
        '-destination','platform=iOS,id='+os.environ['SIGNING_DEVICE'],'-destination-timeout','30',
        'SYMROOT='+str(root/'build'/key/'native'),'DEVELOPMENT_TEAM='+os.environ['DEVELOPMENT_TEAM'],
        '-allowProvisioningUpdates','-allowProvisioningDeviceRegistration','build'],cwd=root,check=True)
