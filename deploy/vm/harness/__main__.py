"""Power-cut test harness: run a workload in a VM, cut its power, check invariants.

    python3 deploy/vm/harness prepare [--workload DIR ...]
    python3 deploy/vm/harness run --workload DIR --cycles N --seed S [--min-ms A --max-ms B]
    python3 deploy/vm/harness report RUN_DIR ...
    python3 deploy/vm/harness smoke

See deploy/vm/README.md.
"""

import argparse
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True

import image  # noqa: E402
import runner  # noqa: E402
import workload  # noqa: E402
from common import CACHE, RUNS, HarnessError, kvm_problem, log, read_jsonl  # noqa: E402
from vm import CACHE_MODES  # noqa: E402


def add_vm_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--cpus", type=int, default=2)
    p.add_argument("--memory-mb", type=int, default=2048)


def cmd_prepare(args) -> int:
    wls = [workload.load(w) for w in args.workload] if args.workload else workload.all_workloads()
    packages = sorted({p for wl in wls for p in wl.packages})
    image.prepare(packages, disk_size=args.disk_size, force=args.force, cpus=args.cpus,
                  memory_mb=args.memory_mb)
    return 0


def cmd_run(args) -> int:
    wl = workload.load(args.workload)
    summary = runner.run(wl, cycles=args.cycles, seed=args.seed, min_ms=args.min_ms,
                         max_ms=args.max_ms, cache=args.cache, cpus=args.cpus,
                         memory_mb=args.memory_mb, out=args.out, keep_disk=args.keep_disk)
    print_table([summary])
    return 0 if summary["fail"] == 0 and summary["error"] == 0 and summary["complete"] else 1


def print_table(summaries: list[dict]) -> None:
    print("| workload | cycles | pass | fail | error | mean cycle (s) | mean boot (s) | mean acks |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|")
    for s in summaries:
        print(f"| {s.get('workload', '?')} | {s['cycles_done']} | {s['pass']} | {s['fail']} | "
              f"{s['error']} | {s['mean_cycle_s']} | {s['mean_boot_s']} | {s['mean_acks']} |")


def cmd_report(args) -> int:
    import json
    summaries = []
    for d in args.run_dir:
        d = Path(d)
        meta = json.loads((d / "run.json").read_text()) if (d / "run.json").exists() else None
        summaries.append(runner.summarize(read_jsonl(d / "results.jsonl"), meta))
    print_table(summaries)
    return 0


def cmd_smoke(args) -> int:
    problem = kvm_problem()
    if problem:
        print(f"SKIP: {problem}")
        return 0
    wl = workload.load("journal-careful")
    image.prepare(sorted(wl.packages))
    RUNS.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix="smoke-", dir=RUNS))
    summary = runner.run(wl, cycles=1, seed=args.seed, min_ms=1500, max_ms=2500, out=out)
    ok = summary["pass"] == 1
    print(f"{'PASS' if ok else 'FAIL'}: smoke, 1 cycle of {wl.name}, results in {out}")
    return 0 if ok else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="harness", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("prepare", help="download, verify and provision the guest image")
    p.add_argument("--workload", action="append", default=[],
                   help="workload whose packages to install (default: all under workloads/)")
    p.add_argument("--disk-size", default="10G")
    p.add_argument("--force", action="store_true", help="provision again even if up to date")
    add_vm_args(p)
    p.set_defaults(func=cmd_prepare)

    p = sub.add_parser("run", help="power-cut a workload N times")
    p.add_argument("--workload", required=True, help="directory, or a name under workloads/")
    p.add_argument("--cycles", type=int, required=True)
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--min-ms", type=int, default=500, help="shortest delay before the cut")
    p.add_argument("--max-ms", type=int, default=5000, help="longest delay before the cut")
    p.add_argument("--cache", choices=CACHE_MODES, default="writeback",
                   help="QEMU disk cache mode (see README, Fidelity)")
    p.add_argument("--out", type=Path, help=f"run directory (default: {RUNS}/<id>)")
    p.add_argument("--keep-disk", action="store_true", help="keep the run's disk for inspection")
    add_vm_args(p)
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("report", help="summarize run directories as a table")
    p.add_argument("run_dir", nargs="+")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("smoke", help="one cycle of journal-careful; skips without KVM")
    p.add_argument("--seed", type=int, default=1)
    p.set_defaults(func=cmd_smoke)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except HarnessError as e:
        log(f"error: {e}")
        return 2
    except KeyboardInterrupt:
        log("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
