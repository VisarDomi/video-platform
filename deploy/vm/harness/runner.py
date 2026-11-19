"""The power-cut loop.

    boot 0: copy the workload in, run its setup, sync
    cycle c = 1..N:
        start the workload's run command as a systemd unit   (in boot c-1)
        wait delay_c milliseconds                              (seeded)
        SIGKILL QEMU                                           (the power cut)
        boot c, run the workload's check with this cycle's acknowledgements on stdin
        append one JSON line to results.jsonl

The schedule (every delay and every per-cycle workload seed) is derived from the
run seed before the first boot, so the same seed replays the same cuts, as far as
the timing of a real machine allows.
"""

import json
import random
import shlex
import signal
import subprocess
import time
from pathlib import Path

from common import (GUEST_ACK_PATH, GUEST_DATA_DIR, GUEST_OUT_PATH, GUEST_WORKLOAD_DIR, RUNS,
                    HarnessError, append_jsonl, log, read_jsonl, write_atomic, write_json_atomic)
from image import direct_boot, provisioned_disk, provisioned_stamp, qemu_img_create
from vm import VM
from workload import Workload

UNIT = "harness-workload"


def schedule(seed: int, cycles: int, min_ms: int, max_ms: int) -> list[dict]:
    rng = random.Random(f"vm-harness:{seed}")
    return [{"cycle": c, "delay_ms": rng.randint(min_ms, max_ms),
             "cycle_seed": rng.getrandbits(32)} for c in range(1, cycles + 1)]


def guest_env(cycle: int, cycle_seed: int) -> dict:
    return {
        "HARNESS_CYCLE": str(cycle),
        "HARNESS_SEED": str(cycle_seed),
        "HARNESS_DATA": GUEST_DATA_DIR,
        "HARNESS_ACK": GUEST_ACK_PATH,
        "HARNESS_WORKLOAD": GUEST_WORKLOAD_DIR,
    }


def root_sh(env: dict, command: str) -> str:
    """A guest command line running `command` as root in the workload directory."""
    assigns = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
    script = f"cd {GUEST_WORKLOAD_DIR} && {command}"
    return f"sudo env {assigns} /bin/sh -c {shlex.quote(script)}"


def start_unit(vm: VM, wl: Workload, env: dict) -> None:
    """Start the run command as a transient system unit; returns once it has exec'd.

    Transient units do not come back after a reboot, so the workload never runs
    again behind the check's back. Its stdout and stderr go to a virtio-serial
    port, so the host keeps them even though the guest's own journal loses its
    last minutes in the cut.
    """
    setenv = " ".join(f"--setenv={k}={shlex.quote(v)}" for k, v in env.items())
    vm.ssh(f"sudo systemd-run --quiet --collect --unit={UNIT} -p Type=exec "
           f"-p StandardOutput=file:{GUEST_OUT_PATH} -p StandardError=inherit "
           f"--working-directory={GUEST_WORKLOAD_DIR} {setenv} "
           f"/bin/sh -c {shlex.quote(wl.run)}", timeout=30)


def run_check(vm: VM, wl: Workload, env: dict, acks: list[str]) -> tuple[str, dict]:
    stdin = "".join(a + "\n" for a in acks).encode()
    try:
        r = vm.ssh(root_sh(env, wl.check), input=stdin, timeout=wl.check_timeout_s, check=False)
    except subprocess.TimeoutExpired:
        return "error", {"error": f"check timed out after {wl.check_timeout_s:.0f}s"}
    out = r.stdout.decode(errors="replace").strip().splitlines()
    evidence = None
    if out:
        try:
            evidence = json.loads(out[-1])
        except ValueError:
            pass
    if not isinstance(evidence, dict):
        evidence = {"stdout": "\n".join(out[-20:])}
    if r.returncode == 0:
        return "pass", evidence
    if r.returncode == 1:
        return "fail", evidence
    evidence["error"] = f"check exited {r.returncode}"
    evidence["stderr"] = r.stderr.decode(errors="replace")[-2000:]
    return "error", evidence


