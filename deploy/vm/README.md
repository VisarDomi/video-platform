# Power-cut test harness

This harness runs a workload inside a QEMU virtual machine and cuts the power at
random moments. After each cut it boots the machine again and checks the
workload's invariants. It exists to back one rule with evidence: **if it does not
survive a power cut, it is a bug.**

```
boot 0 ── copy the workload in, run its setup, sync
  │
  ├─ cycle 1: start the run command (systemd unit) ── wait d₁ ms ── SIGKILL QEMU
  │           boot 1 ── run the check, with the acknowledgements cycle 1 sent
  ├─ cycle 2: start the run command ── wait d₂ ms ── SIGKILL QEMU
  │           boot 2 ── check
  ⋮
```

The delays d₁…dₙ and a seed for each cycle are drawn from `--seed` before the
first boot, so the same seed gives the same cut schedule.

## Quick start

Requirements: Linux with KVM (`/dev/kvm` readable and writable),
`qemu-system-x86_64`, `qemu-img`, OVMF (UEFI firmware, needed only by `prepare`),
OpenSSH, Python 3.11 or later, and one of `genisoimage`, `mkisofs`, `xorriso`,
`cloud-localds` or `mtools`. You don't need libvirt or root.

```sh
python3 deploy/vm/harness prepare            # ~350 MB download, ~30 s first boot
python3 deploy/vm/harness smoke              # one cycle; prints SKIP and exits 0 without KVM
python3 deploy/vm/harness run --workload journal-careful  --cycles 30 --seed 101
python3 deploy/vm/harness run --workload journal-careless --cycles 30 --seed 101
python3 deploy/vm/harness report ~/.cache/vm-harness/runs/*/
python3 -m unittest discover -s deploy/vm/tests   # host-only tests, no VM
```

