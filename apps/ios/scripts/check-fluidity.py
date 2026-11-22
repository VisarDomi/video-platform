#!/usr/bin/env python3
"""Time opening, scrubbing and jumping in a recordings app in the virtual iPhone.

Runs on the Mac inside one guarded virtual-iPhone session (ios-tools' mac-workload), against the
PC's recordings (or scripts/pc-mirror.py when the Mac cannot reach the PC). One video decodes at
a time, as the viewer plays only its current video. Nothing here touches a phone.

For each chosen row: open it at a saved position, play, drag +45 s in 0.75 s and lift, jump
ahead, jump back, then a swipe to the next video. Reports when the picture and steady
playback arrive after each step, the main thread's frame gaps, and how many players held
an item at the time.
"""
import argparse, json, pathlib, subprocess, time, urllib.parse, urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--bundle', required=True, help="the app's bundle ID")
parser.add_argument('--app', type=pathlib.Path)
parser.add_argument('--out', type=pathlib.Path, required=True)
parser.add_argument('--rows', required=True, help='comma list of filename prefixes to open')
parser.add_argument('--saved', type=float, default=300, help='saved position to restore, seconds')
parser.add_argument('--play', type=float, default=5, help='seconds of steady playback before scrubbing')
parser.add_argument('--ca', help='root certificate the guest must trust (the PC or mirror CA)')
parser.add_argument('--label', default='run')
parser.add_argument('--no-install', action='store_true')
parser.add_argument('--no-swipe', action='store_true')
parser.add_argument('--launch-args', default='', help='extra launch arguments for the app, space separated')
args = parser.parse_args()
tools = pathlib.Path.home() / 'Developer/ios-tools/native/scripts'
subprocess.run([str(tools / 'mac-workload'), 'assert-simulator', '--device', args.device], check=True)
args.out.mkdir(parents=True, exist_ok=True)

def sim(*command, timeout=60, check=True):
    return subprocess.run([str(tools / 'apple-tool'), 'simctl', *map(str, command)], timeout=timeout,
                          check=check, capture_output=True, text=True)

def action(name, **values):
    query = urllib.parse.urlencode(dict(name=name, **values))
    with urllib.request.urlopen('http://127.0.0.1:8765/action?' + query, timeout=20) as response:
        return json.load(response)

def wait(predicate, seconds, what, poll=.15):
    deadline = time.monotonic() + seconds
    value = None
    while time.monotonic() < deadline:
        try:
            value = action('fluidity-state')
            if predicate(value): return value
        except (OSError, ValueError): pass
        time.sleep(poll)
    print('TIMEOUT', what, json.dumps({k: value.get(k) for k in ('current', 'picture', 'playing', 'clock')} if value else None), flush=True)
    return None

def collect():
    samples, start, last, details = [], 0, {}, []
    while True:
        last = action('fluidity-samples', **{'from': start})
        samples += last['samples']
        if start == 0: details = last['details']
        start += len(last['samples'])
        if not last['samples'] or start >= last['total']: break
    return samples, last['events'], details

MS, GAP, NAME, PICTURE, PLAYING, WANTS, CLOCK, VISIBLE, ITEMS = range(9)

def first(samples, begin, test):
    for index in range(begin, len(samples)):
        if test(samples[index]): return index
    return None

def moving(samples, begin, name, near=None):
    """First frame of `name` from which its clock keeps advancing (and near the wanted time)."""
    for index in range(begin, len(samples) - 12):
        row, later = samples[index], samples[index + 12]
        if row[NAME] != name or later[NAME] != name or not row[PLAYING]: continue
        if later[CLOCK] - row[CLOCK] < .1: continue
        if near is not None and abs(row[CLOCK] - near) > 12: continue
        return index
    return None

def gaps(samples, begin, end):
    window = [row[GAP] for row in samples[begin:end]]
    return dict(frames=len(window), over25=sum(g > 25 for g in window), over50=sum(g > 50 for g in window),
                over100=sum(g > 100 for g in window), worst=max(window, default=0),
                stalledMs=round(sum(g for g in window if g > 25), 1))

