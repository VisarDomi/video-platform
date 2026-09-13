#!/usr/bin/env python3
"""Linux -> trusted Mac GUI build -> verified, non-destructive device update."""
import argparse,json,pathlib,subprocess,shlex,sys
ROOT=pathlib.Path(__file__).resolve().parents[3]
APP=ROOT/'apps/ios'
MAC='/Users/visar/Developer/stream-viewer/apps/ios'
SSH=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/home/visar/Documents/hackingtosh/validation/macos-known-hosts','visar@192.168.1.198']
DEVICE='00008101-000639912881401E'
TEAM='65U58U86DD'
def remote(code):
    return subprocess.run(SSH+['/usr/bin/python3 -'],input=code,text=True,check=True)
p=argparse.ArgumentParser();p.add_argument('provider', choices=['tango']);p.add_argument('action',choices=['sync','build','status','install','finish']);a=p.parse_args()
config=json.loads((APP/'build/providers.json').read_text())[a.provider]
label='com.visar.stream-viewer-build'
plist='/Users/visar/Library/LaunchAgents/'+label+'.plist'
log=MAC+'/build/'+a.provider+'/xcode.log'
if a.action=='sync':
    # Preserve previous build evidence during incremental synchronization.
    subprocess.run(SSH+['mkdir -p '+shlex.quote(MAC)],check=True)
    subprocess.run(['rsync','-az','--exclude=build/','--exclude=Resources/Web/','-e',shlex.join(SSH[:-1]),str(APP)+'/',SSH[-1]+':'+MAC+'/'],check=True)
    subprocess.run(SSH+['mkdir -p '+shlex.quote(MAC+'/build')],check=True)
    subprocess.run(['rsync','-az','--exclude=native/','--exclude=DerivedData/','--exclude=*.xcodeproj/','--exclude=*-Info.plist','--exclude=Info.plist','--exclude=Login.entitlements','-e',shlex.join(SSH[:-1]),str(APP/'build')+'/',SSH[-1]+':'+MAC+'/build'+'/'],check=True)
elif a.action=='build':
    remote(f'''import plistlib,pathlib,subprocess
path=pathlib.Path({plist!r})
status=subprocess.run(['launchctl','list',{label!r}],capture_output=True,text=True)
if '"PID"' in status.stdout: raise SystemExit('Build is still running')
job={{'Label':{label!r},'ProgramArguments':['/usr/bin/python3','scripts/build-native.py',{a.provider!r}],'WorkingDirectory':{MAC!r},'EnvironmentVariables':{{'DEVELOPMENT_TEAM':{TEAM!r},'SIGNING_DEVICE':{DEVICE!r}}},'RunAtLoad':True,'StandardOutPath':{log!r},'StandardErrorPath':{log!r}}}
subprocess.run(['launchctl','bootout','gui/501',str(path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
path.write_bytes(plistlib.dumps(job))
subprocess.run(['launchctl','bootstrap','gui/501',str(path)],check=True)
''')
elif a.action=='status':
    remote(f'''import subprocess,pathlib
subprocess.run(['launchctl','list',{label!r}])
p=pathlib.Path({log!r})
print('\\n'.join(p.read_text().splitlines()[-14:]) if p.exists() else 'Waiting for log')
''')
elif a.action=='install':
    remote(f'''import subprocess,plistlib,pathlib,datetime,fnmatch,hashlib
status=subprocess.run(['launchctl','list',{label!r}],capture_output=True,text=True)
if '"PID"' in status.stdout or '"LastExitStatus" = 0;' not in status.stdout: raise SystemExit('Wait for the build to finish successfully')
app=pathlib.Path({MAC!r})/'build'/{a.provider!r}/'native/Release-iphoneos'/{(config['name']+'.app')!r}
info=plistlib.loads((app/'Info.plist').read_bytes())
assert info['CFBundleIdentifier']=={config['bundleId']!r}
assert info['CFBundleDisplayName']=={config['name']!r}
assert not any(k.startswith('CFBundleIcon') for k in info)
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
profile=plistlib.loads(subprocess.check_output(['security','cms','-D','-i',str(app/'embedded.mobileprovision')]))
assert profile['TeamIdentifier']==[{TEAM!r}]
assert {DEVICE!r} in profile['ProvisionedDevices']
assert fnmatch.fnmatchcase({(TEAM+'.'+config['bundleId'])!r},profile['Entitlements']['application-identifier'])
entitlements=plistlib.loads(subprocess.check_output(['codesign','-d','--entitlements',':-',str(app)],stderr=subprocess.DEVNULL))
assert entitlements['application-identifier']=={(TEAM+'.'+config['bundleId'])!r}
assert profile['ExpirationDate']>datetime.datetime.utcnow()+datetime.timedelta(days=45)
print('Verified bundle, display name, icon absence, signature, paid team, phone and expiry:',profile['ExpirationDate'],flush=True)
extensions=list((app/'PlugIns').glob('*.appex'))
expected_extensions={config['extensions']!r}
assert len(extensions)==len(expected_extensions)
for extension in extensions:
    einfo=plistlib.loads((extension/'Info.plist').read_bytes())
    suffix=einfo['CFBundleIdentifier'].removeprefix({(config['bundleId']+'.')!r})
    assert suffix in expected_extensions
    expected_extensions.remove(suffix)
    eprofile=plistlib.loads(subprocess.check_output(['security','cms','-D','-i',str(extension/'embedded.mobileprovision')]))
    assert eprofile['TeamIdentifier']==[{TEAM!r}] and {DEVICE!r} in eprofile['ProvisionedDevices']
    ent=plistlib.loads(subprocess.check_output(['codesign','-d','--entitlements',':-',str(extension)],stderr=subprocess.DEVNULL))
    if suffix=='Login': assert ent['keychain-access-groups']==[{(TEAM+'.'+config['bundleId'])!r}]
    if suffix=='Xvid':
        assert einfo['CFBundleDisplayName']=='Xvid'
        source=pathlib.Path({MAC!r})/'build'/{a.provider!r}/'Xvid'
        for name in ['content.js','manifest.json']:
            assert hashlib.sha256((source/name).read_bytes()).digest()==hashlib.sha256((extension/name).read_bytes()).digest()
assert entitlements['keychain-access-groups']==[{(TEAM+'.'+config['bundleId'])!r}]
subprocess.run(['xcrun','devicectl','device','install','app','--device',{DEVICE!r},str(app)],check=True)
subprocess.run(['xcrun','devicectl','device','process','launch','--device',{DEVICE!r},{config['bundleId']!r}],check=True)
''')
else: remote(f'''import subprocess
subprocess.run(['launchctl','bootout','gui/501',{plist!r}],check=True)
''')
