#!/usr/bin/env python3
"""Build exactly one local-provider app, sharing the suite's signing lock."""
import fcntl,json,os,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[1]
registry=json.loads((root/'providers.json').read_text())
if len(sys.argv)!=2 or sys.argv[1] not in registry: raise SystemExit('Supply exactly one provider: '+', '.join(registry))
key=sys.argv[1];product=registry[key]['product']
lockpath=pathlib.Path.home()/'Library/Caches/ios-app-refresh/signing.lock'
lockpath.parent.mkdir(parents=True,exist_ok=True)
with lockpath.open('a') as lock:
    inherited=os.environ.get('IOS_REFRESH_LOCK_FD')
    if inherited:
        expected=lockpath.stat();actual=os.fstat(int(inherited))
        if (actual.st_dev,actual.st_ino)!=(expected.st_dev,expected.st_ino): raise SystemExit('Invalid inherited signing lock')
    else: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    subprocess.run([sys.executable,str(root/'scripts/project.py'),key],check=True)
    subprocess.run(['xcodebuild','-project',str(root/'build'/key/(product+'.xcodeproj')),
        '-scheme',product,'-derivedDataPath',str(root/'build'/key/'DerivedData'),'-configuration','Release','-sdk','iphoneos',
        '-destination','platform=iOS,id='+os.environ['SIGNING_DEVICE'],'-destination-timeout','30',
        'SYMROOT='+str(root/'build'/key/'native'),'DEVELOPMENT_TEAM='+os.environ['DEVELOPMENT_TEAM'],
        '-allowProvisioningUpdates','-allowProvisioningDeviceRegistration','build'],cwd=root,check=True)
