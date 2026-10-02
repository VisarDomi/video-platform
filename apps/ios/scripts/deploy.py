#!/usr/bin/env python3
"""Linux -> trusted Mac GUI build -> verified, non-destructive device update for one local-provider app."""
import argparse,json,pathlib,subprocess,shlex
APP=pathlib.Path(__file__).resolve().parents[1]
MAC='/Users/visar/Developer/video-platform/apps/ios'
SSH=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/home/visar/Documents/hackingtosh/validation/macos-known-hosts','visar@192.168.1.198']
DEVICE='00008101-000639912881401E'
TEAM='65U58U86DD'
registry=json.loads((APP/'providers.json').read_text())
def remote(code):
    return subprocess.run(SSH+['/usr/bin/python3 -'],input=code,text=True,check=True)
p=argparse.ArgumentParser();p.add_argument('provider',choices=sorted(registry))
p.add_argument('action',choices=['sync','test','build','status','install','finish']);a=p.parse_args()
config=registry[a.provider]
log=MAC+'/build/'+a.provider+'/xcode.log'
if a.action=='sync':
    # Sources only; build evidence and DerivedData on the Mac are preserved.
    subprocess.run(SSH+['mkdir -p '+shlex.quote(MAC)],check=True)
    subprocess.run(['rsync','-az','--exclude=build/','--exclude=__pycache__/','-e',shlex.join(SSH[:-1]),str(APP)+'/',SSH[-1]+':'+MAC+'/'],check=True)
elif a.action=='test':
    remote(f'''import subprocess
subprocess.run(['mkdir','-p','build'],cwd={MAC!r},check=True)
subprocess.run(['xcrun','swiftc','-parse-as-library','LocalVideos/Policy.swift','Tests/PolicyTests.swift','-o','build/policy-tests'],cwd={MAC!r},check=True)
subprocess.run(['build/policy-tests'],cwd={MAC!r},check=True)
''')
elif a.action=='build':
    remote(f'''import pathlib,subprocess,json
state=pathlib.Path({MAC!r})/'build'/{a.provider!r}/'build-status.json'
state.parent.mkdir(parents=True,exist_ok=True)
state.write_text(json.dumps({{'running':True,'exit':None}}))
command=['sudo','-n','launchctl','asuser','501','sudo','-n','-H','-u','visar','/usr/bin/env',
         'DEVELOPMENT_TEAM='+{TEAM!r},'SIGNING_DEVICE='+{DEVICE!r},'/usr/bin/caffeinate','-i',
         '/usr/bin/python3',{MAC!r}+'/scripts/build-provider.py',{a.provider!r}]
with pathlib.Path({log!r}).open('w') as output:
    result=subprocess.run(command,cwd={MAC!r},stdout=output,stderr=subprocess.STDOUT)
state.write_text(json.dumps({{'running':False,'exit':result.returncode}}))
raise SystemExit(result.returncode)
''')
elif a.action=='status':
    remote(f'''import pathlib
p=pathlib.Path({MAC!r})/'build'/{a.provider!r}/'build-status.json'
print(p.read_text() if p.exists() else 'No attached build started')
p=pathlib.Path({log!r})
print('\\n'.join(p.read_text().splitlines()[-14:]) if p.exists() else 'Waiting for log')
''')
elif a.action=='install':
    remote(f'''import subprocess,plistlib,pathlib,datetime,fnmatch,json
state=json.loads((pathlib.Path({MAC!r})/'build'/{a.provider!r}/'build-status.json').read_text())
if state.get('running') or state.get('exit')!=0: raise SystemExit('Wait for the build to finish successfully')
app=pathlib.Path({MAC!r})/'build'/{a.provider!r}/'native/Release-iphoneos'/{(config['product']+'.app')!r}
info=plistlib.loads((app/'Info.plist').read_bytes())
assert info['CFBundleIdentifier']=={config['bundleId']!r}
assert info['CFBundleDisplayName']=={config['name']!r}
assert info['LocalVideosURL']=={config['url']!r}
assert not any(k.startswith('CFBundleIcon') for k in info)
assert not (app/'PlugIns').exists()
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
profile=plistlib.loads(subprocess.check_output(['security','cms','-D','-i',str(app/'embedded.mobileprovision')]))
assert profile['TeamIdentifier']==[{TEAM!r}]
assert {DEVICE!r} in profile['ProvisionedDevices']
assert fnmatch.fnmatchcase({(TEAM+'.'+config['bundleId'])!r},profile['Entitlements']['application-identifier'])
entitlements=plistlib.loads(subprocess.check_output(['codesign','-d','--entitlements',':-',str(app)],stderr=subprocess.DEVNULL))
assert entitlements['application-identifier']=={(TEAM+'.'+config['bundleId'])!r}
assert profile['ExpirationDate']>datetime.datetime.utcnow()+datetime.timedelta(days=45)
print('Verified bundle, name, start URL, icon absence, signature, paid team, phone and expiry:',profile['ExpirationDate'],flush=True)
subprocess.run(['xcrun','devicectl','device','install','app','--device',{DEVICE!r},str(app)],check=True)
subprocess.run(['xcrun','devicectl','device','process','launch','--device',{DEVICE!r},{config['bundleId']!r}],check=True)
''')
else: print('Attached build complete; no temporary background job was created.')
