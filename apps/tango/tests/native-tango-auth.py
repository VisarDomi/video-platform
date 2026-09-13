"""Bounded iPhone auth investigation. Never print cookie values or page URLs.

An optional diagnostic must return only redacted status; no console/network
listeners are installed. Never replay a live refresh token from this helper:
refresh rotation transfers ownership. Run using the existing Mac inspector-venv.
"""
import argparse
import asyncio
import json
import logging
from pathlib import Path
from urllib.parse import urlparse

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.webinspector import WebinspectorService

def find_cookies(obj):
    if not isinstance(obj, dict):
        return None
    if "cookies" in obj:
        return obj["cookies"]
    for key, value in obj.items():
        if key == "message" and isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                continue
        found = find_cookies(value)
        if found is not None:
            return found
    return None


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--page-id", type=int)
    parser.add_argument("--wait-popup", action="store_true", help="Wait up to 60 seconds for the Tango Login popup")
    parser.add_argument("--app", default="com.apple.mobilesafari")
    parser.add_argument("--cookies", action="store_true")
    parser.add_argument("--evaluate-file")
    parser.add_argument("--wait-status", action="store_true", help="Read redacted __tangoAuthProbe status after two seconds")
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    lockdown = await create_using_usbmux(serial="00008101-000639912881401E")
    inspector = WebinspectorService(lockdown=lockdown)
    try:
        await asyncio.wait_for(inspector.connect(), 15)
        pages = await inspector.get_open_application_pages(timeout=5)
        if not pages:
            await inspector.get_open_pages()
            pages = await inspector.get_open_application_pages(timeout=5)
        if args.wait_popup:
            print('WAITING_FOR_POPUP', flush=True)
            deadline = asyncio.get_running_loop().time() + 60
            while asyncio.get_running_loop().time() < deadline:
                matches = [p for p in pages if p.application.bundle == args.app
                    and urlparse(p.page.web_url).scheme == 'safari-web-extension'
                    and urlparse(p.page.web_url).path.endswith('/popup.html')]
                if matches:
                    args.page_id = matches[-1].page.id_
                    break
                await asyncio.sleep(2)
                pages = await inspector.get_open_application_pages(timeout=2)
            else:
                raise RuntimeError('No open popup found during the bounded wait')
        for pair in pages:
            url = urlparse(pair.page.web_url)
            print("PAGE", json.dumps({"app": pair.application.bundle,
                "id": pair.page.id_, "scheme": url.scheme, "host": url.hostname}), flush=True)
        if args.page_id is None:
            return
        pair = next(p for p in pages if p.application.bundle == args.app and p.page.id_ == args.page_id)
        session = await asyncio.wait_for(inspector.inspector_session(pair.application, pair.page), 15)
        await asyncio.wait_for(session.runtime_enable(), 10)
        if args.cookies:
            response = await asyncio.wait_for(session.send_command("Page.getCookies"), 10)
            cookies = find_cookies(response)
            print("COOKIES", json.dumps(None if cookies is None else [
                {key: cookie.get(key) for key in ("name", "domain", "path", "expires", "httpOnly", "secure", "session", "sameSite")}
                for cookie in cookies if cookie.get("domain", "").lstrip(".") in ("tango.me", "www.tango.me", "gateway.tango.me")
            ]), flush=True)
        if args.evaluate_file:
            result = await asyncio.wait_for(session.runtime_evaluate(Path(args.evaluate_file).read_text()), 15)
            print("STATUS", result, flush=True)
            if args.wait_status:
                await asyncio.sleep(2)
                print('STATUS', await asyncio.wait_for(session.runtime_evaluate('JSON.stringify(globalThis.__tangoAuthProbe)'), 10), flush=True)
    finally:
        await inspector.close()
        await lockdown.close()


asyncio.run(main())
