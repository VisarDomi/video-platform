"""One QEMU guest: boot, talk to it over SSH, and cut its power.

The guest gets user-mode networking with SSH forwarded to a free loopback port,
a virtio-serial port for acknowledgements (QEMU appends whatever the guest writes
to a host file) and its serial console logged to a host file.

"Power cut" = SIGKILL to the QEMU process. Guest RAM disappears at once: the
guest's page cache, the work in flight in its block layer, and QEMU's own
in-memory state (for example qcow2 metadata it has not written yet). Whatever
QEMU had already handed to the host kernel stays. See README.md, "Fidelity".
"""

import ctypes
import glob
import io
import json
import os
import shlex
import shutil
import signal
import socket
import subprocess
import tarfile
import time
from pathlib import Path

from common import (ACK_PORT_NAME, GUEST_USER, HOST_KEY_ALIAS, OUT_PORT_NAME, RESERVED_PORTS,
                    SSH_DIR, HarnessError, log)

CACHE_MODES = ("writeback", "unsafe", "none", "directsync", "writethrough")

_PR_SET_PDEATHSIG = 1


def _child_setup() -> None:
    """Runs in the forked child before exec: die with the harness, never orphan."""
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(_PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
    except OSError:
        pass
    os.setpgrp()  # keep Ctrl-C in the terminal from reaching QEMU directly


def free_port() -> int:
    for _ in range(50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in RESERVED_PORTS:
            return port
    raise HarnessError("could not find a free loopback port")


def ssh_base_args(port: int) -> list[str]:
    return [
        "ssh", "-q",
        "-i", str(SSH_DIR / "id_ed25519"),
        "-p", str(port),
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        # The guest's host key is generated on the host at prepare time and
        # injected through cloud-init, so it is pinned from the very first boot.
        "-o", f"HostKeyAlias={HOST_KEY_ALIAS}",
        "-o", f"UserKnownHostsFile={SSH_DIR / 'known_hosts'}",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "HostKeyAlgorithms=ssh-ed25519",
        "-o", "ConnectTimeout=5",
        "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=3",
        f"{GUEST_USER}@127.0.0.1",
    ]


def find_uefi_firmware() -> tuple[Path, Path]:
    """(code, vars template) of a plain x86_64 UEFI build (no secure boot, no SMM).

    The Debian cloud image boots through UEFI; its legacy BIOS path does not boot.
    Uses QEMU's firmware descriptors, then common distro paths. Override with
    VM_HARNESS_UEFI_CODE and VM_HARNESS_UEFI_VARS.
    """
    code, vars_ = os.environ.get("VM_HARNESS_UEFI_CODE"), os.environ.get("VM_HARNESS_UEFI_VARS")
    if code and vars_:
        return Path(code), Path(vars_)
    unwanted = {"secure-boot", "requires-smm", "enrolled-keys"}
    descriptors = []
    for d in ("/etc/qemu/firmware", "/usr/share/qemu/firmware",
              os.path.expanduser("~/.config/qemu/firmware")):
        descriptors += glob.glob(os.path.join(d, "*.json"))
    for path in sorted(descriptors, key=os.path.basename):
        try:
            j = json.loads(Path(path).read_text())
            m = j["mapping"]
            if ("uefi" in j["interface-types"] and m.get("device") == "flash"
                    and not unwanted & set(j.get("features", []))
                    and any(t["architecture"] == "x86_64" and
                            any("q35" in mach for mach in t.get("machines", []))
                            for t in j["targets"])
                    and "nvram-template" in m):
                code, vars_ = Path(m["executable"]["filename"]), Path(m["nvram-template"]["filename"])
                if code.exists() and vars_.exists():
                    return code, vars_
        except (OSError, ValueError, KeyError, TypeError):
            continue
    for code, vars_ in (("/usr/share/OVMF/OVMF_CODE_4M.fd", "/usr/share/OVMF/OVMF_VARS_4M.fd"),
                        ("/usr/share/OVMF/OVMF_CODE.fd", "/usr/share/OVMF/OVMF_VARS.fd"),
                        ("/usr/share/edk2/ovmf/OVMF_CODE.fd", "/usr/share/edk2/ovmf/OVMF_VARS.fd"),
                        ("/usr/share/edk2/x64/OVMF_CODE.4m.fd", "/usr/share/edk2/x64/OVMF_VARS.4m.fd")):
        if os.path.exists(code) and os.path.exists(vars_):
            return Path(code), Path(vars_)
    raise HarnessError("no UEFI firmware for QEMU found; install OVMF (package ovmf or "
                       "edk2-ovmf) or set VM_HARNESS_UEFI_CODE and VM_HARNESS_UEFI_VARS")


class DirectBoot:
    """Boot a kernel and initrd taken from the provisioned disk, skipping firmware
    and GRUB: about 5 s faster per boot. Captured by `prepare`."""

    def __init__(self, kernel: Path, initrd: Path, append: str):
        self.kernel, self.initrd, self.append = kernel, initrd, append


class VM:
    def __init__(self, disk: Path, workdir: Path, label: str, *, cpus: int = 2,
                 memory_mb: int = 2048, cache: str = "writeback",
                 direct: DirectBoot | None = None, seed_iso: Path | None = None):
        """Boots `direct` if given, otherwise UEFI with the variable store kept
        beside the disk as `<disk>.vars`."""
        if cache not in CACHE_MODES:
            raise HarnessError(f"unknown cache mode {cache!r}; use one of {CACHE_MODES}")
        self.disk = disk
        self.direct = direct
        if not direct:
            self.uefi_code, _ = find_uefi_firmware()
            self.uefi_vars = disk.with_name(disk.name + ".vars")
            if not self.uefi_vars.exists():
                raise HarnessError(f"missing UEFI variable store {self.uefi_vars}")
        self.workdir = workdir
        self.label = label
        self.cpus = cpus
        self.memory_mb = memory_mb
        self.cache = cache
        self.seed_iso = seed_iso
        self.proc: subprocess.Popen | None = None
        self.port: int | None = None
        self.ack_path = workdir / f"{label}.ack"
        self.out_path = workdir / f"{label}.out"
        self.console_path = workdir / f"{label}.console"
        self.started_at: float | None = None

    # -- lifecycle -----------------------------------------------------------

    def command(self) -> list[str]:
        cmd = [
            "nice", "-n", "10",
            "qemu-system-x86_64",
            "-name", f"vm-harness-{self.label}",
            "-machine", "q35,accel=kvm",
            "-cpu", "host",
            "-smp", str(self.cpus),
            "-m", str(self.memory_mb),
            "-nodefaults", "-no-user-config",
            "-display", "none",
        ]
        if self.direct:
            cmd += ["-kernel", str(self.direct.kernel), "-initrd", str(self.direct.initrd),
                    "-append", self.direct.append]
        else:
            cmd += ["-drive", f"if=pflash,format=raw,unit=0,readonly=on,file={self.uefi_code}",
                    "-drive", f"if=pflash,format=raw,unit=1,file={self.uefi_vars}"]
        cmd += [
            # The disk under test. The cache mode decides what a power cut can lose;
            # see README.md, "Fidelity".
            "-drive", f"file={self.disk},if=none,id=disk0,format=qcow2,cache={self.cache}",
            "-device", "virtio-blk-pci,drive=disk0" + ("" if self.direct else ",bootindex=0"),
            "-netdev", f"user,id=net0,hostfwd=tcp:127.0.0.1:{self.port}-:22",
            "-device", "virtio-net-pci,netdev=net0,romfile=",
            "-object", "rng-random,id=rng0,filename=/dev/urandom",
            "-device", "virtio-rng-pci,rng=rng0",
            # Host-visible channels: QEMU writes what the guest sends straight into
            # host files, so they survive the cut. One opener per port at a time.
            "-device", "virtio-serial-pci,id=vser0",
            "-chardev", f"file,id=ack0,path={self.ack_path}",
            "-device", f"virtserialport,bus=vser0.0,chardev=ack0,name={ACK_PORT_NAME}",
            "-chardev", f"file,id=out0,path={self.out_path}",
            "-device", f"virtserialport,bus=vser0.0,chardev=out0,name={OUT_PORT_NAME}",
            "-chardev", f"file,id=con0,path={self.console_path}",
            "-serial", "chardev:con0",
        ]
        if self.seed_iso:
            cmd += ["-drive", f"file={self.seed_iso},if=virtio,format=raw,readonly=on"]
        return cmd

    def start(self) -> None:
        if self.proc is not None:
            raise HarnessError("VM already started")
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.port = free_port()
        cmd = self.command()
        if os.environ.get("VM_HARNESS_IONICE", "1") == "1" and shutil.which("ionice"):
            # Lowest best-effort I/O priority: the host's own services win.
            cmd = ["ionice", "-c", "2", "-n", "7"] + cmd
        stderr = open(self.workdir / f"{self.label}.qemu.log", "wb")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=stderr,
                                     stderr=subprocess.STDOUT, preexec_fn=_child_setup)
        stderr.close()
        self.started_at = time.monotonic()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def power_cut(self) -> float:
        """SIGKILL QEMU. Returns the monotonic time of the kill."""
        if not self.proc:
            raise HarnessError("VM not running")
        t = time.monotonic()
        try:
            self.proc.send_signal(signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.proc.wait()
        self.proc = None
        return t

    def poweroff(self, timeout: float = 60.0) -> None:
        """Clean shutdown from inside the guest; falls back to a power cut."""
        if not self.alive():
            self.proc = None
            return
        try:
            self.ssh("sudo systemctl poweroff", timeout=15, check=False)
        except subprocess.TimeoutExpired:
            pass
        try:
            self.proc.wait(timeout=timeout)
            self.proc = None
        except subprocess.TimeoutExpired:
            log(f"{self.label}: guest did not power off in {timeout:.0f}s, killing")
            self.power_cut()

    def kill_quietly(self) -> None:
        if self.alive():
            self.power_cut()
        self.proc = None

    # -- SSH -----------------------------------------------------------------

    def boot(self, timeout: float = 180.0) -> float:
        """start() + wait_ssh(), retrying if another process took the SSH port
        between choosing it and QEMU binding it."""
        for attempt in range(3):
            self.start()
            try:
                return self.wait_ssh(timeout)
            except HarnessError:
                log_text = (self.workdir / f"{self.label}.qemu.log").read_text(errors="replace")
                self.kill_quietly()
                if "host forwarding" not in log_text or attempt == 2:
                    raise
        raise AssertionError("unreachable")

    def wait_ssh(self, timeout: float = 180.0) -> float:
        """Block until the guest answers on SSH. Returns seconds since start()."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.alive():
                raise HarnessError(f"QEMU exited during boot; see {self.workdir}/{self.label}.qemu.log "
                                   f"and {self.console_path}")
            try:
                r = subprocess.run(ssh_base_args(self.port) + ["true"], stdin=subprocess.DEVNULL,
                                   capture_output=True, timeout=10)
                if r.returncode == 0:
                    return time.monotonic() - self.started_at
            except subprocess.TimeoutExpired:
                pass
            time.sleep(0.25)
        raise HarnessError(f"guest did not answer on SSH within {timeout:.0f}s; "
                           f"see {self.console_path}")

    def ssh(self, command: str, *, input: bytes | None = None, timeout: float = 120,
            check: bool = True) -> subprocess.CompletedProcess:
        r = subprocess.run(ssh_base_args(self.port) + [command], input=input,
                           stdin=None if input is not None else subprocess.DEVNULL,
                           capture_output=True, timeout=timeout)
        if check and r.returncode != 0:
            raise HarnessError(f"guest command failed ({r.returncode}): {command}\n"
                               f"{r.stderr.decode(errors='replace')[-2000:]}")
        return r

    def put_tree(self, files: dict[str, Path], dest: str) -> None:
        """Copy host files into a fresh guest directory (as root)."""
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for name, path in sorted(files.items()):
                tar.add(str(path), arcname=name, recursive=True, filter=_skip_junk)
        q = shlex.quote(dest)
        self.ssh(f"sudo rm -rf {q} && sudo mkdir -p {q} && sudo tar -C {q} -xf - "
                 f"--no-same-owner && sudo chown -R root:root {q}",
                 input=buf.getvalue())

    # -- acknowledgements ----------------------------------------------------

    def ack_lines(self) -> list[str]:
        """Complete lines the guest wrote to the ack port during this boot."""
        if not self.ack_path.exists():
            return []
        data = self.ack_path.read_bytes()
        # A line without its newline was cut mid-write; it was never acknowledged.
        complete = data[: data.rfind(b"\n") + 1]
        return [ln for ln in complete.decode(errors="replace").split("\n") if ln]


def _skip_junk(info: tarfile.TarInfo):
    base = os.path.basename(info.name)
    return None if base == "__pycache__" or base.startswith(".") else info
