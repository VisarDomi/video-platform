#!/usr/bin/env python3
"""Build exactly one local-provider app, sharing the suite's signing lock."""
import fcntl,json,os,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[1]
registry=json.loads((root/'providers.json').read_text())
if len(sys.argv) > 1 and sys.argv[1] == 'bunkr':
    script = root/'Bunkr/build-provider.py'
    os.execv(sys.executable, [sys.executable, str(script), *sys.argv[1:]])
if len(sys.argv)!=2 or sys.argv[1] not in registry: raise SystemExit('Supply exactly one provider: '+', '.join(registry))
key=sys.argv[1];product=registry[key]['product']
if not os.environ.get('IOS_WORKLOAD_ACTIVE'):
    guard=pathlib.Path.home()/'Developer/ios-tools/native/scripts/mac-workload'
    os.execv(sys.executable,[sys.executable,str(guard),'build','--timeout','900','--',sys.executable,str(pathlib.Path(__file__).resolve()),key])
if key == 'bunkr':
    subprocess.run([sys.executable, str(root/'scripts/prepare-vlckit.py')], check=True)
def verify_decoder(platform):
    if key != 'bunkr': return
    app=root/'build'/key/'native'/('Release-'+platform)/(product+'.app')
    binary=app/product
    links=subprocess.check_output(['otool','-L',str(binary)],text=True)
    commands=subprocess.check_output(['otool','-l',str(binary)],text=True)
    assert (app/'Frameworks/VLCKit.framework/VLCKit').is_file(), 'Bunkr decoder framework was not embedded'
    assert '@rpath/VLCKit.framework/VLCKit' in links and '@executable_path/Frameworks' in commands, 'Bunkr decoder has no executable framework loader path'
# SIMULATOR=1: an unsigned simulator build (build/<key>/native/Release-iphonesimulator), no signing lock.
if os.environ.get('SIMULATOR'):
    subprocess.run([sys.executable,str(root/'scripts/project.py'),key],check=True)
    subprocess.run(['xcodebuild','-project',str(root/'build'/key/(product+'.xcodeproj')),'-scheme',product,
        '-derivedDataPath',str(root/'build'/key/'DerivedData'),'-configuration','Release','-sdk','iphonesimulator',
        '-destination','generic/platform=iOS Simulator','-jobs','2','OTHER_SWIFT_FLAGS=$(inherited) -j2 -num-threads 2','SYMROOT='+str(root/'build'/key/'native'),'CODE_SIGNING_ALLOWED=NO','build'],cwd=root,check=True)
    verify_decoder('iphonesimulator')
    raise SystemExit(0)
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
        '-destination',os.environ.get('SIGNING_DESTINATION') or 'platform=iOS,id='+os.environ['SIGNING_DEVICE'],'-destination-timeout','30','-jobs','2',
        'SYMROOT='+str(root/'build'/key/'native'),'DEVELOPMENT_TEAM='+os.environ['DEVELOPMENT_TEAM'],
        'OTHER_SWIFT_FLAGS=$(inherited) -j2 -num-threads 2','-allowProvisioningUpdates','-allowProvisioningDeviceRegistration','build'],cwd=root,check=True)
    verify_decoder('iphoneos')