def summarize(samples, events):
    result = []
    def since(index, event): return None if index is None else round(samples[index][MS] - event['at'], 1)
    for position, event in enumerate(events):
        begin = event['sample']
        following = next((e['sample'] for e in events[position + 1:] if e['event'] in ('open', 'seek', 'scrub-start', 'swipe-start', 'close')), len(samples))
        if event['event'] == 'open':
            name = event['name'][:13]
            picture = first(samples, begin, lambda r: r[NAME] == name and r[PICTURE])
            run = moving(samples, begin, name)
            items = max((r[ITEMS] for r in samples[begin:following]), default=0)
            result.append(dict(step='open', video=event['name'][:34], pictureMs=since(picture, event), playingMs=since(run, event),
                               maxItems=items, hitches=gaps(samples, begin, run or following)))
        elif event['event'] == 'scrub-start':
            release = next((e for e in events[position + 1:] if e['event'] == 'scrub-release'), None)
            if not release: continue
            name = samples[min(begin, len(samples) - 1)][NAME]
            clocks = [r[CLOCK] for r in samples[begin:release['sample']]]
            run = moving(samples, release['sample'], name, near=event['to'])
            result.append(dict(step='scrub', video=name, dragMs=round(release['at'] - event['at'], 1),
                               distinctClocksDuringDrag=len(set(clocks)), playingAfterReleaseMs=since(run, release),
                               landed=None if run is None else samples[run][CLOCK], target=event['to'],
                               dragHitches=gaps(samples, begin, release['sample']), hitches=gaps(samples, begin, run or following)))
        elif event['event'] == 'seek' and event.get('resume'):
            name = samples[min(begin, len(samples) - 1)][NAME]
            run = moving(samples, begin, name, near=event['time'])
            result.append(dict(step='jump', video=name, playingMs=since(run, event),
                               landed=None if run is None else samples[run][CLOCK], target=event['time'], hitches=gaps(samples, begin, run or following)))
        elif event['event'] == 'swipe-start':
            release = next((e for e in events[position + 1:] if e['event'] == 'swipe-release'), None)
            if not release: continue
            name = release['name'][:13]
            picture = first(samples, release['sample'], lambda r: r[NAME] == name and r[PICTURE])
            run = moving(samples, release['sample'], name)
            result.append(dict(step='swipe', video=release['name'][:34], pictureAfterReleaseMs=since(picture, release),
                               playingAfterReleaseMs=since(run, release), hitches=gaps(samples, begin, run or following)))
    return result

report = dict(label=args.label, runs=[])
try:
    if not args.no_install:
        assert args.app, '--app is required to install'
        sim('install', args.device, args.app, timeout=240)
    if args.ca: sim('keychain', args.device, 'add-root-cert', args.ca)
    sim('terminate', args.device, args.bundle, check=False)
    log = args.out / (args.label + '-app.log')
    sim('launch', '--terminate-running-process', '--stderr=' + str(log), '--stdout=' + str(log), args.device, args.bundle, *args.launch_args.split())
    listed = wait(lambda state: state.get('rows', 0) > 0, 60, 'the list from the PC')
    assert listed, 'The list did not load: is the PC (or its mirror) reachable from the Mac?'
    rows = action('fluidity-list')['rows']
    time.sleep(3)  # the list builds its spare viewer 1.5 s after it loads; a tap then only fills it
    (args.out / 'rows.json').write_text(json.dumps(rows, indent=2))
    for want in [v for v in args.rows.split(',') if v]:
        video = next((r for r in rows if r['name'].startswith(want)), None)
        assert video, 'No row matches ' + want
        name = video['name'][:13]
        saved = min(args.saved, max(0, video['duration'] - 120))
        action('fluidity-reset')
        action('fluidity-progress', row=video['row'], time=saved)
        if video['row'] + 1 < len(rows): action('fluidity-progress', row=video['row'] + 1, time=0)
        action('fluidity-open', row=video['row'])
        opened = wait(lambda s: s.get('current', '')[:13] == name and s.get('playing') and s.get('picture') and s.get('clock', 0) > max(.3, saved - 8), 45, 'open ' + name)
        if opened: time.sleep(args.play)
        base = action('fluidity-state').get('clock', saved)
        # A drag across three quarters of the screen: +45 s in 0.75 s, then the finger lifts.
        action('fluidity-scrub', **{'from': base, 'to': base + 45, 'steps': 45, 'ms': 750})
        time.sleep(1.0)
        wait(lambda s: s.get('playing') and s.get('clock', 0) > base + 30, 30, 'scrub ' + name)
        time.sleep(2)
        target = min(video['duration'] - 30, base + 200)
        action('fluidity-seek', time=target, resume=1)
        wait(lambda s: s.get('playing') and abs(s.get('clock', 0) - target) < 15, 30, 'jump ' + name)
        time.sleep(2)
        action('fluidity-seek', time=20, resume=1)
        wait(lambda s: s.get('playing') and 10 < s.get('clock', 0) < 35, 30, 'jump back ' + name)
        time.sleep(2)
        if not args.no_swipe and video['row'] + 1 < len(rows):
            feed = action('fluidity-state').get('feed', {})
            height = next((p['frame'][3] for p in feed.get('players', []) if p['key'] == feed.get('key')), 240)
            action('fluidity-swipe', delta=height, steps=18, ms=300)
            time.sleep(.6)
            following = rows[video['row'] + 1]['name'][:13]
            wait(lambda s: s.get('current', '')[:13] == following and s.get('playing') and s.get('clock', 0) > .5, 45, 'swipe to ' + following)
            time.sleep(2)
        state = action('fluidity-state')
        samples, events, details = collect()
        action('fluidity-close')
        time.sleep(1.5)
        (args.out / (args.label + '-' + name + '-raw.json')).write_text(json.dumps(dict(samples=samples, events=events, details=details, state=state)))
        steps = summarize(samples, events)
        report['runs'].append(dict(video=video['name'], steps=steps, frames=state.get('frames')))
        for step in steps: print(json.dumps(step), flush=True)
finally:
    (args.out / (args.label + '-report.json')).write_text(json.dumps(report, indent=2))
    sim('terminate', args.device, args.bundle, check=False)
