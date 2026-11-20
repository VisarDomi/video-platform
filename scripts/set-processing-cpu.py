#!/usr/bin/python3
"""Change the aggregate conversion CPU cap live and across reboots; no restart."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import time


def atomic(path, text):
    temporary = path.with_name(path.name+'.cpu-policy-tmp')
    path.parent.mkdir(parents=True,exist_ok=True)
    with temporary.open('w') as file:
        file.write(text);file.flush();os.fsync(file.fileno())
    temporary.replace(path)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['uncapped','50'])
    args=parser.parse_args()
    project=Path(__file__).resolve().parents[1]
    source=project/'systemd/user/video-processing.slice'
    installed=Path.home()/'.config/systemd/user/video-processing.slice'
    # systemd's CPUQuota= uses an empty assignment to reset the limit; the
    # resulting DBus CPUQuotaPerSecUSec property is reported as infinity.
    quota='' if args.mode=='uncapped' else str((os.cpu_count() or 1)*50)+'%'
    backup=Path.home()/'.local/state/video-services/processing-policy-backups'/time.strftime('%Y%m%d-%H%M%S')
    for label,path in [('source',source),('installed',installed)]:
        previous=path.read_text() if path.exists() else source.read_text()
        updated=re.sub(r'^CPUQuota=.*$', 'CPUQuota='+quota, previous, flags=re.M)
        if not re.search(r'^CPUQuota=',previous,flags=re.M):
            if '[Slice]' not in previous:
                raise RuntimeError('No Slice section in '+str(path))
            updated=previous.replace('[Slice]','[Slice]\nCPUQuota='+quota,1)
        if updated==previous:
            continue
        backup.mkdir(parents=True,exist_ok=True)
        if path.exists():shutil.copy2(path,backup/(label+'-video-processing.slice'))
        atomic(path,updated)
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    subprocess.run(['systemctl','--user','set-property','--runtime','video-processing.slice','CPUQuota='+quota],check=True)
    print(subprocess.check_output(['systemctl','--user','show','video-processing.slice','-p','CPUQuotaPerSecUSec'],text=True).strip())
    print('CPU policy applied live and saved; running conversions were not restarted.')


if __name__=='__main__':
    main()
