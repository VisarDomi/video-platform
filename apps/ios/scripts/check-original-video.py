#!/usr/bin/env python3
"""Run native codec checks in place; use --cleanup when the task is finished."""
import argparse, fcntl, json, pathlib, plistlib, subprocess, time, uuid

BUNDLE = 'com.visar.OriginalVideoProbe.paid'

def validate(report, run_id):
    assert report.get('runID') == run_id and report.get('complete'), 'Stale or incomplete native check'
    assert report.get('transportReady'), 'Allow Local Network for Original video check, then retry in place'
    samples = {r['second']: r for r in report['samples']}
    raw = lambda n: samples[n].get('nativeTime', -1)
    assert samples[2]['rate'] == 0 and samples[2]['unitTime'] < .2, 'Paused neighbour advanced'
    assert samples[8]['displayedVideoFrames'] > 20, 'Original video picture missing'
    assert abs(raw(10) - raw(9)) < .25, 'Pause did not hold clock'
    assert 119.5 <= raw(12) <= 120.5 and 121 <= raw(16) <= 125, 'Native seek jumped or stalled'
    base = samples[8]['sourceResolutions']
    assert all(samples[n]['sourceResolutions'] == base for n in range(8, 24)), 'Unexpected recovery during seek/return'
    assert raw(19) > raw(17) + 1, 'Video-off interval stopped audio/time'
    assert samples[23]['displayedVideoFrames'] > samples[21]['displayedVideoFrames'], 'Video did not return'
    saved = samples[24]['savedTime']
    assert saved <= raw(28) <= saved + 6, 'Saved native clock was lost'
    assert samples[34]['ended'] and samples[35]['ended'], 'EOF restarted after resume/play'
    assert samples[35]['sourceResolutions'] == base + 1, 'EOF triggered recovery'
    assert samples[40]['sourceResolutions'] == base + 2 and 3 <= raw(40) <= 9, 'Seek after EOF did not reopen correctly'
    assert all(r['muted'] for r in samples.values()), 'Muted test unexpectedly enabled sound'
    assert len(report['teardownMilliseconds']) == 5 and max(report['teardownMilliseconds']) < 50, 'Decoder teardown blocked the UI thread'
    assert report['retiringDecoders'] == 0, 'Stopped decoder lifetime leaked'
    assert report['teardownWorstGapMs'] < 100, 'Native teardown stalled the UI after returning to the list'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=pathlib.Path)
    parser.add_argument('--device', required=True)
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--original-url')
    source.add_argument('--original-file', type=pathlib.Path, help='Copy original bytes into the test container; no phone LAN permission needed')
    parser.add_argument('--codec', default='av1', choices=['av1', 'vp9', 'vp8', 'h264', 'hevc'])
    parser.add_argument('--filename', default='original-codec-probe.mp4')
    parser.add_argument('--duration', type=float, default=412.270295)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--cleanup', action='store_true', help='Finish the testing session: uninstall only the diagnostic app and verify cleanup')
    parser.add_argument('--tools', type=pathlib.Path, default=pathlib.Path.home() / 'Developer/ios-tools/native/scripts')
    args = parser.parse_args()
    if not args.cleanup and (args.app is None or (args.original_url is None and args.original_file is None)):
        parser.error('--app and --original-url or --original-file are required for a test run')
    args.out.mkdir(parents=True, exist_ok=True)
    run_id = str(uuid.uuid4())
    pid = None

    def run(*command, timeout=90, check=True):
        return subprocess.run(list(map(str, command)), check=check, timeout=timeout)

    def device(*command, timeout=60):
        return run(args.tools / 'apple-tool', 'devicectl', 'device', *command[:2], '--device', args.device,
                   '--timeout', str(timeout), *command[2:], timeout=timeout + 10)

    if args.cleanup:
        lock_path = pathlib.Path.home() / 'Library/Caches/ios-app-refresh/signing.lock'
        with lock_path.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

            def info(kind, label):
                path = args.out / (label + '-' + kind + '.json')
                device('info', kind, '--quiet', '--json-output', path, timeout=30)
                return json.loads(path.read_text())['result']

            before = {a['bundleIdentifier']: a for a in info('apps', 'before')['apps']}
            if BUNDLE in before:
                device('uninstall', 'app', BUNDLE, timeout=60)
            after = {a['bundleIdentifier']: a for a in info('apps', 'after')['apps']}
            assert BUNDLE not in after, 'Diagnostic app is still installed'
            assert {k: v for k, v in before.items() if k != BUNDLE} == after, 'Other installed apps changed during cleanup'
            processes = info('processes', 'after')
            assert 'OriginalVideoProbe.app/OriginalVideoProbe' not in json.dumps(processes), 'Diagnostic process is still running'
            (args.out / 'cleanup.json').write_text(json.dumps({
                'diagnosticAppRemoved': True, 'diagnosticProcessAbsent': True,
                'otherInstalledAppsUnchanged': True,
            }, indent=2))
            print('PASS cleanup: diagnostic app/process absent; other installed apps unchanged', flush=True)
        return

    assert plistlib.loads((args.app / 'Info.plist').read_bytes())['CFBundleIdentifier'] == BUNDLE, 'Never target a product app'
    run('codesign', '--verify', '--deep', '--strict', args.app)
    links = subprocess.check_output(['otool', '-L', str(args.app / 'OriginalVideoProbe')], text=True)
    if '@rpath/VLCKit.framework' in links:
        assert '@executable_path/Frameworks' in subprocess.check_output(['otool', '-l', str(args.app / 'OriginalVideoProbe')], text=True)
    if run(args.tools / 'phone-pairing', '--probe', timeout=30, check=False).returncode:
        run(args.tools / 'phone-pairing', '--repair', timeout=120)
    lock_path = pathlib.Path.home() / 'Library/Caches/ios-app-refresh/signing.lock'
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            # In-place replacement preserves the test app's TCC approval and container.
            run(args.tools / 'phone-install', '--device', args.device, args.app, timeout=180)
            if args.original_file:
                device('copy', 'to', '--domain-type', 'appDataContainer', '--domain-identifier', BUNDLE,
                       '--source', args.original_file, '--destination', 'Documents/original.mp4', timeout=180)
            launch = args.out / 'launch.json'
            device('process', 'launch', '--json-output', launch, '--terminate-existing', BUNDLE, '--',
                   '-original-url', 'probe-local' if args.original_file else args.original_url, '-probe-run', run_id,
                   '-codec', args.codec, '-duration', str(args.duration), '-filename', args.filename)
            pid = json.loads(launch.read_text())['result']['process']['processIdentifier']
            time.sleep(44)
            report_path = args.out / 'decoder-probe.json'
            for attempt in range(5):
                device('copy', 'from', '--domain-type', 'appDataContainer', '--domain-identifier', BUNDLE,
                       '--source', 'Documents/decoder-probe.json', '--destination', report_path)
                report = json.loads(report_path.read_text())
                if report.get('runID') == run_id and report.get('complete'):
                    break
                if attempt < 4:
                    time.sleep(10)
            validate(report, run_id)
            device('copy', 'from', '--domain-type', 'appDataContainer', '--domain-identifier', BUNDLE,
                   '--source', 'Documents/decoder-vlc.log', '--destination', args.out / 'decoder-vlc.log')
            print('PASS native ViewerUnit: seek, pause, return, saved clock, EOF and explicit replay', flush=True)
        finally:
            if pid is not None:
                device('process', 'terminate', '--pid', str(pid), timeout=30)
                print('Stopped test process; app retained between runs. Run --cleanup when the task is finished.', flush=True)

if __name__ == '__main__':
    main()
