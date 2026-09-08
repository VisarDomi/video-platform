"""Observe physical Safari gestures for 45 seconds; never navigate or change data.

Wrap scrollBy transparently to correlate app compensation with scrollend.
Restore it and remove all observers afterward. No stream URLs/media are logged.
"""
import asyncio
import argparse
import json
import logging
from urllib.parse import urlparse
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.webinspector import WebinspectorService

ARM=r"""(()=>{
if(!document.querySelector('.stream-stage'))throw Error('Open a stream first');
window.__svScrollWatch?.stop();
const records=[],listeners=[],original=window.scrollBy;
let touching=false;
const log=(type,extra={})=>{records.push({type,t:Math.round(performance.now()),y:Math.round(scrollY),touching,...extra});if(records.length>800)records.shift();};
const listen=(type,fn)=>{addEventListener(type,fn,{passive:true,capture:true});listeners.push([type,fn]);};
listen('touchstart',e=>{touching=e.touches.length>0;log('touchstart');});
listen('touchend',e=>{touching=e.touches.length>0;log('touchend');});
listen('touchcancel',()=>{touching=false;log('touchcancel');});
listen('scroll',()=>log('scroll'));
listen('scrollend',()=>log('scrollend'));
const wrapped=function(...args){log('scrollBy',{args,stack:new Error().stack?.split('\n').slice(1,5)});return original.apply(this,args);};
window.scrollBy=wrapped;
const stage=document.querySelector('.stream-stage');
const observer=new MutationObserver(()=>log('layout',{stage:stage.className,roles:[...stage.children].map(s=>({role:s.className,top:Math.round(s.getBoundingClientRect().top),height:Math.round(s.getBoundingClientRect().height)}))}));
observer.observe(stage,{attributes:true,attributeFilter:['class','style'],childList:true,subtree:true});
const stop=()=>{if(window.scrollBy===wrapped)window.scrollBy=original;observer.disconnect();for(const [type,fn]of listeners)removeEventListener(type,fn,true);};
window.__svScrollWatch={records,stop};
setTimeout(stop,60000);
return JSON.stringify({armed:true,y:scrollY,history:history.length,extension:window.__streamViewerExtensionBoot,documentMode:document.compatMode,ready:document.readyState,doctype:document.doctype?.name,scrollingElement:document.scrollingElement?.tagName,viewport:{width:innerWidth,height:innerHeight,scale:visualViewport?.scale}});
})()"""

async def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--collect',action='store_true',help='Recover an existing trace after reconnecting, without re-arming')
    args=parser.parse_args()
    logging.disable(logging.CRITICAL)
    lock=await create_using_usbmux(serial='00008101-000639912881401E')
    inspector=WebinspectorService(lockdown=lock)
    s=None
    try:
        await asyncio.wait_for(inspector.connect(),15)
        pages=await inspector.get_open_application_pages(timeout=5)
        pages=[p for p in pages if p.application.bundle=='com.apple.mobilesafari' and urlparse(p.page.web_url).hostname in ('tango.me','www.tango.me')]
        if len(pages)!=1:raise RuntimeError('Need one Tango tab')
        p=pages[0]
        s=await asyncio.wait_for(inspector.inspector_session(p.application,p.page),15)
        await s.runtime_enable()
        if not args.collect:
            for _ in range(15):
                if await s.runtime_evaluate("!!document.querySelector('.stream-stage')"):break
                await asyncio.sleep(1)
            print('ARMED',await asyncio.wait_for(s.runtime_evaluate(ARM),10),flush=True)
            await asyncio.sleep(45)
        print('TRACE',await asyncio.wait_for(s.runtime_evaluate('JSON.stringify(window.__svScrollWatch?.records)'),10),flush=True)
    finally:
        if s:
            try:await asyncio.wait_for(s.runtime_evaluate('window.__svScrollWatch?.stop();delete window.__svScrollWatch'),5)
            except Exception:pass
        await inspector.close()
        await lock.close()

asyncio.run(main())
