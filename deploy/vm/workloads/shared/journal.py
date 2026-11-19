#!/usr/bin/env python3
"""Reference workload: an append-only journal plus a state file that is replaced
over and over, written either carefully or carelessly.

    journal.py setup              create the data directory, journal and first state
    journal.py run --mode MODE    append records and replace the state until killed
    journal.py check              verify acknowledged records (stdin) and the state file

`run` has two writers sharing the filesystem, as the components of a service do:
the main thread appends records to the journal, and a second thread keeps
replacing the state file (about 256 KB of JSON). The two modes differ in exactly
two places, both marked "THE DIFFERENCE":

    careful    record: write, fsync, then acknowledge
               state:  write a temp file, fsync it, rename over, fsync the directory
    careless   record: write, acknowledge, then fsync
               state:  truncate the file and rewrite it in place

An acknowledgement is one line "<cycle> <seq> <sha256>" written to the harness's
ack port ($HARNESS_ACK); the host keeps it outside the guest. After the power cut
and the reboot, `check` reads the cycle's acknowledgements on stdin and requires:

  1. every acknowledged record is in the journal, with the acknowledged checksum;
  2. the state file is complete: non-empty, parseable, and its checksum matches.

Exit status: 0 pass, 1 fail. The last stdout line is a JSON object of evidence.
Uses only the Python standard library; runs on the host too for testing.
"""

import argparse
import base64
import hashlib
import json
import os
import random
import sys
import threading
import time

DATA = os.environ.get("HARNESS_DATA", "/var/lib/harness/data")
JOURNAL = os.path.join(DATA, "journal.log")
STATE = os.path.join(DATA, "state.json")


# -- records ----------------------------------------------------------------------

def record_digest(cycle: int, seq: int, payload: bytes) -> str:
    return hashlib.sha256(b"%d %d " % (cycle, seq) + payload).hexdigest()


def make_record(cycle: int, seq: int, payload: bytes) -> tuple[bytes, str]:
    """One journal line: R <cycle> <seq> <len> <payload> <sha256>\\n"""
    digest = record_digest(cycle, seq, payload)
    line = b"R %d %d %d %s %s\n" % (cycle, seq, len(payload), payload, digest.encode())
    return line, digest


def parse_record(line: bytes):
    """(cycle, seq, digest) for an intact record, (cycle, seq, None) for a damaged one
    whose header is still readable, None for anything else."""
    f = line.split(b" ")
    if len(f) != 6 or f[0] != b"R":
        return None
    try:
        cycle, seq, n = int(f[1]), int(f[2]), int(f[3])
    except ValueError:
        return None
    payload, digest = f[4], f[5].decode(errors="replace")
    if len(payload) != n or record_digest(cycle, seq, payload) != digest:
        return (cycle, seq, None)
    return (cycle, seq, digest)


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def fsync_dir(path: str) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


# -- state file ---------------------------------------------------------------------

def state_bytes(state: dict) -> bytes:
    body = json.dumps(state, sort_keys=True, separators=(",", ":"))
    return json.dumps({"state": state, "sha256": hashlib.sha256(body.encode()).hexdigest()}).encode()


def replace_state_careful(data: bytes) -> None:
    tmp = STATE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        write_all(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, STATE)
    fsync_dir(DATA)


def replace_state_careless(data: bytes) -> None:
    with open(STATE, "wb") as f:
        f.write(data)