GUEST_FACTS = r"""
echo "kernel=$(uname -r)"
echo "write_cache=$(cat /sys/block/vda/queue/write_cache)"
echo "root_mount=$(findmnt -no FSTYPE,OPTIONS /)"
for k in dirty_expire_centisecs dirty_writeback_centisecs dirty_ratio dirty_background_ratio \
         dirty_bytes dirty_background_bytes; do echo "vm.$k=$(cat /proc/sys/vm/$k)"; done
"""


def guest_facts(vm: VM) -> dict:
    facts = {}
    for line in vm.ssh("sh -s", input=GUEST_FACTS.encode()).stdout.decode().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            facts[k] = v
    return facts


def boot(run_dir: Path, disk: Path, index: int, opts: dict) -> tuple[VM, float]:
    vm = VM(disk, run_dir / "boots", f"boot-{index:03d}", cpus=opts["cpus"],
            memory_mb=opts["memory_mb"], cache=opts["cache"], direct=direct_boot())
    try:
        return vm, vm.boot(timeout=opts["boot_timeout_s"])
    except BaseException:
        vm.kill_quietly()
        raise


def first_and_last(path: Path, last: int = 2) -> list[str]:
    """The first line of a workload's output and its last few, shortened."""
    try:
        lines = path.read_bytes().decode(errors="replace").splitlines()
    except OSError:
        return []
    if len(lines) > last + 1:
        lines = lines[:1] + lines[-last:]
    return [ln[:200] for ln in lines]


class _Terminate(Exception):
    pass


def _on_sigterm(signum, frame):
    raise _Terminate()


