#!/usr/bin/env python3
"""Guarded simulator regression: static real-viewer/reader fixtures, never video playback."""
import argparse,json,math,subprocess,time,urllib.parse,urllib.request
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--device',required=True);p.add_argument('--baseline',required=True);p.add_argument('--candidate',required=True);p.add_argument('--out',required=True)
a=p.parse_args();out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
tool=str(Path.home()/'Developer/ios-tools/native/scripts/apple-tool');bundle='com.visar.SCLocal.paid'
subprocess.run([str(Path.home()/'Developer/ios-tools/native/scripts/mac-workload'),'assert-simulator','--device',a.device],check=True)
def sim(*args,timeout=45,check=True):
 return subprocess.run([tool,'simctl',*args],check=check,timeout=timeout,capture_output=True,text=True).stdout
def action(name,**params):
 query=urllib.parse.urlencode(dict(name=name,**params))
 with urllib.request.urlopen('http://127.0.0.1:8765/action?'+query,timeout=15) as r:return json.load(r)
def wait(fn,timeout=30):
 end=time.monotonic()+timeout;last=None
 while time.monotonic()<end:
  try:
   last=fn()
   if last:return last
  except (OSError,ValueError):pass
  time.sleep(.1)
 raise RuntimeError('Timed out waiting for zoom fixture: '+str(last))
def shot(name):sim('io',a.device,'screenshot',str(out/(name+'.png')))
def state():return action('zoom-state')
def install(app):
 sim('terminate',a.device,bundle,check=False)
 sim('install',a.device,app,timeout=240)
 sim('launch',a.device,bundle,'-zoom-check')
 wait(lambda:'zoom-layout-check' in action('no-such-action').get('actions',[]))
 action('zoom-orientation',value='portrait');time.sleep(.5)
def video(width,height):
 action('zoom-fixture',kind='video',width=width,height=height)
 time.sleep(.1);return state()
def reader():
 action('zoom-fixture',kind='reader')
 def ready():
  s=state()
  return s if s.get('kind')=='reader' and s.get('state',{}).get('decoded',0)>0 else None
 return wait(ready)
def fitted(s,width,height):
 _,_,vw,vh=s['viewport'];x,y,w,h=s['picture']
 return w<=vw+.5 and h<=vh+.5 and abs(x-(vw-w)/2)<.5 and abs(y-(vh-h)/2)<.5 and abs(w/h-width/height)<.001 and (abs(w-vw)<.5 or abs(h-vh)<.5)
report={}
try:
 install(a.baseline)
 base=video(9,32)
 normal=video(16,9)
 action('zoom-scale',scale=1.2);pinched=state()
 reader();layout=action('zoom-layout-check')
 report['baseline']={'portraitFit':fitted(base,9,32),'before':normal,'pinched':pinched,'readerLayout':layout}
 assert not report['baseline']['portraitFit'],'Baseline did not reproduce width-only clipping'
 assert pinched['surfaces']>normal['surfaces'],'Baseline did not reproduce second player surface'
 assert layout['during']['contentHeight']!=layout['before']['contentHeight'],'Baseline did not reproduce mid-pinch relayout'
 (out/'baseline.json').write_text(json.dumps(report['baseline'],indent=2))
 print('Reproduced baseline clipping, second player surface and mid-pinch reader relayout',flush=True)
 install(a.candidate)
 video(16,9)
 results=[]
 for orientation in ('portrait','landscape'):
  action('zoom-orientation',value=orientation)
  wait(lambda:(s:=state()).get('viewport') and (s['viewport'][2]>s['viewport'][3])==(orientation=='landscape'))
  for width,height in ((16,9),(9,16),(9,32),(1,1)):
   initial=video(width,height);assert fitted(initial,width,height),initial
   surface=initial['surface'];assert initial['surfaces']==1
   action('zoom-trace',start=1)
   action('zoom-scale',scale=2.5,animated=1)
   wait(lambda:abs(state()['scale']-2.5)<.001)
   time.sleep(.15)
   frames=action('zoom-trace')['frames']
   assert len(frames)>1
   assert all(s['surfaces']==1 and s['surface']==surface and s['baseSize']==initial['baseSize'] for s in frames),frames
   assert state()['carouselEnabled'] is False
   shot(orientation+'-'+str(width)+'x'+str(height)+'-zoom')
   action('zoom-scale',scale=1)
   restored=state();assert restored['carouselEnabled'] and fitted(restored,width,height),restored
   shot(orientation+'-'+str(width)+'x'+str(height)+'-fit')
   results.append({'orientation':orientation,'aspect':[width,height],'initial':initial,'frames':frames,'restored':restored})
 report['video']=results
 action('zoom-orientation',value='portrait');time.sleep(.5)
 before=reader();layout=action('zoom-layout-check')
 assert layout['during']['contentHeight']==layout['before']['contentHeight'],layout
 assert layout['during']['pages']==layout['before']['pages']+1,layout
 assert layout['after']['pages']==3 and layout['after']['contentHeight']>layout['before']['contentHeight'],layout
 report['readerLayout']=layout
 before=reader();action('zoom-trace',start=1)
 action('zoom-scale',scale=2.5,animated=1)
 wait(lambda:abs(state()['scale']-2.5)<.001);time.sleep(.25)
 frames=action('zoom-trace')['frames']
 assert len(frames)>1 and all(s['images'] for s in frames),frames
 assert all(s['contentHeight']==before['contentHeight'] for s in frames),frames
 # While UIKit is still animating, at least one original image surface stays attached.
 assert all(set(s['images']) & set(before['images']) for s in frames if 1.01<s['scale']<2.49),frames
 report['readerZoom']={'before':before,'frames':frames,'after':state()};shot('reader-zoom')
 action('zoom-scale',scale=1);time.sleep(.2);shot('reader-restored')
 print('PASS aspect fit, same player layer through zoom, carousel lock, both orientations, stable reader images/geometry and deferred metadata',flush=True)
finally:
 (out/'report.json').write_text(json.dumps(report,indent=2))
 sim('terminate',a.device,bundle,check=False)
