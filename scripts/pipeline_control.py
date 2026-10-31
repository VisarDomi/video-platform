#!/usr/bin/env python3
"""Explicit manual control of the conversion/description/upload worker."""
from datetime import datetime, timezone
import argparse
import sys
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile


UNIT = 'video-pipeline.service'


def _regular_bytes(path):
    """Only small unchanged regular metadata can support the optional fast path."""
    try:
        before=path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or not 0<before.st_size<=65536:return None
        identity=lambda v:(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns,v.st_ctime_ns)
        descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            opened=os.fstat(descriptor)
            if identity(before)!=identity(opened):return None
            data=os.read(descriptor,65537);after=os.fstat(descriptor)
        finally:os.close(descriptor)
        current=path.lstat()
        if identity(before)!=identity(opened) or identity(before)!=identity(after) or identity(before)!=identity(current) or len(data)!=before.st_size:return None
        return data
    except OSError:return None


def _prior_pause(receipt,marker_bytes,override_bytes):
    data=_regular_bytes(receipt)
    if data is None or marker_bytes is None or override_bytes is None:return False
    try:value=json.loads(data)
    except (ValueError,UnicodeError):return False
    return type(value) is dict and set(value)=={'v','scope','service','pause_complete','marker_sha256','override_sha256'} and \
        type(value['v']) is int and value['v']==1 and value['scope']=='manual_upload_pause_completed_v1' and \
        value['service']==UNIT and value['pause_complete'] is True and \
        value['marker_sha256']==hashlib.sha256(marker_bytes).hexdigest() and \
        value['override_sha256']==hashlib.sha256(override_bytes).hexdigest()


def _loaded_hold(marker,override,marker_bytes,override_bytes):
    """Fresh manager state plus its typed, non-trigger, negated path condition."""
    try:
        keys=('LoadState','ActiveState','SubState','UnitFileState','NeedDaemonReload','Restart','ControlGroup','DropInPaths')
        result=subprocess.run(['systemctl','--user','show',UNIT,*('-p'+key for key in keys)],
                              capture_output=True,text=True,check=True,timeout=2)
        if type(result.stdout) is not str or len(result.stdout)>65536:return False
        lines=[line.split('=',1) for line in result.stdout.splitlines()]
        if any(len(row)!=2 for row in lines) or len({row[0] for row in lines})!=len(lines):return False
        values=dict(lines)
        expected={'LoadState':'loaded','ActiveState':'inactive','SubState':'dead','UnitFileState':'disabled',
                  'NeedDaemonReload':'no','Restart':'no','ControlGroup':''}
        if set(values)!=set(keys) or any(values.get(k)!=v for k,v in expected.items()) or str(override) not in values['DropInPaths'].split():return False
        result=subprocess.run(['busctl','--user','--json=short','get-property','org.freedesktop.systemd1',
            '/org/freedesktop/systemd1/unit/video_2dpipeline_2eservice','org.freedesktop.systemd1.Unit','Conditions'],
            capture_output=True,text=True,check=True,timeout=2)
        if type(result.stdout) is not str or len(result.stdout)>65536:return False
        payload=json.loads(result.stdout)
        if type(payload) is not dict or set(payload)!={'type','data'} or payload['type']!='a(sbbsi)' or type(payload['data']) is not list or not 1<=len(payload['data'])<=64:return False
        found=False
        for row in payload['data']:
            if type(row) is not list or len(row)!=5 or type(row[0]) is not str or type(row[1]) is not bool or type(row[2]) is not bool or type(row[3]) is not str or type(row[4]) is not int:return False
            if row[:4]==['ConditionPathExists',False,True,str(marker)]:found=True
        return found and _regular_bytes(marker)==marker_bytes and _regular_bytes(override)==override_bytes
    except (OSError,ValueError,UnicodeError,subprocess.SubprocessError):return False


def _record_pause(receipt,marker,override,marker_bytes,override_bytes):
    if _regular_bytes(marker)!=marker_bytes or _regular_bytes(override)!=override_bytes:
        raise RuntimeError('Upload hold changed before completion')
    private_write(receipt,json.dumps({'v':1,'scope':'manual_upload_pause_completed_v1','service':UNIT,'pause_complete':True,
        'marker_sha256':hashlib.sha256(marker_bytes).hexdigest(),'override_sha256':hashlib.sha256(override_bytes).hexdigest()},indent=2)+'\n')