def run(wl: Workload, *, cycles: int, seed: int, min_ms: int, max_ms: int,
        cache: str = "writeback", cpus: int = 2, memory_mb: int = 2048,
        out: Path | None = None, keep_disk: bool = False,
        boot_timeout_s: float = 180) -> dict:
    if min_ms < 0 or max_ms < min_ms:
        raise HarnessError("need 0 <= --min-ms <= --max-ms")
    stamp = provisioned_stamp()
    if not stamp or not provisioned_disk().exists():
        raise HarnessError("no provisioned disk; run `harness prepare` first")
    missing = sorted(set(wl.packages) - set(stamp.get("packages", [])))
    if missing:
        raise HarnessError(f"provisioned disk lacks {missing}; run `harness prepare --workload {wl.root}`")

    run_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{wl.name}-s{seed}"
    run_dir = (out or RUNS / run_id).resolve()
    if run_dir.exists() and any(run_dir.iterdir()):
        raise HarnessError(f"{run_dir} is not empty")
    for sub in ("boots", "acks"):
        (run_dir / sub).mkdir(parents=True, exist_ok=True)
    disk = run_dir / "disk.qcow2"
    qemu_img_create(disk, provisioned_disk())

    plan = schedule(seed, cycles, min_ms, max_ms)
    opts = {"cpus": cpus, "memory_mb": memory_mb, "cache": cache, "boot_timeout_s": boot_timeout_s}
    qemu_version = subprocess.run(["qemu-system-x86_64", "--version"], capture_output=True,
                                  text=True).stdout.splitlines()[0]
    meta = {
        "run": run_id, "workload": wl.name, "workload_description": wl.description,
        "seed": seed, "cycles": cycles, "min_ms": min_ms, "max_ms": max_ms,
        "cache": cache, "cpus": cpus, "memory_mb": memory_mb, "qemu": qemu_version,
        "base_image": stamp.get("base_image"), "guest_os": stamp.get("os"),
        "schedule": plan, "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    write_json_atomic(run_dir / "run.json", meta)
    results = run_dir / "results.jsonl"
    log(f"run {run_id}: {cycles} cycles, seed {seed}, delays {min_ms}-{max_ms} ms, "
        f"cache={cache}\n    results: {results}")

    old_handler = signal.signal(signal.SIGTERM, _on_sigterm)
    vm = None
    aborted = None
    try:
        vm, boot_s = boot(run_dir, disk, 0, opts)
        log(f"boot 0 up in {boot_s:.1f}s; installing workload {wl.name}")
        vm.ssh(f"sudo mkdir -p {GUEST_DATA_DIR}")
        vm.put_tree(wl.files(), GUEST_WORKLOAD_DIR)
        if wl.setup:
            r = vm.ssh(root_sh(guest_env(0, seed), wl.setup), timeout=wl.setup_timeout_s,
                       check=False)
            if r.returncode != 0:
                raise HarnessError(f"workload setup failed ({r.returncode}):\n"
                                   f"{(r.stdout + r.stderr).decode(errors='replace')[-2000:]}")
        # The workload's own files must survive the first cut.
        vm.ssh("sync")
        meta["guest"] = guest_facts(vm)
        write_json_atomic(run_dir / "run.json", meta)

        for step in plan:
            c = step["cycle"]
            env = guest_env(c, step["cycle_seed"])
            t_cycle = time.monotonic()
            start_unit(vm, wl, env)
            t_start = time.monotonic()
            time.sleep(max(0.0, t_start + step["delay_ms"] / 1000 - time.monotonic()))
            t_cut = vm.power_cut()
            acks = vm.ack_lines()
            write_atomic(run_dir / "acks" / f"cycle-{c:03d}.txt",
                         "".join(a + "\n" for a in acks).encode())

            vm, boot_s = boot(run_dir, disk, c, opts)
            t_check = time.monotonic()
            verdict, evidence = run_check(vm, wl, env, acks)
            check_s = time.monotonic() - t_check
            # What the guest kernel said about the filesystem it found after the cut.
            fs_log = vm.ssh("journalctl -k -b 0 -o cat --no-pager | grep -E 'EXT4-fs|I/O error' "
                            "| grep -vE 'mounted filesystem|re-mounted|resizing' | head -n 10",
                            check=False).stdout.decode(errors="replace").splitlines()
            row = {
                "run": run_id, "workload": wl.name, "cycle": c, "seed": seed,
                "cycle_seed": step["cycle_seed"], "delay_ms": step["delay_ms"],
                "cut_after_ms": round((t_cut - t_start) * 1000, 1), "acks": len(acks),
                "verdict": verdict, "evidence": evidence, "guest_fs_log": fs_log,
                "workload_out": first_and_last(run_dir / "boots" / f"boot-{c - 1:03d}.out"),
                "boot_s": round(boot_s, 2), "check_s": round(check_s, 2),
                "cycle_s": round(time.monotonic() - t_cycle, 2),
            }
            append_jsonl(results, row)
            log(f"cycle {c}/{cycles}: cut at {row['cut_after_ms']:.0f} ms, {len(acks)} acks, "
                f"{verdict.upper()}  (boot {boot_s:.1f}s, cycle {row['cycle_s']:.1f}s)"
                + ("" if verdict == "pass" else f"\n    {json.dumps(evidence)[:400]}"))
        vm.poweroff()
    except _Terminate:
        aborted = "terminated"
        log("terminated; cutting the guest and keeping partial results")
    except (HarnessError, subprocess.TimeoutExpired) as e:
        # A boot that never comes up, a guest command that hangs: the run stops,
        # but the cycles already done are still results.
        aborted = str(e).splitlines()[0][:300]
        log(f"run aborted: {e}")
    finally:
        signal.signal(signal.SIGTERM, old_handler)
        if vm is not None:
            vm.kill_quietly()

    summary = summarize(read_jsonl(results), meta)
    if aborted:
        summary["aborted"] = aborted
    write_json_atomic(run_dir / "summary.json", summary)
    if not keep_disk and not aborted:  # an aborted run's disk is worth a look
        disk.unlink(missing_ok=True)
    return summary


def summarize(rows: list[dict], meta: dict | None = None) -> dict:
    n = len(rows)
    count = {v: sum(1 for r in rows if r.get("verdict") == v) for v in ("pass", "fail", "error")}
    mean = (lambda key: round(sum(r[key] for r in rows) / n, 2) if n else None)
    out = {"cycles_done": n, **count, "mean_cycle_s": mean("cycle_s"),
           "mean_boot_s": mean("boot_s"), "mean_acks": mean("acks"),
           "failed_cycles": [r["cycle"] for r in rows if r.get("verdict") != "pass"]}
    if meta:
        out.update({k: meta[k] for k in ("run", "workload", "seed", "cycles", "min_ms", "max_ms",
                                         "cache") if k in meta})
        out["complete"] = n == meta.get("cycles")
    return out
