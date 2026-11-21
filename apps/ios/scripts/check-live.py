#!/usr/bin/env python3
"""A walk through a live app on the Mac's virtual iPhone, against a real site and PC.

Runs inside one guarded simulator session (native/MAC-WORKLOADS.md in ios-tools):

    mac-workload simulator --device UUID --app video-platform -- \\
        /usr/bin/python3 check-live.py --device UUID --app Wimbledon.app --out DIR [--cert PEM]

The app's PC (Info.plist PCServer) and live site (LiveSite) must answer on the Mac, e.g. the demo
pod forwarded from the PC, and the app must carry the PC's phone key (apps.local.json
"phoneKeys"). From a fresh install it expects the PC to sign the phone in, the followed live
streams to list, a stream to play and keep playing past its stream tokens' lifetime, the next
one, and after a relaunch the kept list at once, signed in without the PC. Every step leaves a
screenshot in DIR and the whole run a report.json; it fails on the first broken expectation.
"""
import argparse
import json
import plistlib
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
parser.add_argument("--device", required=True)
parser.add_argument("--app", required=True, help="the simulator build (.app)")
parser.add_argument("--out", required=True)
parser.add_argument("--cert", help="a root certificate the PC's and the site's HTTPS chain to")
parser.add_argument("--keep", action="store_true", help="leave the app installed")
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
tools = Path.home() / "Developer/ios-tools/native/scripts"
info = plistlib.loads((Path(args.app) / "Info.plist").read_bytes())
bundle = info["CFBundleIdentifier"]
assert info.get("PhoneKey"), "the app has no phone key (apps.local.json phoneKeys)"
report = {"bundle": bundle, "steps": []}


def sim(*command, timeout=60, check=True):
    return subprocess.run([str(tools / "apple-tool"), "simctl", *command], capture_output=True, text=True,
                          timeout=timeout, check=check).stdout


def hook(path, **query):
    url = "http://127.0.0.1:8765/" + path + ("?" + urllib.parse.urlencode(query) if query else "")
    with urllib.request.urlopen(url, timeout=15) as response:
        return json.load(response)


def wait(probe, what, timeout=60):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            last = probe()
            if last:
                return last
        except (OSError, ValueError, KeyError) as error:
            last = error
        time.sleep(0.25)
    raise AssertionError(f"{what}: not within {timeout} s (last: {last!r})")


def state(name):
    return hook("state").get(name, {})


def layout():
    return hook("layout")["layout"]


def center(item):
    x, y, w, h = item["frame"]
    return {"x": x + w / 2, "y": y + h / 2}


def shot(name, **facts):
    path = out / f"{len(report['steps']) + 1:02d}-{name}.png"
    sim("io", args.device, "screenshot", str(path))
    report["steps"].append({"step": name, "screenshot": path.name, **facts})


def video_shown():
    return any(item["kind"] == "video" and item["shown"] for item in layout())


def launch():
    sim("terminate", args.device, bundle, check=False)
    sim("launch", args.device, bundle)
    wait(lambda: "live" in hook("state"), "the test hooks")


errors = []


def listed():
    """The list once it has streams; failures on the way (the app retries them) are recorded."""
    live = state("live")
    if live.get("streams"):
        return live
    if live.get("lastError") and live["lastError"] not in errors:
        errors.append(live["lastError"])
    return None


try:
    subprocess.run([str(tools / "mac-workload"), "assert-simulator", "--device", args.device], check=True)
    if args.cert:
        sim("keychain", args.device, "add-root-cert", args.cert)
    sim("uninstall", args.device, bundle, check=False)  # a fresh install: no session yet
    sim("install", args.device, args.app, timeout=240)
    launch()

    live = wait(listed, "the followed live streams (signed in by the PC)", timeout=120)
    titles = [item for item in sorted(layout(), key=lambda item: item["frame"][1]) if item["kind"] == "label"
              and item["frame"][1] > 40 and item.get("text") and not item["text"].startswith(("--", "0"))]
    shot("list", streams=live["streams"], signedIn=live["signedIn"], titles=[t["text"] for t in titles[:6]], retried=errors)

    hook("tap", **center(titles[0]))
    first = wait(lambda: state("list").get("viewer"), "the viewer")
    wait(video_shown, "the first frame of " + first, timeout=60)
    time.sleep(4)
    shot("playing", account=first)
    # Stream tokens last about 10 s: the playlist reloads must keep working on renewed ones.
    time.sleep(25)
    assert video_shown() and state("list").get("viewer") == first, "playback stopped after the tokens' lifetime"
    shot("still-playing", account=first)

    if live["streams"] > 1:
        height = max(item["frame"][1] + item["frame"][3] for item in layout())
        hook("scroll", y=height)
        second = wait(lambda: (name := state("list").get("viewer")) != first and name, "the next stream")
        wait(video_shown, "the first frame of " + second, timeout=60)
        time.sleep(3)
        shot("next", account=second)

    hook("back")
    time.sleep(1.5)
    shot("list-back", highlight=state("list").get("highlight"))

    # A relaunch shows the kept list before the site answers, and stays signed in by itself.
    launch()
    kept = wait(lambda: state("live").get("streams"), "the kept list", timeout=10)
    shot("relaunched", streams=kept)
    wait(lambda: state("live").get("lastSuccess"), "a fresh list after the relaunch", timeout=60)
    report["ok"] = True
finally:
    (out / "report.json").write_text(json.dumps(report, indent=2))
    sim("terminate", args.device, bundle, check=False)
    if not args.keep:
        sim("uninstall", args.device, bundle, check=False)
