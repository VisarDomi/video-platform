#!/usr/bin/env python3
"""Shared list/back/forward/relaunch checks using static simulator surfaces only."""
import argparse, json, pathlib, subprocess, time, urllib.parse, urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--app', required=True)
parser.add_argument('--out', type=pathlib.Path, required=True)
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
tools = pathlib.Path.home() / 'Developer/ios-tools/native/scripts'
bundle = 'com.visar.SCLocal.paid'
subprocess.run([str(tools / 'mac-workload'), 'assert-simulator', '--device', args.device], check=True)

def sim(*command, timeout=45, check=True):
    return subprocess.run([str(tools / 'apple-tool'), 'simctl', *command], timeout=timeout,
                          check=check, capture_output=True, text=True)

def action(name, **values):
    query = urllib.parse.urlencode(dict(name=name, **values))
    with urllib.request.urlopen('http://127.0.0.1:8765/action?' + query, timeout=15) as response:
        return json.load(response)

def wait_for(predicate):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            value = action('navigation-state')
            if predicate(value): return value
        except (OSError, ValueError): pass
        time.sleep(.1)
    raise RuntimeError('Navigation state did not arrive')

def launch(provider, reset=False):
    sim('launch', args.device, bundle, '-navigation-check', '-navigation-provider', provider,
        *(['-reset-navigation-check'] if reset else []))
    return wait_for(lambda state: state.get('provider') == provider and state.get('rows') == 120)

report = []
try:
    sim('install', args.device, args.app, timeout=240)
    for provider in ['bunkr', 'sc', 'fc2', 'tango', 'vault', 'tango-live']:
        sim('terminate', args.device, bundle, check=False)
        launch(provider, reset=True)
        # Saving a restored anchor must not put the list back into its initial
        # positioning phase, nor discard the anchor before applying it.
        list_place = action('navigation-list-scroll', offset=347.25)
        action('navigation-flush')
        sim('terminate', args.device, bundle)
        list_restored = launch(provider)
        assert list_restored['viewer'] == '' and list_restored['firstRow'] == list_place['firstRow'], (list_place, list_restored)
        assert abs(list_restored['offset'] - list_place['offset']) < .5, (list_place, list_restored)
        opened = action('navigation-open', row=50)
        assert opened['viewer'] == 'Video 050.mp4', opened
        mutations = []
        if provider in ['sc', 'fc2', 'tango']:
            action('feed-scroll', delta=70)
            for operation, variant in [('ok', 'edited'), ('return', 'original'), ('cut', 'edited'), ('return', 'original')]:
                before_edit = action('navigation-edit-start')
                if operation == 'cut': action('navigation-edit-arrival', type=variant)
                after_edit = action('navigation-edit-finish', type=variant)
                before_frame = before_edit['viewerState']; after_frame = after_edit['viewerState']
                assert after_edit['viewer'] == before_edit['viewer'], (operation, before_edit, after_edit)
                assert after_frame['key'].endswith('\x1f' + variant), (operation, after_frame)
                assert after_frame['key'] == after_frame['frameKey'] == after_frame['unitKey'], (operation, after_frame)
                assert after_frame['visiblePlayers'] == 1 and all(abs(a-b) < .5 for a,b in zip(before_frame['picture'], after_frame['picture'])), (operation, before_frame, after_frame)
                assert abs(before_frame['offset'] - after_frame['offset']) < .5, (operation, before_frame, after_frame)
                mutations.append(dict(operation=operation, before=before_edit, after=after_edit))
            action('navigation-edit-start')
            moved = action('feed-scroll', delta=500)
            finished = action('navigation-edit-finish', type='edited')
            assert moved['viewer'] != 'Video 050.mp4' and finished['viewer'] == moved['viewer'], (moved, finished)
            assert all(abs(a-b) < .5 for a,b in zip(moved['viewerState']['picture'], finished['viewerState']['picture'])), (moved, finished)
            action('navigation-open', row=50)
            action('navigation-edit-start'); action('navigation-edit-finish', type='original')
            opened = action('navigation-state')
        for _ in range(3):
            back = action('navigation-back')
            assert back['viewer'] == '' and back['highlight'] == 'Video 050.mp4', back
            assert abs(back['offset'] - opened['offset']) < .5, (back, opened)
            forward = action('navigation-forward')
            assert forward['viewer'] == 'Video 050.mp4', forward
        before = action('navigation-state')
        arrived = action('navigation-arrival')
        assert arrived['rows'] == 121 and arrived['viewer'] == before['viewer'], arrived
        assert arrived['firstRow'] == before['firstRow'], (before, arrived)
        action('navigation-flush')
        sim('terminate', args.device, bundle)
        restored = launch(provider)
        assert restored['viewer'] == 'Video 050.mp4', restored
        assert restored['viewerState']['key'] == before['viewerState']['key'], (before, restored)
        action('navigation-back')
        report.append(dict(provider=provider, listPlace=list_place, listRestored=list_restored, opened=opened, back=back, arrived=arrived, restored=restored, mutations=mutations))
        print('PASS shared navigation:', provider, flush=True)
    sim('io', args.device, 'screenshot', str(args.out / 'restored-list.png'))
finally:
    (args.out / 'navigation-report.json').write_text(json.dumps(report, indent=2))
    sim('terminate', args.device, bundle, check=False)
