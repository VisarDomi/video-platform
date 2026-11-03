#!/usr/bin/env python3
"""Check the real inline decoder in an explicitly guarded virtual iPhone only."""
import argparse,hashlib,json,os,pathlib,plistlib,shutil,subprocess,time,uuid
BUNDLE='com.visar.OriginalVideoProbe.paid'
FIXTURES={'vp9':'d8d798cd9049d2d5c4eb7a94edce87819113997aab80bf521a00a3b369e5f3f4',
          'av1':'3ccea15a50dde6cad66b9ed6fe31b9d3dd7acb10285eb22257ff8a8c49404fed'}

def validate_build(app):
 info=plistlib.loads((app/'Info.plist').read_bytes())
 assert info['CFBundleIdentifier']==BUNDLE and info.get('InlineCodecQuickProbe'),'Never launch a product or the wrong diagnostic build'
 assert any('inline-codec-probe' in row.get('CFBundleURLSchemes',[]) for row in info.get('CFBundleURLTypes',[])),'Missing simulator return URL'
 assert info.get('UIApplicationSceneManifest'),'Missing real-app scene lifecycle'

def fixture(path,codec='vp9'):
 path.parent.mkdir(parents=True,exist_ok=True)
 if not path.exists():
  source=pathlib.Path(__file__).resolve().parents[1]/('Tests/Fixtures/inline-'+codec+'-opus.webm')
  shutil.copy2(source,path)
 assert hashlib.sha256(path.read_bytes()).hexdigest()==FIXTURES[codec],codec+'/Opus fixture changed'
 return path

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--device')
 parser.add_argument('--app',type=pathlib.Path)
 parser.add_argument('--out',type=pathlib.Path)
 parser.add_argument('--codec',choices=sorted(FIXTURES),default='vp9')
 parser.add_argument('--fixture',type=pathlib.Path)
 parser.add_argument('--prepare-fixture',action='store_true')
 parser.add_argument('--validate-build',action='store_true',help='Check the diagnostic variant before booting a guest')
 parser.add_argument('--cleanup',action='store_true',help='Remove only this diagnostic app after its testing session')
 args=parser.parse_args()
 if args.fixture is None:args.fixture=pathlib.Path.home()/('.cache/video-ios-fixtures/inline-'+args.codec+'-opus.webm')
 if args.prepare_fixture:
  print(fixture(args.fixture,args.codec));return
 if args.validate_build:
  if not args.app:parser.error('--validate-build requires --app')
  validate_build(args.app);print('PASS quick-probe build identity');return
 if not args.device or (not args.cleanup and (not args.app or not args.out)):
  parser.error('Supply the exact simulator UUID, --app and --out')
 assert os.environ.get('IOS_WORKLOAD_ACTIVE'),'Run inside mac-workload simulator'
 tools=pathlib.Path.home()/'Developer/ios-tools/native/scripts'
 subprocess.run(['/usr/bin/python3',str(tools/'mac-workload'),'assert-simulator','--device',args.device],check=True)
 def sim(*arguments,timeout=60,check=True):
  return subprocess.run([str(tools/'apple-tool'),'simctl',*map(str,arguments)],capture_output=True,text=True,timeout=timeout,check=check)
 if args.cleanup:
  sim('terminate',args.device,BUNDLE,check=False)
  sim('uninstall',args.device,BUNDLE,check=False)
  assert sim('get_app_container',args.device,BUNDLE,'app',check=False).returncode!=0,'Diagnostic app remains installed'
  return
 validate_build(args.app)
 fixture(args.fixture,args.codec)
 args.out.mkdir(parents=True,exist_ok=True)
 for name in ['runtime.stdout.log','runtime.stderr.log']:(args.out/name).write_text('')
 sim('install',args.device,args.app,timeout=240)
 container=pathlib.Path(sim('get_app_container',args.device,BUNDLE,'data').stdout.strip())
 shutil.copy2(args.fixture,container/('Documents/inline-'+args.codec+'-opus.webm'))
 identity=str(uuid.uuid4());report=None;background=False;foreground=False;captured=False;warm_returned=False;warm_captured=False;picture_captured=False;fallback_captured=False
 try:
  result=sim('launch','--terminate-running-process','--stdout='+str(args.out/'runtime.stdout.log'),
             '--stderr='+str(args.out/'runtime.stderr.log'),args.device,BUNDLE,'-probe-run',identity,
             *(['-av1-check'] if args.codec=='av1' else []))
  (args.out/'launch.txt').write_text(result.stdout+result.stderr)
  deadline=time.monotonic()+270
  while time.monotonic()<deadline:
   path=container/'Documents/inline-quick.json'
   if path.exists():
    try: candidate=json.loads(path.read_text())
    except (OSError,ValueError): candidate={}
    if candidate.get('runID')==identity:
     report=candidate
     if report.get('complete'):break
     phases={row.get('phase') for row in report.get('samples',[])}
     if 'await picture capture' in phases and not picture_captured:
      sim('io',args.device,'screenshot',args.out/'paused-picture.png')
      (container/'Documents'/('picture-'+identity+'.ready')).write_text('captured')
      picture_captured=True
     if 'fallback await picture capture' in phases and not fallback_captured:
      sim('io',args.device,'screenshot',args.out/'fallback-picture.png')
      (container/'Documents'/('fallback-'+identity+'.ready')).write_text('captured')
      fallback_captured=True
     if 'warm Settings accepted' in phases and not warm_captured:
      sim('io',args.device,'screenshot',args.out/'settings-warmup.png',check=False)
      warm_captured=True
     if 'await warm foreground' in phases and not warm_returned:
      activated=sim('launch',args.device,BUNDLE)
      (args.out/'warm-return.txt').write_text(activated.stdout+activated.stderr)
      sim('io',args.device,'screenshot',args.out/'warm-return.png',check=False)
      warm_returned=True
     if 'settings opening accepted' in phases and not captured:
      sim('io',args.device,'screenshot',args.out/'settings-transition.png',check=False)
      captured=True
     if 'background entered' in phases:background=True
     if 'await foreground' in phases and not foreground:
      sim('launch',args.device,BUNDLE)
      foreground=True
   time.sleep(.1)
  assert report and report.get('runID')==identity,'No fresh native report'
  (args.out/'quick.json').write_text(json.dumps(report,indent=2))
  assert report.get('complete') and not report.get('error'),report.get('error','Incomplete check')
  assert background and foreground,'Missing actual simulator background/foreground cycle'
  assert not any(row.get('endedBeforePlayout') for row in report['samples']),'EOF published before queued tail played'
  empty_phases={'retirement complete','failed','superseded source cancelled','superseded decoder closed',
                'prewarm Settings','warm Settings accepted','warm Settings refused','warm background entered',
                'await warm foreground','warm foreground entered','fallback retirement complete'}
  for row in report['samples']:
   if row.get('phase') in empty_phases:continue
   expected='VLCKit' if row.get('phase','').startswith('fallback ') else 'FFmpeg/VideoToolbox'
   assert row.get('engine')==expected,'Unexpected decoder in '+str(row.get('phase'))
  print('PASS paused picture/seek, audio-only background/foreground, saved restoration, stopped EOF/replay, bounded UI teardown and legacy fallback')
 finally:
  if report and report.get('error'):
   sim('io',args.device,'screenshot',args.out/'failed-state.png',check=False)
  sim('terminate',args.device,BUNDLE,check=False)
if __name__=='__main__':main()
