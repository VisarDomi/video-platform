#!/usr/bin/env python3
"""Time opening, scrubbing, jumping and moving to a neighbour in the real Bunkr app.

Runs on the Mac inside one guarded virtual-iPhone session, against the PC's original
files. One video decodes at a time (the viewer's own rule). Nothing here touches a phone.
"""
import argparse, json, pathlib, subprocess, sys, time, urllib.parse, urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--app', type=pathlib.Path)
parser.add_argument('--out', type=pathlib.Path)
parser.add_argument('--videos', default='h264,vp9,av1', help='comma list: a codec, or a filename prefix')
parser.add_argument('--saved', type=float, default=97.3, help='saved position to restore, seconds (0: from the start)')
parser.add_argument('--play', type=float, default=6, help='seconds of steady playback to sample')
parser.add_argument('--no-install', action='store_true')
parser.add_argument('--reopen', action='store_true', help='close each video and open it again: its still shows at once')
parser.add_argument('--engine-log', action='store_true', help='write the direct decoder log to app.stderr.log')
parser.add_argument('--cleanup', action='store_true', help='uninstall the simulator copy and stop')
args = parser.parse_args()
tools = pathlib.Path.home() / 'Developer/ios-tools/native/scripts'
bundle = 'com.visar.BunkrLocal.paid'
subprocess.run([str(tools / 'mac-workload'), 'assert-simulator', '--device', args.device], check=True)

def sim(*command, timeout=60, check=True):
    return subprocess.run([str(tools / 'apple-tool'), 'simctl', *map(str, command)], timeout=timeout,
                          check=check, capture_output=True, text=True)

if args.cleanup:
    sim('terminate', args.device, bundle, check=False)
    sim('uninstall', args.device, bundle, check=False)
    assert sim('get_app_container', args.device, bundle, 'app', check=False).returncode != 0, 'Bunkr is still installed in the guest'
    print('Removed the simulator copy')
    raise SystemExit(0)
if not args.out: parser.error('--out is required')
args.out.mkdir(parents=True, exist_ok=True)

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
    samples, start, last = [], 0, {}
    while True:
        last = action('fluidity-samples', **{'from': start})
        samples += last['samples']
        if start == 0: details = last['details']
        start += len(last['samples'])
        if not last['samples'] or start >= last['total']: break
    return samples, last['events'], details

MS, GAP, NAME, PICTURE, PLAYING, WANTS, CLOCK, VISIBLE, SERIAL = range(9)

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
                over100=sum(g > 100 for g in window), worst=max(window, default=0))

def summarize(samples, events, details):
    result, opened = [], None
    def at(index): return None if index is None else samples[index][MS]
    def since(index, event): return None if index is None else round(samples[index][MS] - event['at'], 1)
    for position, event in enumerate(events):
        begin = event['sample']
        following = next((e['sample'] for e in events[position + 1:] if e['event'] in ('open', 'seek', 'scrub-start', 'swipe-start', 'close')), len(samples))
        if event['event'] == 'open':
            opened = name = event['name'][:13]
            shown = first(samples, begin, lambda r: r[NAME] == name and r[PICTURE])
            picture = first(samples, begin, lambda r: r[NAME] == name and r[PICTURE] == 1)
            run = moving(samples, begin, name)
            row = dict(step='reopen' if any(r['step'] == 'open' and r['video'] == event['name'][:34] for r in result) else 'open',
                       video=event['name'][:34], codec=event['codec'], shownMs=since(shown, event), pictureMs=since(picture, event), playingMs=since(run, event),
                       hitches=gaps(samples, begin, (run or following)))
            if run is not None:
                a = first(samples, run, lambda r: r[MS] >= samples[run][MS] + 1000)
                b = first(samples, run, lambda r: r[MS] >= samples[run][MS] + 5000)
                if a is not None and b is not None and b <= following and samples[b][NAME] == name:
                    seconds = (samples[b][MS] - samples[a][MS]) / 1000
                    row['steady'] = dict(clockRate=round((samples[b][CLOCK] - samples[a][CLOCK]) / seconds, 3),
                                         picturesPerSecond=round((samples[b][SERIAL] - samples[a][SERIAL]) / seconds, 1), hitches=gaps(samples, a, b))
            result.append(row)
        elif event['event'] == 'scrub-start':
            release = next((e for e in events[position + 1:] if e['event'] == 'scrub-release'), None)
            if not release: continue
            name = samples[begin][NAME] if begin < len(samples) else opened
            serials = [r[SERIAL] for r in samples[begin:release['sample']]]
            shown = first(samples, release['sample'], lambda r: r[SERIAL] != samples[max(0, release['sample'] - 1)][SERIAL])
            run = moving(samples, release['sample'], name, near=event['to'])
            result.append(dict(step='scrub', video=name, picturesDuringDrag=len(set(serials)) - 1, dragMs=round(release['at'] - event['at'], 1),
                               pictureAfterReleaseMs=since(shown, release), playingAfterReleaseMs=since(run, release),
                               landed=None if run is None else samples[run][CLOCK], target=event['to'], hitches=gaps(samples, begin, run or following)))
        elif event['event'] == 'seek' and event.get('resume'):
            name = samples[begin][NAME] if begin < len(samples) else opened
            shown = first(samples, begin, lambda r: r[SERIAL] != samples[max(0, begin - 1)][SERIAL])
            run = moving(samples, begin, name, near=event['time'])
            result.append(dict(step='jump', video=name, pictureMs=since(shown, event), playingMs=since(run, event),
                               landed=None if run is None else samples[run][CLOCK], target=event['time'], hitches=gaps(samples, begin, run or following)))
        elif event['event'] == 'swipe-start':
            release = next((e for e in events[position + 1:] if e['event'] == 'swipe-release'), None)
            if not release: continue
            name = release['name'][:13]
            shown = first(samples, release['sample'], lambda r: r[NAME] == name and r[PICTURE])
            picture = first(samples, release['sample'], lambda r: r[NAME] == name and r[PICTURE] == 1)
            run = moving(samples, release['sample'], name)
            result.append(dict(step='swipe', video=release['name'][:34], shownAfterReleaseMs=since(shown, release), pictureAfterReleaseMs=since(picture, release), playingAfterReleaseMs=since(run, release),
                               hitches=gaps(samples, begin, run or following)))
    return result

