"""Base image download, SSH keys, the NoCloud seed, and the provisioned golden disk.

Disk chain (all qcow2, copy-on-write, base never written):

    images/<base>.qcow2            pristine download, read-only, checksum-verified
      provisioned/disk.qcow2       user, keys and packages installed; cleanly shut down
        runs/<id>/disk.qcow2       one per run; this is the disk that gets power-cut

provisioned/ also keeps the guest's kernel and initrd, so runs boot them directly.

Every step is restartable: a download resumes from its .part file, a provisioned
disk only replaces the previous one after a clean guest shutdown, and a host crash
at any point leaves either the old state or the new one.
"""

import hashlib
import json
import os
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

from common import (BASE_IMAGE, GUEST_HOSTNAME, GUEST_USER, HOST_KEY_ALIAS, IMAGES, PROVISIONED,
                    SSH_DIR, HarnessError, fsync_dir, log, require_tool, write_atomic,
                    write_json_atomic)
from vm import VM, DirectBoot, find_uefi_firmware

# Packages every workload gets. python3 is already in the image (cloud-init needs it).
BASE_PACKAGES = ["python3"]

# Run once over SSH after cloud-init finished, as root. It turns the image into a
# quiet test appliance: no timers that add I/O at random moments, no cloud-init on
# later boots, no boot menu delay, and a journal that survives reboots.
PROVISION_SCRIPT = r"""
set -eu
touch /etc/cloud/cloud-init.disabled
for unit in apt-daily.timer apt-daily-upgrade.timer man-db.timer e2scrub_all.timer \
            fstrim.timer dpkg-db-backup.timer logrotate.timer unattended-upgrades.service; do
    systemctl mask --now "$unit" >/dev/null 2>&1 || true
done
if [ -f /etc/default/grub ]; then
    sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=0/' /etc/default/grub
    update-grub >/dev/null 2>&1 || true
fi
mkdir -p /var/log/journal /opt/harness /var/lib/harness
systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
systemctl restart systemd-journald
sync
"""


# -- base image -----------------------------------------------------------------

def base_image_path() -> Path:
    return IMAGES / BASE_IMAGE["name"]


def ensure_base_image() -> Path:
    final = base_image_path()
    if final.exists():
        return final
    IMAGES.mkdir(parents=True, exist_ok=True)
    part = final.with_name(final.name + ".part")
    h = hashlib.sha512()
    have = 0
    if part.exists():
        with open(part, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
                have += len(chunk)
        log(f"resuming download at {have / 1e6:.0f} MB")
    req = urllib.request.Request(BASE_IMAGE["url"], headers={"User-Agent": "vm-harness"})
    if have:
        req.add_header("Range", f"bytes={have}-")
    log(f"downloading {BASE_IMAGE['url']}")
    with urllib.request.urlopen(req, timeout=60) as resp:
        if have and resp.status != 206:
            # Server ignored the range: start over.
            h, have = hashlib.sha512(), 0
            part.unlink()
        total = have + int(resp.headers.get("Content-Length") or 0)
        last = time.monotonic()
        with open(part, "ab") as out:
            for chunk in iter(lambda: resp.read(1 << 20), b""):
                out.write(chunk)
                h.update(chunk)
                have += len(chunk)
                if time.monotonic() - last > 5:
                    log(f"  {have / 1e6:.0f} / {total / 1e6:.0f} MB")
                    last = time.monotonic()
            out.flush()
            os.fsync(out.fileno())
    digest = h.hexdigest()
    if digest != BASE_IMAGE["sha512"]:
        part.unlink()
        raise HarnessError(f"checksum mismatch for {final.name}: got {digest}, "
                           f"expected {BASE_IMAGE['sha512']}; partial download removed")
    os.chmod(part, 0o444)
    os.replace(part, final)
    fsync_dir(IMAGES)
    log(f"base image verified (sha512 {digest[:16]}...)")
    return final


# -- keys -----------------------------------------------------------------------

def ensure_ssh_keys() -> None:
    """A client key for the harness user and a host key for the guest, both local."""
    require_tool("ssh-keygen")
    SSH_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(SSH_DIR, 0o700)
    for name, comment in (("id_ed25519", "vm-harness client"),
                          ("guest_host_ed25519", "vm-harness guest host key")):
        key = SSH_DIR / name
        if key.exists() and key.with_suffix(".pub").exists():
            continue
        for p in (key, key.with_suffix(".pub")):
            p.unlink(missing_ok=True)
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment,
                        "-f", str(key)], check=True)
    host_pub = (SSH_DIR / "guest_host_ed25519.pub").read_text().split()
    write_atomic(SSH_DIR / "known_hosts", f"{HOST_KEY_ALIAS} {host_pub[0]} {host_pub[1]}\n".encode())


# -- seed -----------------------------------------------------------------------

