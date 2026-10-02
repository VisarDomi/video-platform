"""Read-only Stream Viewer smoke over the Mac's trusted iPhone Web Inspector.

Navigate Home -> first native stream link -> browser Back. No provider writes,
storage injection, clearing, media URL logging, or replacement application code.
Run with gallery-reader-extension/inspector-venv on the Mac.
"""
import asyncio
import json
import logging
from urllib.parse import urlparse
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.webinspector import WebinspectorService

SNAP="""JSON.stringify({path:location.pathname,history:history.length,boot:window.__streamViewerExtensionBoot,rows:document.querySelectorAll('.stream-row').length,followed:document.querySelectorAll('.stream-row.following').length,currentRows:document.querySelectorAll('.stream-row.current').length,error:document.querySelector('.status-error')?.textContent,width:innerWidth,scale:visualViewport?.scale,loading:!!document.querySelector('.viewer-loading'),slots:[...document.querySelectorAll('.stream-slot')].map(s=>{const v=s.querySelector('video');return {role:s.className,width:v.videoWidth,height:v.videoHeight,ready:v.readyState,muted:v.muted}})})"""

async def main():
    logging.disable(logging.CRITICAL)
    lock=await create_using_usbmux(serial='00008101-000639912881401E')
    inspector=WebinspectorService(lockdown=lock)
    try:
        await asyncio.wait_for(inspector.connect(),15)
        pages=await inspector.get_open_application_pages(timeout=5)
        pages=[p for p in pages if p.application.bundle=='com.apple.mobilesafari' and urlparse(p.page.web_url).hostname in ('tango.me','www.tango.me')]
        if len(pages)!=1: raise RuntimeError('Need exactly one Tango Safari tab')
        p=pages[0]
        s=await asyncio.wait_for(inspector.inspector_session(p.application,p.page),15)
        def message(event):
            text=event['params'].get('message',{}).get('text','')
            if text.startswith('STREAM_BACK '): print(text,flush=True)
        s.response_methods['Console.messageAdded']=message
        await s.console_enable()
        await s.runtime_enable()
        async def run(js):return await asyncio.wait_for(s.runtime_evaluate(js),10)
        print('INITIAL',await run(SNAP),flush=True)
        await run("(()=>{const a=document.createElement('a');a.href='/';document.body.append(a);a.click();a.remove()})()")
        await asyncio.sleep(6)
        home=json.loads(await run(SNAP))
        print('HOME',json.dumps(home),flush=True)
        if not home.get('rows'):raise RuntimeError('No home streams')
        await run("(()=>{const boot=window.__streamViewerExtensionBoot,body=document.body;addEventListener('pageshow',e=>console.log('STREAM_BACK '+JSON.stringify({persisted:e.persisted,sameBoot:boot===window.__streamViewerExtensionBoot,sameBody:body===document.body,rows:document.querySelectorAll('.stream-row').length})),{once:true});})()")
        await run("document.querySelector('a.stream-row').click()")
        await asyncio.sleep(8)
        video=json.loads(await run(SNAP))
        print('STREAM',json.dumps(video),flush=True)
        if video['history']!=home['history']+1:raise RuntimeError('Stream link failed to add one history entry')
        if not video.get('slots'):raise RuntimeError('Missing stream UI')
        await run('history.back()')
        await asyncio.sleep(4)
        back=json.loads(await run(SNAP))
        print('BACK',json.dumps(back),flush=True)
        if not back.get('rows'):raise RuntimeError('Back did not restore Home')
    finally:
        await inspector.close()
        await lock.close()

asyncio.run(main())
