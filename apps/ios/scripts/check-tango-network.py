#!/usr/bin/env python3
"""Guarded real UIKit list/login regression with synthetic HTTP; never plays video."""
import argparse,json,subprocess,time,urllib.parse,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--device',required=True);p.add_argument('--app',required=True);p.add_argument('--out',required=True);a=p.parse_args()
out=Path(a.out);out.mkdir(parents=True,exist_ok=True);tool=str(Path.home()/'Developer/ios-tools/native/scripts/apple-tool');bundle='com.visar.Tango.paid'
subprocess.run([str(Path.home()/'Developer/ios-tools/native/scripts/mac-workload'),'assert-simulator','--device',a.device],check=True)
def sim(*args,timeout=45,check=True):return subprocess.run([tool,'simctl',*args],timeout=timeout,check=check,capture_output=True,text=True)
def hook(path,**query):
 url='http://127.0.0.1:8765/'+path+('?' + urllib.parse.urlencode(query) if query else '')
 with urllib.request.urlopen(url,timeout=10) as r:return json.load(r)
def action(name,**query):return hook('action',name=name,**query)
def state():return hook('state').get('tango',{})
def wait(condition,seconds=25):
 end=time.monotonic()+seconds;last={}
 while time.monotonic()<end:
  try:
   last=state()
   if condition(last):return last
  except (OSError,ValueError):pass
  time.sleep(.1)
 raise RuntimeError('Tango UI did not settle: '+str(last))
def shot(name):sim('io',a.device,'screenshot',str(out/(name+'.png')))
report={}
try:
 sim('install',a.device,a.app,timeout=240);sim('terminate',a.device,bundle,check=False);sim('launch',a.device,bundle,'-tango-network-check')
 end=time.monotonic()+30
 while True:
  try:
   action('tango-fixture',mode='outage');break
  except (OSError,ValueError):
   if time.monotonic()>end:raise
   time.sleep(.2)
 report['outage']=wait(lambda s:bool(s.get('lastError')) and s.get('retryPending'))
 assert report['outage']['signedIn'] and not report['outage']['login']
 assert action('tango-fixture-counts')['recoveries']==0
 action('tango-network',mode='success')
 report['networkRecovery']=wait(lambda s:s.get('streams')==1 and not s.get('lastError') and not s.get('loading'))
 assert report['networkRecovery']['lastSuccess']>0;shot('network-recovered')
 action('tango-network',mode='outage');wait(lambda s:bool(s.get('lastError')))
 action('tango-resume')
 report['foregroundRecovery']=wait(lambda s:s.get('streams')==1 and not s.get('lastError') and not s.get('loading'))
 action('tango-fixture',mode='refresh-outage');wait(lambda s:bool(s.get('lastError')))
 action('tango-network',mode='challenge')
 report['refreshReconnect']=wait(lambda s:s.get('streams')==1 and not s.get('lastError') and not s.get('loading'))
 assert action('tango-fixture-counts')['recoveries']==1
 action('tango-fixture',mode='challenge')
 report['challengeRecovery']=wait(lambda s:s.get('streams')==1 and not s.get('lastError') and not s.get('loading'))
 report['challengeCounts']=action('tango-fixture-counts');assert report['challengeCounts']['recoveries']==1
 assert not report['challengeRecovery']['login'];shot('challenge-recovered')
 action('tango-fixture',mode='challenge-no-broker')
 report['verification']=wait(lambda s:s.get('login') and 'verification' in s.get('lastError',''))
 assert report['verification']['signedIn'];shot('verification-required')
 (out/'report.json').write_text(json.dumps(report,indent=2))
 print('PASS native Tango: outage preserves login, network/foreground recover immediately, challenge has one recovery, explicit verification fallback',flush=True)
finally:
 (out/'report-partial.json').write_text(json.dumps(report,indent=2));sim('terminate',a.device,bundle,check=False)
