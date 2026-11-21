#!/usr/bin/env python3
"""A walk through a local-library app on the Mac's virtual iPhone, against a real server.

Runs inside one guarded simulator session (native/MAC-WORKLOADS.md in ios-tools):

    mac-workload simulator --device UUID --app video-platform -- \\
        /usr/bin/python3 check-local.py --device UUID --app WimbledonLocal.app --out DIR [--cert PEM]

The app's server (Info.plist PCServer, https://localhost:29999 by default) must answer on the
Mac, e.g. the demo pod forwarded from the PC. It opens the list, the first recording, the next
one, zooms, returns; opens a recording being captured; with --save it saves the first original
with the save button (✅) and checks that the server now lists it as kept. With --offline it
expects the list's failure message instead. Every step leaves a screenshot in DIR and the whole
run a report.json; it fails on the first broken expectation. The app is uninstalled afterwards
unless --keep.
"""
import argparse
import json
import plistlib
import re
import ssl
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
parser.add_argument("--device", required=True)
parser.add_argument("--app", required=True, help="the simulator build (.app)")
parser.add_argument("--out", required=True)
parser.add_argument("--cert", help="a root certificate the server's HTTPS chains to (added to the device once)")
parser.add_argument("--save", action="store_true", help="also save the second recording (✅)")
parser.add_argument("--offline", action="store_true", help="the server is down: expect the failure message")
parser.add_argument("--keep", action="store_true", help="leave the app installed")
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
tools = Path.home() / "Developer/ios-tools/native/scripts"
info = plistlib.loads((Path(args.app) / "Info.plist").read_bytes())
bundle, server, provider = info["CFBundleIdentifier"], info["PCServer"].rstrip("/"), info["LocalProvider"]
report = {"bundle": bundle, "steps": []}
ROW = re.compile(r"^\d{4}-\d{2}-\d{2} \d{6} ")


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


def labels():
    return [item for item in layout() if item["kind"] == "label"]


def center(item):
    x, y, w, h = item["frame"]
    return {"x": x + w / 2, "y": y + h / 2}


def shot(name, **facts):
    path = out / f"{len(report['steps']) + 1:02d}-{name}.png"
    sim("io", args.device, "screenshot", str(path))
    report["steps"].append({"step": name, "screenshot": path.name, **facts})


def video_shown():
    return any(item["kind"] == "video" and item["shown"] for item in layout())


def library():
    """The server's own list of this provider's recordings (what the app shows)."""
    context = ssl.create_default_context(cafile=args.cert) if args.cert else ssl.create_default_context()
    url = server + "/api/videos?" + urllib.parse.urlencode({"provider": provider})
    with urllib.request.urlopen(url, timeout=15, context=context) as response:
        return json.load(response)


def row(filename):
    """The list row showing this recording, scrolled into view."""
    def find():
        return next((item for item in labels() if item.get("text") == filename), None)
    found = find()
    if not found:
        hook("scroll", y=0)
        for _ in range(12):
            found = find()
            if found:
                break
            hook("scroll", y=state("list").get("offset", 0) + 500)
            time.sleep(0.4)
    assert found, "no row for " + filename
    return found


def open_recording(filename, what):
    hook("tap", **center(row(filename)))
    wait(lambda: state("list").get("viewer") == filename, "the viewer on " + filename)
    wait(video_shown, "the first frame of " + filename, timeout=45)
    time.sleep(3)
    shot(what, video=filename)


try:
    subprocess.run([str(tools / "mac-workload"), "assert-simulator", "--device", args.device], check=True)
    if args.cert:
        sim("keychain", args.device, "add-root-cert", args.cert)
    sim("install", args.device, args.app, timeout=240)
    sim("terminate", args.device, bundle, check=False)
    sim("launch", args.device, bundle)
    wait(lambda: "list" in hook("state"), "the test hooks")

    if args.offline:
        failure = wait(lambda: state("list").get("failure"), "the list's failure message", timeout=90)
        shot("offline-list", failure=failure)
        raise SystemExit(0)

    rows = wait(lambda: state("list").get("rows"), "the list's rows", timeout=90)
    shown = [item["text"] for item in sorted(labels(), key=lambda item: item["frame"][1]) if ROW.match(item.get("text", ""))]
    videos = library()
    assert shown and shown[0] == videos[0]["filename"], (shown[:3], [v["filename"] for v in videos[:3]])
    shot("list", rows=rows, failure=state("list").get("failure"))

    first = videos[0]["filename"]
    open_recording(first, "viewer")

    # The next recording, a page further down the feed.
    height = max(item["frame"][1] + item["frame"][3] for item in layout())
    hook("scroll", y=height)
    second = wait(lambda: (name := state("list").get("viewer")) != first and name, "the next recording")
    wait(video_shown, "the first frame of " + second, timeout=45)
    time.sleep(2)
    shot("next", video=second)

    hook("zoom", scale=2.5)
    time.sleep(1)
    shot("zoomed", video=second)
    hook("zoom", scale=1)
    time.sleep(1)

    hook("back")
    time.sleep(1.5)
    shot("list-back", highlight=state("list").get("highlight"))

    capturing = next((v["filename"] for v in videos if v.get("isLive")), None)
    if capturing:
        open_recording(capturing, "capturing")
        hook("back")
        time.sleep(1.5)

    if args.save:
        original = next((v["filename"] for v in videos if v["type"] == "original" and not v.get("isLive")), None)
        assert original, "no finished original to save"
        open_recording(original, "original")
        save = wait(lambda: next((item for item in labels() if item.get("text") == "✅"), None), "the save button")
        hook("tap", **center(save))
        kept = wait(lambda: any(v["filename"] == original and v["type"] == "edited" for v in library()),
                    "the server listing " + original + " as kept", timeout=30)
        time.sleep(2)
        shot("saved", video=original, viewer=state("list").get("viewer"), kept=kept)
        hook("back")
        time.sleep(1.5)

    after = state("list")
    shot("list-after", rows=after.get("rows"), highlight=after.get("highlight"))
    report["frames"] = hook("state").get("frames", {})
    report["ok"] = True
finally:
    (out / "report.json").write_text(json.dumps(report, indent=2))
    sim("terminate", args.device, bundle, check=False)
    if not args.keep:
        sim("uninstall", args.device, bundle, check=False)
