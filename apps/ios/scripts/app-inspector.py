"""Inspect a local-provider app's WebKit page on the paired iPhone through the Mac.

Run on the Mac with the existing gallery-reader-extension/inspector-venv Python:
  app-inspector.py --bundle com.visar.FC2Local.paid [--evaluate-file probe.js]
Prints page/list/video status and selected cookie flags only; never values, storage contents or media URLs.
"""
import argparse, asyncio, json, logging
from pathlib import Path
from urllib.parse import urlparse
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.webinspector import WebinspectorService

SNAPSHOT = """JSON.stringify({
    path: location.pathname, ready: document.readyState, title: document.title,
    rows: document.querySelectorAll('a.video-row').length, error: document.querySelector('.status-error')?.textContent ?? null,
    history: history.length, scrollY,
    video: (() => { const v = document.querySelector('.current-scope video'); return v ? { ready: v.readyState, width: v.videoWidth,
        height: v.videoHeight, time: v.currentTime, paused: v.paused, error: v.error?.code ?? null } : null; })()
})"""

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--evaluate-file')
    parser.add_argument('--cookies', nargs='+', metavar='NAME', help='Print only these cookies\' flags and expiry, never values')
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    lockdown = await create_using_usbmux(serial='00008101-000639912881401E')
    inspector = WebinspectorService(lockdown=lockdown)
    try:
        await asyncio.wait_for(inspector.connect(), 15)
        pages = [p for p in await inspector.get_open_application_pages(timeout=5) if p.application.bundle == args.bundle]
        if len(pages) != 1:
            print('PAGES', json.dumps([urlparse(p.page.web_url).path for p in pages]))
            raise SystemExit(f'Need exactly one inspectable page in {args.bundle}; is the app in the foreground?')
        session = await asyncio.wait_for(inspector.inspector_session(pages[0].application, pages[0].page), 15)
        await asyncio.wait_for(session.runtime_enable(), 10)
        print('PAGE', urlparse(pages[0].page.web_url)._replace(query='').geturl(), flush=True)
        print('SNAPSHOT', await asyncio.wait_for(session.runtime_evaluate(SNAPSHOT), 15), flush=True)
        if args.cookies:
            response = await asyncio.wait_for(session.send_command('Page.getCookies'), 10)
            def find(obj):
                if isinstance(obj, dict):
                    if 'cookies' in obj: return obj['cookies']
                    for key, value in obj.items():
                        if key == 'message' and isinstance(value, str):
                            try: value = json.loads(value)
                            except ValueError: continue
                        found = find(value)
                        if found is not None: return found
                return None
            print('COOKIES', json.dumps([{k: c.get(k) for k in ('name', 'domain', 'path', 'expires', 'session', 'httpOnly', 'secure', 'sameSite')}
                                         for c in find(response) or [] if c.get('name') in args.cookies]), flush=True)
        if args.evaluate_file:
            print('RESULT', await asyncio.wait_for(session.runtime_evaluate(Path(args.evaluate_file).read_text()), 20), flush=True)
    finally:
        await inspector.close()
        await lockdown.close()

asyncio.run(main())