report = dict(videos=[], runs=[])
try:
    if not args.no_install:
        assert args.app, '--app is required to install'
        sim('install', args.device, args.app, timeout=240)
    sim('terminate', args.device, bundle, check=False)
    log = args.out / 'app.stderr.log'
    sim('launch', '--terminate-running-process', '--stderr=' + str(log), args.device, bundle, *(['-engine-log'] if args.engine_log else []))
    listed = wait(lambda state: state.get('rows', 0) > 0, 60, 'the list from the PC')
    assert listed, 'The list did not load: is the PC library reachable from the Mac?'
    rows = action('fluidity-list')['rows']
    time.sleep(3)  # the list builds its spare viewer 1.5 s after it loads; a tap then only fills it
    (args.out / 'rows.json').write_text(json.dumps(rows, indent=2))
    chosen = []
    for want in [v for v in args.videos.split(',') if v]:
        match = next((r for r in rows if r['codec'] == want and r['row'] not in [c['row'] for c in chosen] and r['row'] + 1 < len(rows)), None) \
            or next((r for r in rows if r['name'].startswith(want)), None)
        assert match, 'No video matches ' + want
        chosen.append(match)
    for video in chosen:
        name = video['name'][:13]
        action('fluidity-reset')
        action('fluidity-progress', row=video['row'], time=args.saved)
        # The neighbour reached by the swipe starts from its beginning.
        action('fluidity-progress', row=video['row'] + 1, time=0)
        action('fluidity-open', row=video['row'])
        opened = wait(lambda s: s.get('current', '')[:13] == name and s.get('playing') and s.get('picture') and s.get('clock', 0) > max(.3, args.saved - 8), 45, 'open ' + name)
        if opened: time.sleep(args.play)
        sim('io', args.device, 'screenshot', args.out / (name + '-playing.png'), check=False)
        base = action('fluidity-state').get('clock', args.saved)
        # A drag across three quarters of the screen: +45 s in 0.75 s, then the finger lifts.
        action('fluidity-scrub', **{'from': base, 'to': base + 45, 'steps': 45, 'ms': 750})
        time.sleep(1.0)
        wait(lambda s: s.get('playing') and s.get('clock', 0) > base + 30, 30, 'scrub ' + name)
        time.sleep(2)
        sim('io', args.device, 'screenshot', args.out / (name + '-scrubbed.png'), check=False)
        target = min(video['duration'] - 30, base + 200)
        action('fluidity-seek', time=target, resume=1)
        wait(lambda s: s.get('playing') and abs(s.get('clock', 0) - target) < 15 and s.get('clock', 0) > target - 10, 30, 'jump ' + name)
        time.sleep(2)
        action('fluidity-seek', time=20, resume=1)
        wait(lambda s: s.get('playing') and 10 < s.get('clock', 0) < 35, 30, 'jump back ' + name)
        time.sleep(2)
        feed = action('fluidity-state').get('feed', {})
        height = next((p['frame'][3] for p in feed.get('players', []) if p['key'] == feed.get('key')), 240)
        action('fluidity-swipe', delta=height, steps=18, ms=300)
        time.sleep(.6)
        following = rows[video['row'] + 1]['name'][:13]
        wait(lambda s: s.get('current', '')[:13] == following and s.get('playing') and s.get('clock', 0) > .5, 45, 'swipe to ' + following)
        time.sleep(3)
        sim('io', args.device, 'screenshot', args.out / (name + '-next.png'), check=False)
        if args.reopen:
            # Back to the list and in again: the place it stopped at shows as a still at once.
            action('fluidity-close')
            time.sleep(3)
            action('fluidity-open', row=video['row'])
            wait(lambda s: s.get('current', '')[:13] == name and s.get('playing') and s.get('picture'), 45, 'reopen ' + name)
            time.sleep(2)
        state = action('fluidity-state')
        samples, events, details = collect()
        action('fluidity-close')
        time.sleep(1.5)
        (args.out / (name + '-raw.json')).write_text(json.dumps(dict(samples=samples, events=events, details=details, state=state)))
        steps = summarize(samples, events, details)
        engines = sorted({(u.get('name'), u.get('engine', 'AVPlayer'), u.get('hardwareDecoder')) for d in details for u in d['units'] if u.get('active')}, key=str)
        report['runs'].append(dict(video=video['name'], codec=video['codec'], engines=engines, steps=steps, frames=state.get('frames')))
        for step in steps: print(json.dumps(step), flush=True)
        print('engines', json.dumps(engines), flush=True)
finally:
    (args.out / 'report.json').write_text(json.dumps(report, indent=2))
    sim('terminate', args.device, bundle, check=False)
