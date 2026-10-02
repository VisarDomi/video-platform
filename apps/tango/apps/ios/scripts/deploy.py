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
log=MAC+'/build/'+a.provider+'/xcode.log'
if a.action=='sync':
    # Preserve previous build evidence during incremental synchronization.
    subprocess.run(SSH+['mkdir -p '+shlex.quote(MAC)],check=True)
    subprocess.run(['rsync','-az','--exclude=build/','--exclude=Resources/Web/','-e',shlex.join(SSH[:-1]),str(APP)+'/',SSH[-1]+':'+MAC+'/'],check=True)
    subprocess.run(SSH+['mkdir -p '+shlex.quote(MAC+'/build')],check=True)
    subprocess.run(['rsync','-az','--exclude=native/','--exclude=DerivedData/','--exclude=*.xcodeproj/','--exclude=*-Info.plist','--exclude=Info.plist','--exclude=Login.entitlements','-e',shlex.join(SSH[:-1]),str(APP/'build')+'/',SSH[-1]+':'+MAC+'/build'+'/'],check=True)
elif a.action=='build':
    remote(f'''import pathlib,subprocess,json
state=pathlib.Path({MAC!r})/'build'/{a.provider!r}/'build-status.json'
state.write_text(json.dumps({{'running':True,'exit':None}}))
command=['sudo','-n','launchctl','asuser','501','sudo','-n','-H','-u','visar','/usr/bin/env',
         'DEVELOPMENT_TEAM='+{TEAM!r},'SIGNING_DEVICE='+{DEVICE!r},'/usr/bin/caffeinate','-i',
         '/usr/bin/python3',{MAC!r}+'/scripts/build-native.py',{a.provider!r}]
with pathlib.Path({log!r}).open('w') as output:
    result=subprocess.run(command,cwd={MAC!r},stdout=output,stderr=subprocess.STDOUT)
state.write_text(json.dumps({{'running':False,'exit':result.returncode}}))
raise SystemExit(result.returncode)
''')
elif a.action=='status':
    remote(f'''import pathlib,json
p=pathlib.Path({MAC!r})/'build'/{a.provider!r}/'build-status.json'
print(p.read_text() if p.exists() else 'No attached build started')
p=pathlib.Path({log!r})
print('\\n'.join(p.read_text().splitlines()[-14:]) if p.exists() else 'Waiting for log')
''')
elif a.action=='install':
    remote(f'''import subprocess,plistlib,pathlib,datetime,fnmatch,hashlib
state=__import__('json').loads((pathlib.Path({MAC!r})/'build'/{a.provider!r}/'build-status.json').read_text())
if state.get('running') or state.get('exit')!=0: raise SystemExit('Wait for the build to finish successfully')
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
    if suffix!='Login':
        assert einfo['CFBundleDisplayName']==suffix
        source=pathlib.Path({MAC!r})/'build'/{a.provider!r}/suffix
        for name in ['content.js','manifest.json']:
            assert hashlib.sha256((source/name).read_bytes()).digest()==hashlib.sha256((extension/name).read_bytes()).digest()
assert entitlements['keychain-access-groups']==[{(TEAM+'.'+config['bundleId'])!r}]
subprocess.run(['xcrun','devicectl','device','install','app','--device',{DEVICE!r},str(app)],check=True)
subprocess.run(['xcrun','devicectl','device','process','launch','--device',{DEVICE!r},{config['bundleId']!r}],check=True)
''')
else: print('Attached build complete; no temporary background job was created.')
