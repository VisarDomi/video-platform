"""Inspect the installed XVideos extension on the paired iPhone through its Mac.

No production-code injection, storage replacement, session export, screenshots,
or media URLs. Optional diagnostic JS can operate the existing page controls.
Run with the Mac's existing gallery-reader-extension/inspector-venv Python.
"""
import argparse
import asyncio
import json
import logging
from pathlib import Path
from urllib.parse import urlparse
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.webinspector import WebinspectorService

SNAPSHOT = """JSON.stringify({
    host:location.hostname,route:location.pathname.startsWith('/video')?'video':location.pathname,
    ready:document.readyState,visible:document.visibilityState,
    boot:window.__streamViewerExtensionBoot,takeoverMs:window.__streamViewerExtensionBoot?.shellAt-window.__streamViewerExtensionBoot?.startedAt,mode:document.compatMode,rows:document.querySelectorAll('.stream-row').length,
    nativeLogin:!!document.querySelector('a.social-login-icon[data-method="signin"],input[type="password"]'),
    error:document.querySelector('.status-error')?.textContent,
    quality:document.querySelector('.playback-status')?.textContent,
    multiple:document.querySelector('.multiple-videos')?.getAttribute('aria-pressed'),
    loading:!!document.querySelector('.viewer-loading'),
    viewport:{width:innerWidth,height:innerHeight,scale:visualViewport?.scale},
    slots:[...document.querySelectorAll('.stream-slot')].map(s=>{const v=s.querySelector('video');return {
        role:s.className,ready:v.readyState,width:v.videoWidth,height:v.videoHeight,
        muted:v.muted,paused:v.paused,time:v.currentTime,duration:Number.isFinite(v.duration)?v.duration:null,
        error:v.error?.code,source:!!v.getAttribute('src')
    }})
})"""

LIST_PROGRESS = """(() => {
    if (!window.__xvPaginationProbe) {
        window.__xvPaginationProbe = { restored: false };
        addEventListener('pageshow', event => { if (event.persisted) window.__xvPaginationProbe.restored = true; });
    }
    const probe = window.__xvPaginationProbe;
    const first = document.querySelector('.stream-row');
    if (first && !probe.first) probe.first = first;
    const state = JSON.parse(sessionStorage.getItem('stream-viewer-state') || 'null');
    return JSON.stringify({
        route: location.pathname.startsWith('/video') ? 'video' : location.pathname,
        rows: document.querySelectorAll('.stream-row').length,
        stored: state?.streams.length, pending: !!state?.nextPage,
        retainedFirstRow: first ? probe.first === first : undefined,
        restored: probe.restored, scrollY,
        playable: !!document.querySelector('.current-scope video[src]'),
        error: !!document.querySelector('.status-error'),
    });
})()"""

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--native', action='store_true')
    parser.add_argument('--inventory', action='store_true')
    parser.add_argument('--cookies', action='store_true', help='Read only authentication cookie flags/expiry, never values')
    parser.add_argument('--page-id', type=int)
    parser.add_argument('--evaluate-file')
    parser.add_argument('--observe-seconds', type=float, default=2)
    parser.add_argument('--sample-list', action='store_true', help='Record changing list counts and cached-node retention')
    parser.add_argument('--open-first-and-back', action='store_true', help='During list sampling, open the first loaded video then use Safari history Back')
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    if args.native:
        from pymobiledevice3.remote.native_tunnel import establish_native_rsd
        lockdown = await establish_native_rsd(serial='00008101-000639912881401E')
    else:
        lockdown = await create_using_usbmux(serial='00008101-000639912881401E')
    inspector = WebinspectorService(lockdown=lockdown)
    try:
        await asyncio.wait_for(inspector.connect(), 15)
        pages = await inspector.get_open_application_pages(timeout=5)
        safari = [p for p in pages if p.application.bundle == 'com.apple.mobilesafari']
        if args.inventory:
            print(json.dumps([{'id':p.page.id_, 'host':urlparse(p.page.web_url).hostname} for p in safari]), flush=True)
            return
        candidates = [p for p in safari if urlparse(p.page.web_url).hostname in ('xvideos.com', 'www.xvideos.com')
                      and (args.page_id is None or p.page.id_ == args.page_id)]
        if len(candidates) != 1:
            raise RuntimeError('Need exactly one XVideos Safari tab; use --inventory and --page-id')
        pair = candidates[0]
        session = await asyncio.wait_for(inspector.inspector_session(pair.application, pair.page), 15)
        await asyncio.wait_for(session.runtime_enable(), 10)
        if args.cookies:
            response = await asyncio.wait_for(session.send_command('Page.getCookies'), 10)
            def metadata(obj):
                if isinstance(obj, dict):
                    if 'cookies' in obj:
                        return [{key: cookie.get(key) for key in ('name', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'session', 'sameSite')}
                                for cookie in obj['cookies'] if cookie.get('name') in ('session_token', 'session_token_auth')]
                    for key, value in obj.items():
                        if key == 'message' and isinstance(value, str):
                            try: value = json.loads(value)
                            except ValueError: continue
                        result = metadata(value)
                        if result is not None: return result
                return None
            print('COOKIE_METADATA', json.dumps(metadata(response)), flush=True)
        print('BEFORE', await asyncio.wait_for(session.runtime_evaluate(SNAPSHOT), 15), flush=True)
        if args.evaluate_file:
            print('ACTION', await asyncio.wait_for(session.runtime_evaluate(Path(args.evaluate_file).read_text()), 15), flush=True)
        if args.sample_list:
            deadline = asyncio.get_running_loop().time() + min(45, max(0, args.observe_seconds))
            last = None
            opened = returned = False
            while asyncio.get_running_loop().time() < deadline:
                sample = await asyncio.wait_for(session.runtime_evaluate(LIST_PROGRESS), 10)
                if sample != last:
                    print('LIST_PROGRESS', sample, flush=True)
                    last = sample
                state = json.loads(sample)
                if args.open_first_and_back and not opened and state['rows'] and state['pending']:
                    await session.runtime_evaluate("window.scrollTo(0, 400); document.querySelector('.stream-row').click()")
                    opened = True
                elif opened and not returned and state['route'] == 'video' and state['playable']:
                    await session.runtime_evaluate('history.back()')
                    returned = True
                await asyncio.sleep(0.15)
        else:
            await asyncio.sleep(min(45, max(0, args.observe_seconds)))
        print('AFTER', await asyncio.wait_for(session.runtime_evaluate(SNAPSHOT), 15), flush=True)
    finally:
        await inspector.close()
        await lockdown.close()

asyncio.run(main())
