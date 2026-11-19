"""Paths, logging and crash-safe file helpers shared by the harness modules.

Everything the harness keeps between invocations lives under the cache directory
(default ~/.cache/vm-harness, override with VM_HARNESS_CACHE). Nothing is written
into the repository.
"""

import json
import os
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent          # deploy/vm/harness
VM_DIR = HERE.parent                             # deploy/vm
WORKLOADS_DIR = VM_DIR / "workloads"

CACHE = Path(os.environ.get("VM_HARNESS_CACHE", Path.home() / ".cache" / "vm-harness"))
IMAGES = CACHE / "images"
SSH_DIR = CACHE / "ssh"
PROVISIONED = CACHE / "provisioned"
RUNS = CACHE / "runs"

# Debian 13 (trixie) generic cloud image, pinned to a dated build so a run is
# repeatable. The SHA-512 below is the one Debian published in SHA512SUMS next to
# the image; the harness refuses an image whose hash differs. Dated builds stay
# on cloud.debian.org for a long time; to move on, change all three values.
BASE_IMAGE = {
    "name": "debian-13-genericcloud-amd64-20261116-2664.qcow2",
    "url": "https://cloud.debian.org/images/cloud/trixie/20261116-2664/"
           "debian-13-genericcloud-amd64-20261116-2664.qcow2",
    "sha512": "37cb32b320820417eb04b335afcf489bfb4cecce4a957190d09cb2bffbe02b56"
              "a1cadd62d78c6ead92aa7839d5ea65e4260f994bbb4b54490df59fdf11ee1d97",
}

GUEST_USER = "harness"
GUEST_HOSTNAME = "vm-harness"
GUEST_WORKLOAD_DIR = "/opt/harness/workload"
GUEST_DATA_DIR = "/var/lib/harness/data"
ACK_PORT_NAME = "harness.ack"
GUEST_ACK_PATH = f"/dev/virtio-ports/{ACK_PORT_NAME}"
OUT_PORT_NAME = "harness.out"   # the workload's stdout and stderr
GUEST_OUT_PATH = f"/dev/virtio-ports/{OUT_PORT_NAME}"
HOST_KEY_ALIAS = "vm-harness-guest"

# Host ports the harness must never forward to (other services on this host).
RESERVED_PORTS = {9998, 9999, 8791}


class HarnessError(Exception):
    """A failure the harness reports without a traceback."""


def log(msg: str) -> None:
    stamp = time.strftime("%H:%M:%S")
    print(f"[{stamp}] {msg}", file=sys.stderr, flush=True)


def fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_atomic(path: Path, data: bytes) -> None:
    """Replace `path` so that after a crash it holds either the old or the new bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fsync_dir(path.parent)


def write_json_atomic(path: Path, obj) -> None:
    write_atomic(path, (json.dumps(obj, indent=2, sort_keys=True) + "\n").encode())


def append_jsonl(path: Path, obj) -> None:
    """Append one line and make it durable before returning."""
    line = (json.dumps(obj, sort_keys=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line)
        os.fsync(fd)
    finally:
        os.close(fd)


def read_jsonl(path: Path) -> list:
    """Read a JSONL file, ignoring a torn last line (a crash mid-append)."""
    rows = []
    if not path.exists():
        return rows
    for raw in path.read_bytes().split(b"\n"):
        if not raw.strip():
            continue
        try:
            rows.append(json.loads(raw))
        except ValueError:
            pass
    return rows


def require_tool(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise HarnessError(f"required tool not found on PATH: {name}")
    return found


def kvm_problem() -> str | None:
    """Why KVM-accelerated QEMU cannot run here, or None if it can."""
    if not os.path.exists("/dev/kvm"):
        return "/dev/kvm does not exist"
    if not os.access("/dev/kvm", os.R_OK | os.W_OK):
        return "/dev/kvm is not readable and writable by this user"
    for tool in ("qemu-system-x86_64", "qemu-img", "ssh", "ssh-keygen"):
        if not shutil.which(tool):
            return f"{tool} is not installed"
    return None