def user_data(packages: list[str]) -> str:
    client_pub = (SSH_DIR / "id_ed25519.pub").read_text().strip()
    cfg = {
        "hostname": GUEST_HOSTNAME,
        "manage_etc_hosts": True,
        "users": [{
            "name": GUEST_USER,
            "gecos": "power-cut harness",
            "groups": ["sudo", "systemd-journal"],
            "sudo": "ALL=(ALL) NOPASSWD:ALL",
            "shell": "/bin/bash",
            "lock_passwd": True,
            "ssh_authorized_keys": [client_pub],
        }],
        "disable_root": True,
        "ssh_pwauth": False,
        "ssh_deletekeys": True,
        "ssh_genkeytypes": [],
        "ssh_keys": {
            "ed25519_private": (SSH_DIR / "guest_host_ed25519").read_text(),
            "ed25519_public": (SSH_DIR / "guest_host_ed25519.pub").read_text().strip(),
        },
        "package_update": True,
        "packages": packages,
    }
    # JSON is valid YAML, so no YAML library is needed on the host.
    return "#cloud-config\n" + json.dumps(cfg, indent=2) + "\n"


def make_seed(dest_dir: Path, ud: str, instance_id: str) -> Path:
    """Write a NoCloud seed (volume label "cidata") with whatever tool the host has."""
    src = dest_dir / "seed"
    src.mkdir(parents=True, exist_ok=True)
    (src / "user-data").write_text(ud)
    (src / "meta-data").write_text(f"instance-id: {instance_id}\nlocal-hostname: {GUEST_HOSTNAME}\n")
    files = [str(src / "user-data"), str(src / "meta-data")]
    forced = os.environ.get("VM_HARNESS_SEED_TOOL")
    iso = dest_dir / "seed.iso"
    candidates = {
        "cloud-localds": ["cloud-localds", str(iso), *files],
        "genisoimage": ["genisoimage", "-quiet", "-output", str(iso), "-volid", "cidata",
                        "-joliet", "-rock", *files],
        "mkisofs": ["mkisofs", "-quiet", "-output", str(iso), "-volid", "cidata",
                    "-joliet", "-rock", *files],
        "xorriso": ["xorriso", "-as", "mkisofs", "-quiet", "-output", str(iso),
                    "-volid", "cidata", "-joliet", "-rock", *files],
    }
    for tool, cmd in candidates.items():
        if forced and forced != tool:
            continue
        if shutil.which(tool):
            subprocess.run(cmd, check=True, capture_output=True)
            return iso
    if (not forced or forced == "mtools") and shutil.which("mformat") and shutil.which("mcopy"):
        img = dest_dir / "seed.img"
        img.unlink(missing_ok=True)
        subprocess.run(["mformat", "-i", str(img), "-C", "-f", "1440", "-v", "CIDATA", "::"],
                       check=True, capture_output=True)
        subprocess.run(["mcopy", "-i", str(img), *files, "::"], check=True, capture_output=True)
        return img
    raise HarnessError("no tool to build the NoCloud seed: install one of genisoimage, "
                       "xorriso, cloud-image-utils (cloud-localds) or mtools")


# -- provisioned disk -----------------------------------------------------------

def qemu_img_create(disk: Path, backing: Path, size: str | None = None) -> None:
    """A copy-on-write overlay; the backing file is only ever read."""
    require_tool("qemu-img")
    cmd = ["qemu-img", "create", "-q", "-f", "qcow2", "-b", str(backing), "-F", "qcow2", str(disk)]
    if size:
        cmd.append(size)
    subprocess.run(cmd, check=True)


def provisioned_disk() -> Path:
    return PROVISIONED / "disk.qcow2"


def provisioned_stamp() -> dict | None:
    try:
        return json.loads((PROVISIONED / "stamp.json").read_text())
    except (OSError, ValueError):
        return None


def direct_boot() -> DirectBoot:
    stamp = provisioned_stamp() or {}
    return DirectBoot(PROVISIONED / "vmlinuz", PROVISIONED / "initrd.img", stamp["kernel_append"])


def wanted_stamp(packages: list[str], disk_size: str) -> dict:
    return {
        "layout": 2,  # bump when the provisioned directory's contents change
        "base_image": BASE_IMAGE["name"],
        "base_sha512": BASE_IMAGE["sha512"],
        "packages": packages,
        "disk_size": disk_size,
        "provision_script_sha256": hashlib.sha256(PROVISION_SCRIPT.encode()).hexdigest(),
        # The disk trusts these keys; new keys need a new disk.
        "keys_sha256": hashlib.sha256(b"".join(
            (SSH_DIR / n).read_bytes() for n in ("id_ed25519.pub", "guest_host_ed25519.pub")
        )).hexdigest(),
    }


