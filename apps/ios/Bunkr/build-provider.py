#!/usr/bin/env python3
"""Build exactly one local-provider app, sharing the suite's signing lock."""
import fcntl,json,os,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[1]
registry=json.loads((root/'providers.json').read_text())
if len(sys.argv)!=2 or sys.argv[1] not in registry: raise SystemExit('Supply exactly one provider: '+', '.join(registry))
key=sys.argv[1];product=registry[key]['product']
if key != 'bunkr': raise SystemExit('Bunkr-only build entry point')
# Xcode's -jobs limits targets, but Swift otherwise uses the logical CPU count
# inside each target. Apply this to package targets too, including the decoder.
# Whole-module compilation also avoids repeatedly parsing the shared host in a
# cold frozen checkpoint. Keep release optimization enabled.
swift_flags = '$(inherited) -j2 -num-threads 2'
compiler_settings = ['SWIFT_COMPILATION_MODE=wholemodule',
                     'SWIFT_USE_PARALLEL_WHOLE_MODULE_OPTIMIZATION=NO']
if key == 'bunkr':
    # Keep source lines for backtraces without full variable/type DWARF for the
    # large vendored Swift core. The isolated direct-core build uses this same
    # optimized code path; full debug output exceeded the guarded build window.
    swift_flags += ' -gline-tables-only'
    compiler_settings += ['SWIFT_OPTIMIZATION_LEVEL=-Osize',
                          'GCC_GENERATE_DEBUGGING_SYMBOLS=NO', 'DEBUG_INFORMATION_FORMAT=dwarf',
                          'SWIFT_SERIALIZE_DEBUGGING_OPTIONS=NO']
compiler_settings += ['OTHER_SWIFT_FLAGS='+swift_flags]
if os.environ.get('DECODER_PROBE') == '1':
    assert key == 'bunkr', 'The original-file probe belongs to Bunkr'
    product='OriginalVideoProbe'
if not os.environ.get('IOS_WORKLOAD_ACTIVE'):
    guard=pathlib.Path.home()/'Developer/ios-tools/native/scripts/mac-workload'
    os.execv(sys.executable,[sys.executable,str(guard),'build','--timeout','900','--',sys.executable,str(pathlib.Path(__file__).resolve()),key])
if key == 'bunkr':
    subprocess.run([sys.executable, str(root/'scripts/prepare-vlckit.py')], check=True)
    subprocess.run([sys.executable, str(root/'scripts/prepare-ffmpeg.py')], check=True)
def verify_decoder(platform):
    if key != 'bunkr': return
    app=root/'build'/key/'native'/('Release-'+platform)/(product+'.app')
    binary=app/product
    links=subprocess.check_output(['otool','-L',str(binary)],text=True)
    commands=subprocess.check_output(['otool','-l',str(binary)],text=True)
    assert (app/'Frameworks/VLCKit.framework/VLCKit').is_file(), 'Bunkr decoder framework was not embedded'
    assert '@rpath/VLCKit.framework/VLCKit' in links and '@executable_path/Frameworks' in commands, 'Bunkr decoder has no executable framework loader path'
    subprocess.run([sys.executable, str(root/'scripts/verify-ffmpeg.py'), str(app)], check=True)
# SIMULATOR=1: an unsigned simulator build (build/<key>/native/Release-iphonesimulator), no signing lock.
if os.environ.get('SIMULATOR'):
    subprocess.run([sys.executable,str(root/'scripts/project.py'),key],check=True)
    subprocess.run(['xcodebuild','-project',str(root/'build'/key/(product+'.xcodeproj')),'-scheme',product,
        '-derivedDataPath',str(root/'build'/key/'DerivedData'),'-configuration','Release','-sdk','iphonesimulator',
        '-destination','generic/platform=iOS Simulator','-jobs','2',*compiler_settings,'SYMROOT='+str(root/'build'/key/'native'),'CODE_SIGNING_ALLOWED=NO','build'],cwd=root,check=True)
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
        *compiler_settings,'SYMROOT='+str(root/'build'/key/'native'),'DEVELOPMENT_TEAM='+os.environ['DEVELOPMENT_TEAM'],
        '-allowProvisioningUpdates','-allowProvisioningDeviceRegistration','build'],cwd=root,check=True)
    verify_decoder('iphoneos')
