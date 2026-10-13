#!/usr/bin/env python3
"""Linux -> trusted Mac GUI build -> verified, non-destructive device update for one provider app."""
import argparse,json,pathlib,shutil,subprocess,shlex
APP=pathlib.Path(__file__).resolve().parents[1]
ROOT=APP.parents[1]
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
# Approves the installed build as its renewal baseline only if it is exactly what was built (ios-tools renewal).
# Renewal names local apps <provider>-local (see renewal.py).
deliver=lambda step:['/usr/bin/python3','/Users/visar/Developer/ios-tools/renewal/scripts/deliver.py',step,'--repo','video-platform',
                     '--app',a.provider if config.get('hosts') else a.provider+'-local','--bundle',config['bundleId']]
if a.action=='sync':
    # Tango's PC login shortcut: the server's phone key (made once, private) goes into the build.
    if config.get('native')=='tango':
        import os,secrets
        key=pathlib.Path.home()/'.local/share/video-services/tango-phone-key'
        if not key.exists():
            key.parent.mkdir(parents=True,exist_ok=True)
            with os.fdopen(os.open(key,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out: out.write(secrets.token_hex(32)+'\n')
        private=APP/'Private';private.mkdir(exist_ok=True)
        (private/'tango-phone-key').write_text(key.read_text())
        os.chmod(private/'tango-phone-key',0o600)
    # Hosted Safari web extensions (Tango's FC2 live and SC live) are built here, so the Mac (and
    # monthly renewal) needs no Node or Video Platform checkout.
    for suffix,extension in config.get('webExtensions',{}).items():
        subprocess.run(['node',str(ROOT/'packages/live-extensions/scripts/build.mjs'),extension['source']],cwd=ROOT,check=True)
        target=APP/'build'/a.provider/suffix
        target.mkdir(parents=True,exist_ok=True)
        for name in ['manifest.json','content.js','background.js']: shutil.copyfile(ROOT/'dist/extension'/extension['source']/name,target/name)
    # Sources only; build evidence and DerivedData on the Mac are preserved.
    subprocess.run(SSH+['mkdir -p '+shlex.quote(MAC+'/build/'+a.provider)],check=True)
    subprocess.run(['rsync','-az','--delete','--exclude=build/','--exclude=__pycache__/','-e',shlex.join(SSH[:-1]),str(APP)+'/',SSH[-1]+':'+MAC+'/'],check=True)
    for suffix in config.get('webExtensions',{}):
        subprocess.run(['rsync','-az','--delete','-e',shlex.join(SSH[:-1]),str(APP/'build'/a.provider/suffix)+'/',SSH[-1]+':'+MAC+'/build/'+a.provider+'/'+suffix+'/'],check=True)
elif a.action=='test':
    subprocess.run(SSH+['/bin/bash '+shlex.quote(MAC+'/scripts/test.sh')],check=True)
elif a.action=='build':
    subprocess.run(SSH+[shlex.join(deliver('begin'))],check=True)
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
    subprocess.run(SSH+[shlex.join(deliver('built'))],check=True)
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
assert info['StartURL']=={config['url']!r}
assert info.get('SiteHosts') is None
assert info.get('NativeList')=={config.get('native')!r}
assert bool(info.get('TangoPhoneKey'))=={config.get('native')=='tango'!r}, 'The PC login key is built into Tango'
assert not any(k.startswith('CFBundleIcon') for k in info)
extensions=sorted(p.name for p in (app/'PlugIns').glob('*.appex')) if (app/'PlugIns').exists() else []
assert extensions==sorted({config['product']!r}+suffix+'.appex' for suffix in {config.get('extensions',[])!r}), extensions
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
profile=plistlib.loads(subprocess.check_output(['security','cms','-D','-i',str(app/'embedded.mobileprovision')]))
assert profile['TeamIdentifier']==[{TEAM!r}]
assert {DEVICE!r} in profile['ProvisionedDevices']
assert fnmatch.fnmatchcase({(TEAM+'.'+config['bundleId'])!r},profile['Entitlements']['application-identifier'])
entitlements=plistlib.loads(subprocess.check_output(['codesign','-d','--entitlements',':-',str(app)],stderr=subprocess.DEVNULL))
assert entitlements['application-identifier']=={(TEAM+'.'+config['bundleId'])!r}
if {bool(config.get('tangoLogin'))!r}:
    group=[{(TEAM+'.'+config['bundleId'])!r}]
    assert entitlements['keychain-access-groups']==group
    login=app/'PlugIns'/{(config['product']+'Login.appex')!r}
    assert plistlib.loads((login/'Info.plist').read_bytes())['CFBundleIdentifier']=={(config['bundleId']+'.Login')!r}
    assert plistlib.loads(subprocess.check_output(['codesign','-d','--entitlements',':-',str(login)],stderr=subprocess.DEVNULL))['keychain-access-groups']==group
assert profile['ExpirationDate']>datetime.datetime.utcnow()+datetime.timedelta(days=45)
for suffix,extension in {config.get('webExtensions',{})!r}.items():
    appex=app/'PlugIns'/({config['product']!r}+suffix+'.appex')
    assert plistlib.loads((appex/'Info.plist').read_bytes())['CFBundleDisplayName']==extension['name']
    for name in ['manifest.json','content.js','background.js']:
        assert (appex/name).read_bytes()==(pathlib.Path({MAC!r})/'build'/{a.provider!r}/suffix/name).read_bytes(), suffix+' '+name
print('Verified bundle, name, start URL, site scope, icon absence, signature, paid team, phone and expiry:',profile['ExpirationDate'],flush=True)
# phone-install (ios-tools): devicectl when the Mac reaches the phone, else an over-the-air
# link on the tailnet (exit 10: installed once the owner taps Install on the phone).
installed=subprocess.run(['/Users/visar/Developer/ios-tools/native/scripts/phone-install','--device',{DEVICE!r},str(app)]).returncode
if installed not in (0,10): raise SystemExit(installed)
subprocess.run({deliver('installed')!r},check=True)
if installed==0: subprocess.run(['xcrun','devicectl','device','process','launch','--device',{DEVICE!r},{config['bundleId']!r}],check=True)
''')
else: print('Attached build complete; no temporary background job was created.')
