#!/usr/bin/env python3
"""Compare real inline AV1 playback backends in one explicitly guarded simulator."""
from pathlib import Path
import argparse,json,os,plistlib,runpy,shutil,subprocess,time,uuid
def validate_build(app):
 info=plistlib.loads((app/'Info.plist').read_bytes())
 assert info['CFBundleIdentifier']=='com.visar.OriginalVideoProbe.paid' and info.get('InlineCodecPerformanceProbe') and not info.get('InlineCodecQuickProbe'),'Wrong diagnostic build'
 assert info.get('UIApplicationSceneManifest'),'Missing real-app scene lifecycle'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device')
parser.add_argument('--app',type=Path,required=True)
parser.add_argument('--out',type=Path)
parser.add_argument('--validate-build',action='store_true')
parser.add_argument('--fixture',type=Path,default=Path.home()/'.cache/video-ios-fixtures/inline-av1-opus.webm')
args=parser.parse_args();app=args.app
validate_build(app)
if args.validate_build:
 print('PASS performance-probe build identity');raise SystemExit(0)
if not args.device or not args.out:parser.error('Supply the exact simulator UUID and --out')
out=args.out;out.mkdir(parents=True,exist_ok=True)
shared=runpy.run_path(str(Path(__file__).with_name('check-inline-simulator.py')))
assert os.environ.get('IOS_WORKLOAD_ACTIVE')
device=args.device;bundle='com.visar.OriginalVideoProbe.paid';tools=Path.home()/'Developer/ios-tools/native/scripts'
subprocess.run(['/usr/bin/python3',str(tools/'mac-workload'),'assert-simulator','--device',device],check=True)
clip=Path(shared['fixture'](args.fixture,'av1'))
def sim(*args,check=True,timeout=60):return subprocess.run([str(tools/'apple-tool'),'simctl',*map(str,args)],check=check,capture_output=True,text=True,timeout=timeout)
reports=[];success=False
try:
 sim('install',device,app,timeout=240)
 container=Path(sim('get_app_container',device,bundle,'data').stdout.strip())/'Documents';shutil.copy2(clip,container/'performance.webm')
 for index,legacy in enumerate([True,False,False,True]):
  identity=str(uuid.uuid4());log=out/(str(index)+'.stderr.log');log.write_text(''); report=None;shot=False
  sim('launch','--terminate-running-process','--stderr='+str(log),device,bundle,'-probe-run',identity,'-codec','av1',*(['-force-vlc'] if legacy else []))
  deadline=time.monotonic()+90
  while time.monotonic()<deadline:
   try:report=json.loads((container/'inline-performance.json').read_text())
   except (OSError,ValueError):report=None
   if report and report.get('runID')==identity:
    phases=[row.get('phase') for row in report.get('samples',[])]
    if 'paused picture ready' in phases and not shot and index<2:
     sim('io',device,'screenshot',out/('legacy-picture.png' if legacy else 'direct-picture.png'));shot=True
    if report.get('complete'):break
   time.sleep(.1)
  assert report and report.get('runID')==identity and report.get('complete'),'Missing fresh completed benchmark'
  reports.append(report);(out/('run-'+str(index)+'.json')).write_text(json.dumps(report,indent=2))
  assert not report.get('error'),report.get('error')
  assert report.get('retiringDecoders')==0,'Decoder retirement remains'
  rows={v['phase']:v for v in report['samples']};end=rows['playing end'];start=rows['playing start']
  assert end.get('engine')==('VLCKit' if legacy else 'FFmpeg/VideoToolbox'),end
  assert end.get('nativeTime',0)-start.get('nativeTime',0)>4.8,'Playback clock did not sustain the six-second sample'
  assert end.get('displayedVideoFrames',0)-start.get('displayedVideoFrames',0)>=140,'Insufficient displayed video during the six-second sample'
  print(json.dumps({'run':index,'legacy':legacy,'firstPicture':rows['paused picture ready']['wallSeconds'],'playCPU':end['cpuSeconds'],'idleCPU':rows['paused idle']['cpuSeconds'],'peakBytes':end['peakResidentBytes']}),flush=True)
  sim('terminate',device,bundle,check=False)
 success=True
finally:
 (out/'report.json').write_text(json.dumps({'scope':'Same executable, synthetic 720p AV1/Opus, simulator software decoding; balanced backend order, one active stream. No physical-phone performance claim.','runs':reports},indent=2))
 sim('terminate',device,bundle,check=False)
 if success:
  sim('uninstall',device,bundle)
  assert sim('get_app_container',device,bundle,'app',check=False).returncode!=0
