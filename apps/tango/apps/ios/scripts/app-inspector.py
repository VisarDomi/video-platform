#!/usr/bin/env python3
"""Inspect only the installed bundled Stream Viewer app. Use the Mac inspector-venv."""
import argparse, asyncio, base64, json, logging
from pathlib import Path
from pymobiledevice3.remote.native_tunnel import establish_native_rsd
from pymobiledevice3.services.webinspector import WebinspectorService
SNAPSHOT = """JSON.stringify({path:location.pathname,visible:document.visibilityState,diagnostics:window.__viewerDiagnostics,rows:document.querySelectorAll('.stream-row').length,stage:!!document.querySelector('.stream-stage'),loading:!!document.querySelector('.viewer-loading'),status:document.querySelector('.status')?.textContent,video:[...document.querySelectorAll('video')].map(v=>({ready:v.readyState,error:v.error?.code,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,paused:v.paused,muted:v.muted,inline:v.playsInline,host:v.src?new URL(v.src).hostname:null})),scripts:[...document.scripts].map(s=>new URL(s.src).pathname)})"""
async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--evaluate-file');parser.add_argument('--screenshot');parser.add_argument('--seconds',type=float,default=1);parser.add_argument('--host-bundle',action='append',required=True);args=parser.parse_args()
    logging.disable(logging.CRITICAL)
    lockdown=await establish_native_rsd(serial='00008101-000639912881401E')
    inspector=WebinspectorService(lockdown=lockdown)
    try:
        await asyncio.wait_for(inspector.connect(),15)
        pages=await inspector.get_open_application_pages(timeout=4)
        candidates=[p for p in pages if p.application.bundle in args.host_bundle and p.page.web_url.startswith('streamviewer://app/')]
        print('PAGES',json.dumps([{'id':p.page.id_,'url':p.page.web_url} for p in candidates]),flush=True)
        if len(candidates)!=1: raise RuntimeError('Open/unlock Tango; expected one bundled reader page')
        pair=candidates[0];session=await asyncio.wait_for(inspector.inspector_session(pair.application,pair.page),15)
        # No Console/Network payloads: diagnostics must not expose credentials.
        await asyncio.wait_for(session.runtime_enable(),10)
        print('SNAPSHOT',await asyncio.wait_for(session.runtime_evaluate(SNAPSHOT),10),flush=True)
        if args.evaluate_file:
            result=await asyncio.wait_for(session.send_command('Runtime.evaluate',expression=Path(args.evaluate_file).read_text(),returnByValue=True,userGesture=False),10)
            print('EVALUATE',json.dumps(result),flush=True)
        await asyncio.sleep(min(30,max(0,args.seconds)))
        print('AFTER',await asyncio.wait_for(session.runtime_evaluate(SNAPSHOT),10),flush=True)
        if args.screenshot:
            dims=json.loads(await session.runtime_evaluate('JSON.stringify({width:innerWidth,height:innerHeight})'))
            result=await asyncio.wait_for(session.send_command('Page.snapshotRect',x=0,y=0,coordinateSystem='Viewport',**dims),15)
            if result.get('method')=='Target.dispatchMessageFromTarget':result=json.loads(result['params']['message'])
            payload=result.get('result',result)
            if 'dataURL' in payload:Path(args.screenshot).write_bytes(base64.b64decode(payload['dataURL'].split(',',1)[1]));print('SCREENSHOT',args.screenshot,flush=True)
            else:print('SCREENSHOT_UNAVAILABLE',json.dumps(result.get('error',{})))
    finally:
        await inspector.close();await lockdown.close()
asyncio.run(main())