`run` options: `--min-ms` and `--max-ms` set the delay range (default 500–5000),
`--cache` sets the QEMU cache mode (see [Fidelity](#fidelity)), `--out` sets the
run directory, `--keep-disk` keeps the run's disk for inspection (an aborted run
always keeps it), and `--cpus` and `--memory-mb` size the VM (default 2 and
2048). QEMU runs under `nice -n 10` and `ionice -c2 -n7`, so it yields to the
host's own work. The exit status is 0 only if every cycle passed.

Everything the harness downloads or creates lives under `~/.cache/vm-harness`
(override with `VM_HARNESS_CACHE`), never in the repository:

```
images/debian-13-genericcloud-amd64-….qcow2   pristine base, read-only, SHA-512 pinned in common.py
ssh/                                          client key, the guest's host key, known_hosts
provisioned/disk.qcow2                        overlay on the base: user, packages, quiet services
provisioned/vmlinuz, initrd.img, stamp.json   the guest kernel, booted directly by every run
runs/<id>/run.json                            parameters, schedule, guest facts
runs/<id>/results.jsonl                       one line per cycle
runs/<id>/summary.json                        counts, written when the run ends
runs/<id>/acks/cycle-NNN.txt                  the acknowledgements the check received
runs/<id>/boots/boot-NNN.{console,out,ack}    serial console, workload output, raw acks
runs/<id>/disk.qcow2                          overlay on provisioned; deleted unless --keep-disk
```

## What a power cut means here

A power cut is `SIGKILL` to the QEMU process, with no warning to the guest. At
that moment:

| | after the cut |
|---|---|
| the guest's page cache, dirty buffers and I/O it has not yet handed to the virtual disk | **lost** (it was guest RAM) |
| QEMU's own memory, including qcow2 metadata it has not written yet | **lost** |
| writes the guest flushed (`fsync`, `fdatasync`, a journal commit) | **kept** |
| writes QEMU passed to the host kernel but the guest never flushed | usually kept (see the limits below) |
| acknowledgements and workload output already in the host files | **kept**; they never lived in the guest |

The next boot is a real unclean boot. The guest's ext4 replays its journal
(`EXT4-fs (vda1): recovery complete` shows up in each cycle's `guest_fs_log`),
and only then does the check run.

### Fidelity

The disk is a virtio-blk device on a qcow2 overlay with **`cache=writeback`**
(QEMU's default, chosen on purpose):

- The guest sees a volatile write cache (`/sys/block/vda/queue/write_cache` reads
  `write back`; each run records it in `run.json`). The guest must therefore issue
  flushes, as it would on a real SSD.
- A guest flush makes QEMU write its qcow2 metadata and call `fdatasync` on the
  image file. Flushed data is then on the host's disk, so it would survive even a
  real host power loss. Flushes also cost real time, so race windows have
  realistic widths.
- Writes the guest has not flushed may be lost. Data still in the guest's page
  cache is always lost.

This models a disk that has a volatile write cache and honours flushes: an SSD
without power-loss protection.

The other modes, for comparison (`--cache`):

| mode | guest sees | flush does | what a QEMU kill can lose |
|---|---|---|---|
| `writeback` (default) | volatile cache | metadata out + host `fdatasync` | unflushed writes |
| `unsafe` | volatile cache | metadata out, **no** `fdatasync` | the same as writeback under a QEMU kill (the host page cache survives), but not under a host power loss. It's faster and spares the host disk. |
| `none` | volatile cache | host `fdatasync` (O_DIRECT, bypasses the host page cache) | unflushed writes |
| `writethrough`, `directsync` | no volatile cache | nothing to do; each write is durable when it completes | only what never left the guest; the guest stops issuing flushes |

### Limits

- **Kinder than real hardware.** A real drive that loses power may drop any
  unflushed write, in any order, and some drives ignore flushes altogether. Here,
  unflushed writes that already reached the host kernel survive, unless QEMU was
  still holding their qcow2 allocation metadata in memory. Nothing is reordered
  below QEMU. A **fail** is therefore a real bug: data was lost even
  under a lenient model. A **pass** means no bug was found under this model. To
  explore reorderings, replay a recorded write log (dm-log-writes, in the style
  of CrashMonkey); that is not built yet.
- **Sub-page atomicity.** A request QEMU is writing at the instant of the kill can
  be cut short at a page boundary. Smaller tears, such as torn sectors, are not
  modelled.
- **Timing.** The schedule (every delay and every per-cycle seed) is exactly
  reproducible from the seed. Where the workload is when the cut lands is
  reproducible only statistically. SSH and scheduling add milliseconds, and host
  load changes how fast the guest's fsyncs complete: in the reference runs, the
  workload had acknowledged anywhere from 9 to 1384 records by the cut. Each row
  records the planned delay and the measured `cut_after_ms`, which is counted
  from the moment `systemd-run` returns.
- **One filesystem and kernel.** The guest runs Debian 13 with ext4 and its
  defaults (`data=ordered`, 5 s commit, `discard`). Other filesystems or mount
  options would give different results.
- **Cuts land only during the run command.** The harness never cuts during
  boot, during recovery or during the check. Cutting during a recovery is a
  separate test worth adding.
- **Direct kernel boot.** Runs boot the kernel and initrd saved by `prepare`
  (about 5 s faster than going through firmware and GRUB), so the bootloader is
  not exercised. This Debian image boots only through UEFI, so `prepare` uses
  OVMF.

## Results

Two reference workloads share one script (`workloads/shared/journal.py`) and differ
in exactly two places:

| | `journal-careful` | `journal-careless` |
|---|---|---|
| journal record | write, `fsync`, **then** acknowledge | write, acknowledge, then `fsync` |
| state file (about 256 KB of JSON) | write a temp file, `fsync`, `rename` over, `fsync` the directory | `open(..., "w")`, write: truncate and rewrite in place |

The check, run after every reboot, requires two things. First, every acknowledged
record is present and intact: its SHA-256 matches the one in the acknowledgement.
Second, the state file is complete: non-empty, parseable and matching its own
checksum.

Measured on 2026-11-19 on a 12-core Xeon E5-1650 v3 host while production
services were transcoding. The guest had 2 vCPUs and 2 GB, ran Debian 13 with
kernel 6.12 on ext4, and used QEMU 8.2 with `cache=writeback` unless a row says
otherwise. Delays ranged from 500 to 5000 ms. Rows with the same seed faced the
same planned cuts.

| workload | cache | seed | cycles | failed | acknowledged record lost | state torn or empty | mean cycle | data |
|---|---|---:|---:|---:|---:|---:|---:|---|
| journal-careful | writeback | 101 | 30 | **0** | 0 | 0 | 11.1 s | [ref-careful-s101](results/ref-careful-s101/) |
| journal-careless | writeback | 101 | 30 | **17** | 17 | 4 | 11.1 s | [ref-careless-s101](results/ref-careless-s101/) |
| journal-careful | writeback | 202 | 100 | **0** | 0 | 0 | 11.9 s | [long-careful-s202](results/long-careful-s202/) |
| journal-careful | unsafe | 101 | 30 | **0** | 0 | 0 | 12.0 s | [unsafe-careful-s101](results/unsafe-careful-s101/) |
| journal-careless | unsafe | 101 | 30 | **19** | 11 | 11 | 12.2 s | [unsafe-careless-s101](results/unsafe-careless-s101/) |
| journal-careless, 64 KB state | writeback | 101 | 20 | **16** | 11 | 6 | 11.5 s | [exp-careless-64k-s101](results/exp-careless-64k-s101/) |
| journal-careless, state replaced inline (no thread) | writeback | 101 | 30 | **8** | 8 | 0 | 11.1 s | [exp-careless-inline-s101](results/exp-careless-inline-s101/) |

Each data directory holds the run's `run.json`, `results.jsonl` and
`summary.json`. Reproduce a row with, for example,
`harness run --workload journal-careless --cycles 30 --seed 101`. Add
`--cache unsafe` for the unsafe rows. The last two rows ran a copy of
`journal-careless` whose run command adds `--state-bytes 65536` or
`--state-writer inline`.

In the writeback careless run, every failure was the newest acknowledged record
missing from the journal (`last_acked_seq` = `last_durable_seq` + 1). In 4 of
those cycles the state file was torn as well: it had its full size and was **all
zero bytes**. The new length had reached the disk; the data had not. That is
consistent with ext4 allocating the blocks as unwritten extents, which read back
as zeros until the completed write is recorded.

In 160 cycles, the careful workload never lost an acknowledged record and never
showed a torn state. Its recovery step did real work once. In cycle 61 of the
100-cycle run, the cut left 13,197 bytes of a half-written, unacknowledged
record at the end of the journal. The cut had landed during that record's
fsync, after the journal's new length was committed but before all of its data
was. Cycle 62 started by dropping exactly those bytes, then appended cleanly.
Without that step, its first record would have been glued to the garbage and
been unreadable.

**Runtime.** A cycle takes 11 to 12 s on average: about 6.5 s to boot to SSH
(direct kernel boot), the cut delay (3.0 s on average for seed 101), the check,
and SSH round trips. The check reads the whole journal, so it grows with the run,
from about 0.5 s to 2.7 s once the 100-cycle run's journal reached 450 MB.
Planned and actual cut times differed by at most 1.4 ms. Provisioning takes
about 30 s once.

### Why the careless workload fails, and what it took

- **Acknowledging before `fsync`** fails with no tuning at all. The careless loop
  spends most of its time inside `fsync`, because a guest flush becomes a host
  `fdatasync`. A cut therefore usually lands while the newest acknowledged record
  exists only in the guest's page cache, or on its way to QEMU.
- **Replacing the state in place** did not fail at first. In the first version
  the state was rewritten from the same loop that appended records, and in 8
  cycles it never tore. On ext4, `open(O_TRUNC)`, `write`, `close` is mostly
  saved by `auto_da_alloc`: after a truncate, `close()` starts writing the new
  data out, and the next journal commit waits for it. The file is then old or
  new on disk, never empty. Only a commit landing between the truncate and the
  close exposes the gap. A single-threaded loop never fsyncs there, which leaves
  only ext4's 5-second periodic commit, and that rarely lands in the gap.
  The state writer was therefore moved to its own thread, in both workloads, as
  a second component of one service would be. The journal thread's fsyncs then
  commit at arbitrary moments, including inside that gap, and torn (zero-filled)
  states appeared.
- **Concurrency exposes the bug, not size.** The state grew from 64 KB to
  256 KB when it moved to a thread, so two runs separate the two changes. With
  the thread and a 64 KB state, the state tore in 6 of 20 cycles, more often
  than at 256 KB: smaller rewrites are faster, so there are more of them to hit.
  With 256 KB and no thread (`--state-writer inline`), it tore in 0 of 30
  cycles, against 4 of 30 with the thread at the same size and seed. All 8
  failures of the inline run were lost acknowledgements.
- The `vm.dirty_*` settings were not needed; both bugs show up with the guest's
  defaults. `journal.py setup --sysctl KEY VALUE` can set them, and it keeps the
  setting across reboots.

### writeback against unsafe

The same seed under `--cache unsafe` gave the same verdicts. careful passed 30 of
30. careless failed 19 of 30: 11 cycles lost an acknowledged record, and 11 had a
broken state file (10 zero-filled, 1 empty, 3 of them with a lost record too).
That agrees with the [table above](#fidelity): under a QEMU kill the host page
cache survives either way. What changed was speed. Without host `fdatasync`s, the
guest's fsyncs were about three times faster: careful acknowledged 1711 records
per cycle on average instead of 630. That moved the cuts into different windows,
so fewer cycles lost a record and more tore the state. `writeback` stays the
default because its flush latency is realistic, and the data it flushes would
also survive a power loss of the host itself. `unsafe` is a valid way to go
faster and spare the host disk.

## Writing a workload

A workload is a directory holding `workload.toml` (or `workload.json`) and its
files:

```toml
name        = "journal-careful"            # defaults to the directory name
description = "..."
packages    = ["python3"]                  # guest packages; `prepare --workload DIR` installs them
include     = ["../shared/journal.py"]     # extra files, copied next to the spec
setup       = "python3 journal.py setup"   # once per run; never cut
run         = "exec python3 journal.py run --mode careful"
check       = "python3 journal.py check"
setup_timeout_s = 300                      # optional
check_timeout_s = 120                      # optional
```

The harness copies the directory and its includes to `/opt/harness/workload`. All
three commands run as root under `/bin/sh` in that directory, with this
environment:

| variable | meaning |
|---|---|
| `HARNESS_CYCLE` | cycle number (0 during setup) |
| `HARNESS_SEED` | this cycle's seed, derived from the run seed |
| `HARNESS_DATA` | `/var/lib/harness/data`, the workload's persistent data, kept across cycles |
| `HARNESS_ACK` | `/dev/virtio-ports/harness.ack`, the acknowledgement channel |
| `HARNESS_WORKLOAD` | `/opt/harness/workload` |

- **setup** runs once, after the copy. The harness then runs `sync`, so the
  workload's files are safe before the first cut.
- **run** starts once per cycle as the transient unit `harness-workload`. It
  should keep working until it is killed. Its stdout and stderr go to
  `boots/boot-NNN.out` on the host, through a second virtio-serial port, because
  the guest's journal loses its last minutes in a cut. A transient unit does not
  start again after the reboot.
- **Acknowledgements** are newline-terminated lines written to `$HARNESS_ACK`. A
  line counts once it is complete in the host file, and a line cut short is
  ignored. Write an acknowledgement only for what the workload promises is
  durable. Only one process at a time can open the port, so if several
  components acknowledge, route their lines through a single writer.
- **check** runs after every reboot, with that cycle's acknowledgements on stdin.
  Exit 0 means pass, 1 means fail, and anything else is a harness-level error.
  The last line of stdout, if it is a JSON object, becomes the cycle's
  `evidence`.

Each cycle appends one line to `results.jsonl`:

```json
{"cycle": 7, "delay_ms": 1964, "cut_after_ms": 1964.6, "acks": 1003, "verdict": "fail",
 "evidence": {"acked": 1003, "intact": 1002, "missing": 1, "missing_seqs": [1003],
              "state": "ok", ...},
 "guest_fs_log": ["EXT4-fs (vda1): recovery complete", ...],
 "workload_out": ["cycle 7, mode careless: recovered journal, ...", "seq 931, ..."],
 "boot_s": 6.5, "check_s": 0.7, "cycle_s": 10.4, "cycle_seed": 123, "seed": 101, ...}
```

## Plugging in a larger stack (the Podman demo)

The harness itself does not change. The demo stack becomes one more workload
directory:

1. **Packages and size.** Add `packages = ["podman", ...]`, then run
   `prepare --workload <dir> --disk-size 20G`. Raise `--memory-mb` if 2 GB is
   too little. `prepare` provisions again whenever the package list changes.
2. **Setup** (never cut): load the container images from tarballs shipped in the
   workload directory, because pulling them on every run is slow. Then install
   the Quadlet `.kube` units and enable them. Unlike the transient `run` unit,
   the stack should start again on every boot, since the boot after a cut is
   exactly when its recovery has to work. For rootless Podman, run as the
   `harness` user with lingering enabled.
3. **Run:** start the simulator scenario that drives traffic. One process
   relays the pipeline's durable events, such as a finalized recording or a
   receipt written, to `$HARNESS_ACK`. A container can hold the port if it gets
   `--device /dev/virtio-ports/harness.ack`.
4. **Check:** wait until the stack has come back and finished its recovery,
   allowing for that in `check_timeout_s`. Then run the simulator's checker
   against the pipeline's records, require every acknowledged event to be
   present, and print the checker's findings as the evidence JSON.
5. Keep data under `$HARNESS_DATA` or the stack's own configured roots. Nothing
   in the guest touches the host's production data or ports. The only host
   ports are the per-run SSH forwards on loopback.

## The harness's own crash safety

The base download resumes from its `.part` file and is verified before it is
renamed into place. A provisioned disk replaces the old one only after a clean
guest shutdown, through an atomic directory swap. A run in progress notices if
that happens and aborts, rather than boot its overlay on a different backing
disk. Each result line is fsynced before the next cycle starts, and
`summary.json` is written atomically. QEMU dies with the harness
(`PR_SET_PDEATHSIG`), so no orphaned VM keeps running. On `SIGTERM` the run cuts
the guest, writes `summary.json` with `"complete": false` and
`"aborted": "terminated"`, and keeps its disk. That happened once by accident,
at cycle 68 of a 100-cycle run, and left no QEMU process behind. If the host
itself goes down mid-run, the finished cycles in `results.jsonl` stay valid and
`report` reads them. Start a new run; a run does not resume.