def read_state() -> tuple[str, dict]:
    try:
        with open(STATE, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        return "missing", {"state_bytes": 0}
    info = {"state_bytes": len(data)}
    if not data:
        return "empty", info
    try:
        doc = json.loads(data)
        state = doc["state"]
        body = json.dumps(state, sort_keys=True, separators=(",", ":"))
        if hashlib.sha256(body.encode()).hexdigest() != doc["sha256"]:
            return "torn", info
    except (ValueError, KeyError, TypeError):
        zeros = data.count(0)
        info["state_detail"] = ("all zero bytes" if zeros == len(data) else
                                f"{zeros} zero bytes" if zeros else "unparseable or checksum mismatch")
        return "torn", info
    info["state_cycle"], info["state_seq"] = state.get("cycle"), state.get("seq")
    return "ok", info


# -- recovery ------------------------------------------------------------------------

def valid_end(path: str, window: int = 8 << 20) -> tuple[int, int]:
    """(offset just past the last intact record, file size)."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        start = max(0, size - window)
        while True:
            f.seek(start)
            buf = f.read(size - start)
            # Walk complete lines backwards; bytes after the last newline are a torn write.
            cut = buf.rfind(b"\n")
            while cut >= 0:
                prev = buf.rfind(b"\n", 0, cut)
                rec = parse_record(buf[prev + 1:cut])
                if rec and rec[2]:
                    return start + cut + 1, size
                cut = prev
            if start == 0:
                return 0, size
            start = max(0, start - window)


def recover(fd: int) -> int:
    """Drop the torn tail a power cut may have left, before appending after it.
    Without this, the next record would be glued to the garbage and be unreadable."""
    good, size = valid_end(JOURNAL)
    if good < size:
        os.ftruncate(fd, good)
        os.fsync(fd)
    return size - good


# -- commands -------------------------------------------------------------------------

def cmd_setup(args) -> int:
    os.makedirs(DATA, exist_ok=True)
    fd = os.open(JOURNAL, os.O_WRONLY | os.O_CREAT, 0o644)
    os.fsync(fd)
    os.close(fd)
    if not os.path.exists(STATE):
        replace_state_careful(state_bytes({"cycle": 0, "seq": 0, "pad": ""}))
    fsync_dir(DATA)
    fsync_dir(os.path.dirname(DATA))
    for key, value in args.sysctl or []:
        # Kept in sysctl.d so every later boot uses the same settings.
        with open(f"/etc/sysctl.d/90-harness-{key}.conf", "w") as f:
            f.write(f"vm.{key} = {value}\n")
        with open(f"/proc/sys/vm/{key}", "w") as f:
            f.write(str(value))
    print(json.dumps({"setup": "ok", "sysctl": dict(args.sysctl or [])}))
    return 0


def replace_state(careful: bool, cycle: int, rng: random.Random, version: int,
                  seq: int, journal_bytes: int, args) -> None:
    pad = base64.b64encode(rng.randbytes(args.state_bytes * 3 // 4)).decode()
    data = state_bytes({"cycle": cycle, "seq": seq, "journal_bytes": journal_bytes,
                        "version": version, "pad": pad})
    # THE DIFFERENCE, part 2: never let a reader see a half-written state file.
    if careful:
        replace_state_careful(data)
    else:
        replace_state_careless(data)


def state_writer(careful: bool, cycle: int, seed: int, args, progress: list) -> None:
    """Replace the state file over and over, concurrently with the journal writer,
    the way a service's components share one filesystem."""
    rng = random.Random(seed ^ 0x5EED)
    version = 0
    try:
        while True:
            version += 1
            replace_state(careful, cycle, rng, version, *progress[0], args)
            progress[1] = version
            if args.state_interval_ms:
                time.sleep(args.state_interval_ms / 1000)
    except BaseException as e:  # a dead writer must not look like a quiet one
        print(f"state writer failed: {e!r}", flush=True)
        os._exit(3)


def cmd_run(args) -> int:
    careful = args.mode == "careful"
    cycle = int(os.environ.get("HARNESS_CYCLE", "1"))
    seed = int(os.environ.get("HARNESS_SEED", "0"))
    rng = random.Random(seed)
    ack_path = os.environ.get("HARNESS_ACK")
    ack_fd = os.open(ack_path, os.O_WRONLY) if ack_path else sys.stdout.fileno()

    jfd = os.open(JOURNAL, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    dropped = recover(jfd)
    print(f"cycle {cycle}, mode {args.mode}: recovered journal, dropped {dropped} "
          f"unacknowledged tail bytes", flush=True)

    seq = 0
    journal_bytes = os.fstat(jfd).st_size
    progress = [(0, journal_bytes), 0]  # (last acknowledged seq, bytes), state version
    inline = args.state_writer == "inline"
    if inline:
        state_rng = random.Random(seed ^ 0x5EED)
    else:
        threading.Thread(target=state_writer, args=(careful, cycle, seed, args, progress),
                         daemon=True).start()
    last_report = time.monotonic()
    while True:
        seq += 1
        size = rng.randint(args.record_min, args.record_max)
        payload = base64.b64encode(rng.randbytes(size * 3 // 4))
        line, digest = make_record(cycle, seq, payload)
        ack = b"%d %d %s\n" % (cycle, seq, digest.encode())

        write_all(jfd, line)
        journal_bytes += len(line)
        # THE DIFFERENCE, part 1: acknowledge only what fsync has made durable.
        if careful:
            os.fsync(jfd)
            write_all(ack_fd, ack)
        else:
            write_all(ack_fd, ack)
            os.fsync(jfd)
        progress[0] = (seq, journal_bytes)
        if inline:  # experiment: replace the state between records, single-threaded
            replace_state(careful, cycle, state_rng, progress[1] + 1, seq, journal_bytes, args)
            progress[1] += 1

        if time.monotonic() - last_report >= 1:
            print(f"seq {seq}, journal {journal_bytes} bytes, state version {progress[1]}",
                  flush=True)
            last_report = time.monotonic()


def cmd_check(args) -> int:
    cycle = int(os.environ.get("HARNESS_CYCLE", "1"))
    wanted, bad_acks = {}, 0
    for raw in sys.stdin.buffer.read().split(b"\n"):
        f = raw.split()
        if not f:
            continue
        try:
            wanted[(int(f[0]), int(f[1]))] = f[2].decode()
        except (ValueError, IndexError):
            bad_acks += 1

    found, records, bad_lines, tail = {}, 0, 0, 0
    last_durable = 0
    if os.path.exists(JOURNAL):
        good_end, size = valid_end(JOURNAL)
        tail = size - good_end
        pos = 0
        with open(JOURNAL, "rb") as f:
            for line in f:
                pos += len(line)
                if not line.endswith(b"\n"):
                    break  # torn tail, counted above
                rec = parse_record(line[:-1])
                if (rec is None or rec[2] is None) and pos <= good_end:
                    bad_lines += 1  # damage before the last intact record
                if rec is None:
                    continue
                if rec[2] is not None:
                    records += 1
                    if rec[0] == cycle:
                        last_durable = max(last_durable, rec[1])
                if (rec[0], rec[1]) in wanted:
                    found[(rec[0], rec[1])] = rec[2]
    else:
        size = 0

    missing = sorted(k for k in wanted if k not in found)
    corrupt = sorted(k for k in wanted if k in found and found[k] != wanted[k])
    state_status, state_info = read_state()
    ok = not missing and not corrupt and state_status == "ok"
    evidence = {
        "acked": len(wanted),
        "intact": len(wanted) - len(missing) - len(corrupt),
        "missing": len(missing),
        "missing_seqs": [s for _, s in missing[:10]],
        "corrupt": len(corrupt),
        "corrupt_seqs": [s for _, s in corrupt[:10]],
        "last_acked_seq": max((s for c, s in wanted if c == cycle), default=0),
        "last_durable_seq": last_durable,
        "journal_bytes": size,
        "journal_records": records,
        "journal_torn_tail_bytes": tail,
        "journal_bad_lines": bad_lines,
        "state": state_status,
        **state_info,
    }
    if bad_acks:
        evidence["malformed_acks"] = bad_acks
    print(json.dumps(evidence, sort_keys=True))
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("setup")
    p.add_argument("--sysctl", nargs=2, action="append", metavar=("KEY", "VALUE"),
                   help="set /proc/sys/vm/KEY in the guest, persistently")
    p.set_defaults(func=cmd_setup)
    p = sub.add_parser("run")
    p.add_argument("--mode", choices=("careful", "careless"), required=True)
    p.add_argument("--record-min", type=int, default=1024, help="smallest record payload, bytes")
    p.add_argument("--record-max", type=int, default=16384, help="largest record payload, bytes")
    p.add_argument("--state-bytes", type=int, default=262144, help="state file padding, bytes")
    p.add_argument("--state-interval-ms", type=float, default=0,
                   help="pause between state replacements (thread writer only)")
    p.add_argument("--state-writer", choices=("thread", "inline"), default="thread",
                   help="replace the state from its own thread (default) or from the "
                        "journal loop after each record (an experiment)")
    p.set_defaults(func=cmd_run)
    p = sub.add_parser("check")
    p.set_defaults(func=cmd_check)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