def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def pause_upload_pipeline():
    home = Path.home()
    marker = home / '.local/share/video-services/pipeline/user-pause.json'
    override = home / '.config/systemd/user' / (UNIT + '.d/90-user-requested-pause.conf')
    receipt = home / '.local/share/video-services/pipeline/pause-completed.json'
    timestamp = datetime.now(timezone.utc).isoformat()
    hold = json.loads(marker.read_text()) if marker.exists() else {
        'paused_at': timestamp,
        'requested_by': 'user',
        'reason': 'Explicit manual stop of conversion, description and upload',
        'indefinite': True,
        'requires_explicit_user_resume': True,
        'preserve_media_queues_checkpoints': True,
        'services': [UNIT],
        'scope': 'Upload pipeline only; downloader, server, auth and display keep running normally.',
    }
    hold['last_manual_request_at'] = timestamp
    header = '# User-requested operational hold.'
    if override.exists() and not override.read_text().startswith(header):
        raise RuntimeError('Upload pipeline hold file belongs to another configuration: ' + str(override))
    override_text=header + ' Remove only after explicit user authorization to resume.\n' + \
                  '[Unit]\nConditionPathExists=!' + str(marker) + '\n\n[Service]\nRestart=no\n'
    prior_marker,prior_override=_regular_bytes(marker),_regular_bytes(override)
    eligible=prior_override==override_text.encode() and _prior_pause(receipt,prior_marker,prior_override)
    marker_text=json.dumps(hold,indent=2)+'\n'
    private_write(marker,marker_text)
    if eligible and _loaded_hold(marker,override,marker_text.encode(),override_text.encode()):
        _record_pause(receipt,marker,override,marker_text.encode(),override_text.encode())
        print('Upload pipeline already paused; verified hold retained.',flush=True)
        return
    private_write(override,override_text)
    systemctl = ['systemctl', '--user']
    subprocess.run([*systemctl, 'daemon-reload'], check=True, timeout=10)
    stop = [*systemctl, 'disable', '--now', UNIT]
    try:
        # Stop the whole worker cgroup now, including its encoder/descriptor/browser.
        # Do not wait for an upload or the default 90-second systemd stop timeout.
        subprocess.run(stop, check=True, timeout=1, stdout=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        subprocess.run([*systemctl, 'kill', '--kill-whom=all', '--signal=SIGKILL', UNIT],
                       check=True, timeout=5)
        subprocess.run(stop, check=True, timeout=5, stdout=subprocess.DEVNULL)
    pipeline = home / 'Documents/work/video/video-platform/packages/pipeline'
    node = home / '.nvm/versions/node/v22.19.0/bin/node'
    # Use the built CLI directly: npm would rebuild live artifacts unnecessarily.
    subprocess.run([str(node), '--no-warnings', str(pipeline / 'dist/main.js'),
                    'campaign-pause', '--apply'], cwd=pipeline, check=True,
                   timeout=10, stdout=subprocess.DEVNULL)
    _record_pause(receipt,marker,override,marker_text.encode(),override_text.encode())
    print('Upload pipeline stopped; resume explicitly with pipeline-force-start.', flush=True)


def resume_upload_pipeline():
    home = Path.home()
    override = home / '.config/systemd/user/video-pipeline.service.d/90-user-requested-pause.conf'
    if override.exists() and not override.read_text().startswith('# User-requested operational hold.'):
        raise RuntimeError('Video pause override belongs to another configuration')
    (home / '.local/share/video-services/pipeline/user-pause.json').unlink(missing_ok=True)
    override.unlink(missing_ok=True)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True, timeout=30)
    pipeline = home / 'Documents/work/video/video-platform/packages/pipeline'
    node = home / '.nvm/versions/node/v22.19.0/bin/node'
    subprocess.run([str(node), '--no-warnings', str(pipeline / 'dist/main.js'),
                    'campaign-resume', '--apply'], cwd=pipeline, check=True, timeout=30)
    subprocess.run(['systemctl', '--user', 'enable', '--now', UNIT], check=True, timeout=30)
    print('Upload pipeline started.', flush=True)


def main():
    implied = {'pipeline-force-stop': 'stop', 'pipeline-force-start': 'start'}.get(Path(sys.argv[0]).name)
    parser = argparse.ArgumentParser(description=__doc__)
    if implied is None:
        parser.add_argument('action', choices=('stop', 'start'))
    parser.add_argument('--dry-run', action='store_true', help='Describe scope without changing services or holds')
    args = parser.parse_args()
    action = implied or args.action
    if args.dry_run:
        print(f'{action}: {UNIT}; manual persistent hold; no changes made.')
    elif action == 'stop':
        pause_upload_pipeline()
    else:
        resume_upload_pipeline()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
