#!/usr/bin/env python3
"""Run the isolated native codec check on a phone; retain its app/data/permission."""
import argparse, fcntl, json, pathlib, plistlib, subprocess, time, uuid

BUNDLE = 'com.visar.OriginalVideoProbe.paid'

def validate(report, run_id):
    assert report.get('runID') == run_id and report.get('complete'), 'Stale or incomplete native check'
    assert report.get('transportReady'), 'Allow Local Network for Original video check, then retry in place'
    samples = {r['second']: r for r in report['samples']}
    raw = lambda n: samples[n].get('nativeTime', -1)
    assert samples[2]['rate'] == 0 and samples[2]['unitTime'] < .2, 'Paused neighbour advanced'
    assert samples[8]['displayedVideoFrames'] > 20, 'Original AV1 picture missing'
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=pathlib.Path, required=True)
    parser.add_argument('--device', required=True)
    parser.add_argument('--original-url', required=True)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--tools', type=pathlib.Path, default=pathlib.Path.home() / 'Developer/ios-tools/native/scripts')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    assert plistlib.loads((args.app / 'Info.plist').read_bytes())['CFBundleIdentifier'] == BUNDLE, 'Never target a product app'
    run_id = str(uuid.uuid4())
    pid = None

    def run(*command, timeout=90, check=True):
        return subprocess.run(list(map(str, command)), check=check, timeout=timeout)

    def device(*command, timeout=60):
        return run(args.tools / 'apple-tool', 'devicectl', 'device', *command[:2], '--device', args.device,
                   '--timeout', str(timeout), *command[2:], timeout=timeout + 10)

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
            launch = args.out / 'launch.json'
            device('process', 'launch', '--json-output', launch, '--terminate-existing', BUNDLE, '--',
                   '-original-url', args.original_url, '-probe-run', run_id)
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
                print('Stopped test process; retained app, data and Local Network permission', flush=True)

if __name__ == '__main__':
    main()
