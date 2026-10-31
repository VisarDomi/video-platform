#!/usr/bin/env python3
"""Guarded virtual-iPhone checks: real views, static images, no video decoding or product data."""
import argparse,json,subprocess,time,urllib.parse,urllib.request
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--device',required=True);p.add_argument('--video',required=True);p.add_argument('--manga',required=True);p.add_argument('--out',required=True)
a=p.parse_args();out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
tool=str(Path.home()/'Developer/ios-tools/native/scripts/apple-tool')
subprocess.run([str(Path.home()/'Developer/ios-tools/native/scripts/mac-workload'),'assert-simulator','--device',a.device],check=True)
def sim(*args,timeout=60,check=True):return subprocess.run([tool,'simctl',*args],capture_output=True,text=True,timeout=timeout,check=check).stdout
def action(name,**params):
 with urllib.request.urlopen('http://127.0.0.1:8765/action?'+urllib.parse.urlencode(dict(name=name,**params)),timeout=15) as r:return json.load(r)
def wait(fn,timeout=35):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  try:
   value=fn()
   if value:return value
  except (OSError,ValueError,KeyError):pass
  time.sleep(.12)
 raise AssertionError('Fixture did not become ready')
def state():return action('zoom-state')
def same_position(a,b):
 assert a['key']==b['key'],(a,b)
 assert abs(a['picture'][1]-b['picture'][1])<.5,(a,b)
 assert abs(a['offset']-b['offset'])<.5,(a,b)
def shot(name):sim('io',a.device,'screenshot',str(out/(name+'.png')))
report={};bundles=['com.visar.SCLocal.paid','com.visar.AsuraReader']
try:
 sim('install',a.device,a.video,timeout=240)
 sim('launch',a.device,bundles[0],'-zoom-check')
 wait(lambda:'feed-scroll' in action('unknown').get('actions',[]))
 fits=[]
 for orientation in ('portrait','landscape'):
  action('zoom-fixture',kind='video')
  action('zoom-orientation',value=orientation)
  wait(lambda:((s:=state())['viewport'][2]>s['viewport'][3])==(orientation=='landscape'))
  for width,height in ((16,9),(9,16),(9,32),(1,1)):
   result=action('zoom-fixture',kind='video',width=width,height=height)
   x,y,w,h=result['picture'];_,_,vw,vh=result['viewport']
   assert w<=vw+.5 and h<=vh+.5 and abs(w/h-width/height)<.001,result
   assert abs(x-(vw-w)/2)<.1 and abs(y-(vh-h)/2)<.5,result
   fits.append(result)
 report['aspectFits']=fits
 action('zoom-orientation',value='portrait')
 wait(lambda:((s:=state())['viewport'][2]<s['viewport'][3]))
 action('zoom-fixture',kind='feed');time.sleep(.1)
 scrolls=[]
 for delta in (143,-81,491,1600,4013,-2790,137):
  result=action('feed-scroll',delta=delta)
  same_position(result['before'],result['after'])
  visible=sorted((v['frame'] for v in result['after']['players']),key=lambda r:r[1])
  for first,second in zip(visible,visible[1:]):assert abs(first[1]+first[3]-second[1])<.5,(first,second)
  scrolls.append(result)
 report['freeScroll']=scrolls;shot('video-partial')
 before=state();action('zoom-scale',scale=2.5);during=state()
 assert during['carouselEnabled'] is False
 action('zoom-scale',scale=1);after=state();same_position(before,after)
 assert before['surface']==after['surface'] and after['surfaces']==1
 report['partialZoom']={'before':before,'during':during,'after':after}
 result=action('feed-refresh')
 assert result['before']['name']==result['after']['name'] and result['before']['key']!=result['after']['key'],result
 assert abs(result['before']['picture'][1]-result['after']['picture'][1])<.5,result
 assert result['savedSizes']==30,result
 assert result['posterFrame']==result['after']['viewport'],result
 report['listRefresh']=result
 before=state();action('zoom-fixture',kind='restore');after=state();same_position(before,after)
 report['partialRestoration']={'before':before,'after':after}
 assert after['poster'] is True,after
 shot('video-restored')
 moved=action('feed-scroll',delta=57,end=0)
 assert moved['after']['poster'] is False,moved
 result=action('feed-metadata')
 same_position(result['before'],result['during'])
 action('feed-scroll',delta=0);report['deferredVideoMetadata']=result
 # A real strip may append while a finger/momentum moves it; sizes wait and cannot stop it.
 action('zoom-fixture',kind='reader');wait(lambda:state().get('state',{}).get('decoded',0)>0)
 action('reader-scroll',delta=150,end=0);before=state();during=action('zoom-metadata')
 assert during['pages']==before['pages']+1 and abs(during['offset']-before['offset'])<.5,(before,during)
 after=action('reader-scroll',delta=0,end=1)['after']
 assert abs(after['offset']-before['offset'])<.5,(before,after)
 report['readerAppend']={'before':before,'during':during,'after':after}
 before=state();action('zoom-scale',scale=2.5);action('zoom-scale',scale=1);after=state()
 assert abs(before['offset']-after['offset'])<.5,(before,after)
 report['readerZoom']={'before':before,'after':after};shot('reader-continuous')
 sim('terminate',a.device,bundles[0])
 # Offline manifests and image files: cross every chapter without sending a scroll-end.
 sim('install',a.device,a.manga,timeout=240)
 sim('launch',a.device,bundles[1],'-reader-check')
 wait(lambda:action('reader-check-state').get('ready'))
 wait(lambda:len((s:=action('reader-check-state')).get('reader',{}).get('chapters',[]))>=2 and s['reader']['settledChapter']=='1')
 initial=action('reader-check-state');assert initial['chapterRequests']==0 and initial['cachedPages']==32,initial
 crosses=[]
 for count in range(3,9):
  action('reader-check-bottom',end=0)
  current=wait(lambda:s if len((s:=action('reader-check-state'))['reader']['chapters'])>=count else None)
  assert current['chapterRequests']==0 and current['cachedPages']==32,current
  assert current['reader']['settledChapter']=='1',current
  crosses.append(current)
 report['offlineContinuousChapters']={'initial':initial,'crossings':crosses}
 shot('cached-chapter-eight')
 print('PASS: partial videos stay, fast multi-item scroll, no gaps, same zoom surfaces, refresh anchoring, reader append during motion, and 8 cached chapters without scroll-end or chapter requests',flush=True)
finally:
 (out/'report.json').write_text(json.dumps(report,indent=2))
 for bundle in bundles:sim('terminate',a.device,bundle,check=False)