def kernel_append(cmdline: str) -> str:
    """The guest's own command line minus the bootloader's and display's parts."""
    keep = [a for a in cmdline.split()
            if not a.startswith(("BOOT_IMAGE=", "console=", "earlyprintk="))]
    return " ".join(keep + ["console=ttyS0,115200"])


def prepare(packages: list[str], *, disk_size: str = "10G", force: bool = False,
            cpus: int = 2, memory_mb: int = 2048) -> Path:
    """Make sure a provisioned disk with at least `packages` exists.

    Packages only accumulate: preparing for one workload never removes what
    another workload needed."""
    base = ensure_base_image()
    ensure_ssh_keys()
    have = provisioned_stamp() or {}
    complete = all((PROVISIONED / n).exists() for n in ("disk.qcow2", "vmlinuz", "initrd.img"))
    same = {k: v for k, v in wanted_stamp([], disk_size).items() if k != "packages"}
    matches = complete and all(have.get(k) == v for k, v in same.items())
    if not force and matches and set(packages) <= set(have.get("packages", [])):
        log(f"provisioned disk is up to date ({provisioned_disk()})")
        return provisioned_disk()
    keep = have.get("packages", []) if matches else []
    packages = sorted(set(BASE_PACKAGES) | set(packages) | set(keep))
    want = wanted_stamp(packages, disk_size)

    tmp = PROVISIONED.with_name("provisioned.tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    instance_id = "vm-harness-" + hashlib.sha256(json.dumps(want).encode()).hexdigest()[:12]
    seed = make_seed(tmp, user_data(packages), instance_id)
    disk = tmp / "disk.qcow2"
    qemu_img_create(disk, base, disk_size)
    # This image only boots through UEFI, so the provisioning boot uses OVMF.
    shutil.copyfile(find_uefi_firmware()[1], tmp / "disk.qcow2.vars")

    log(f"provisioning: first boot with cloud-init (packages: {', '.join(packages)})")
    vm = VM(disk, tmp, "provision", cpus=cpus, memory_mb=memory_mb, seed_iso=seed)
    t0 = time.monotonic()
    try:
        vm.boot(timeout=900)
        r = vm.ssh("cloud-init status --wait --long", timeout=1800, check=False)
        status = r.stdout.decode(errors="replace")
        if r.returncode not in (0, 2) or "status: done" not in status:
            raise HarnessError(f"cloud-init did not finish cleanly (exit {r.returncode}):\n{status}")
        installed = vm.ssh("dpkg-query -W -f='${Package}\\n' " + " ".join(packages) +
                           " 2>/dev/null | sort", check=False).stdout.decode().split()
        if sorted(installed) != packages:
            raise HarnessError(f"packages not installed: {sorted(set(packages) - set(installed))}")
        vm.ssh("sudo sh -s", input=PROVISION_SCRIPT.encode(), timeout=600)
        facts = vm.ssh("uname -r; . /etc/os-release; echo \"$PRETTY_NAME\"; cat /proc/cmdline"
                       ).stdout.decode().split("\n")
        # Later boots skip firmware and GRUB: keep this kernel and initrd on the host.
        release = facts[0]
        for src, name in ((f"/boot/vmlinuz-{release}", "vmlinuz"),
                          (f"/boot/initrd.img-{release}", "initrd.img")):
            data = vm.ssh(f"sudo cat {src}").stdout
            if not data:
                raise HarnessError(f"could not read {src} from the guest")
            (tmp / name).write_bytes(data)
        vm.poweroff(timeout=120)
    finally:
        vm.kill_quietly()
    # The guest shut down cleanly; make everything durable on the host too.
    for name in ("disk.qcow2", "disk.qcow2.vars", "vmlinuz", "initrd.img"):
        with open(tmp / name, "rb+") as f:
            os.fsync(f.fileno())
    # The seed holds the guest's host key; it is not needed any more.
    shutil.rmtree(tmp / "seed", ignore_errors=True)
    seed.unlink(missing_ok=True)
    stamp = dict(want, kernel=facts[0], os=facts[1], kernel_append=kernel_append(facts[2]),
                 seed_tool=seed.name, provisioned_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                 provision_seconds=round(time.monotonic() - t0, 1))
    write_json_atomic(tmp / "stamp.json", stamp)
    fsync_dir(tmp)
    # Swap directories. A crash in between leaves either a complete provisioned/
    # or none (and then prepare simply provisions again); never a half-made one.
    old = PROVISIONED.with_name("provisioned.old")
    shutil.rmtree(old, ignore_errors=True)
    if PROVISIONED.exists():
        os.replace(PROVISIONED, old)
    os.replace(tmp, PROVISIONED)
    fsync_dir(PROVISIONED.parent)
    shutil.rmtree(old, ignore_errors=True)
    log(f"provisioned in {stamp['provision_seconds']}s: {stamp['os']}, kernel {stamp['kernel']}")
    return provisioned_disk()
