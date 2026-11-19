"""Host-only tests: no VM needed.

    python3 -m unittest discover -s deploy/vm/tests
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

VM_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VM_DIR / "harness"))
sys.dont_write_bytecode = True

import runner  # noqa: E402
import workload  # noqa: E402

JOURNAL = VM_DIR / "workloads" / "shared" / "journal.py"


class ScheduleTest(unittest.TestCase):
    def test_same_seed_same_schedule(self):
        self.assertEqual(runner.schedule(7, 20, 500, 5000), runner.schedule(7, 20, 500, 5000))

    def test_different_seed_different_schedule(self):
        self.assertNotEqual(runner.schedule(7, 20, 500, 5000), runner.schedule(8, 20, 500, 5000))

    def test_delays_in_range(self):
        for step in runner.schedule(3, 200, 100, 300):
            self.assertTrue(100 <= step["delay_ms"] <= 300)


class SmokeSkipTest(unittest.TestCase):
    def test_smoke_skips_cleanly_without_kvm(self):
        import contextlib
        import importlib.util
        import io
        spec = importlib.util.spec_from_file_location("harness_cli", VM_DIR / "harness" / "__main__.py")
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        cli.kvm_problem = lambda: "/dev/kvm does not exist"
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main(["smoke"])
        self.assertEqual(code, 0)
        self.assertIn("SKIP", out.getvalue())


class WorkloadSpecTest(unittest.TestCase):
    def test_reference_workloads_load(self):
        names = {wl.name for wl in workload.all_workloads()}
        self.assertTrue({"journal-careful", "journal-careless"} <= names)
        for wl in workload.all_workloads():
            self.assertIn("journal.py", wl.files())

    def test_modes_differ_only_in_mode(self):
        careful = workload.load("journal-careful")
        careless = workload.load("journal-careless")
        self.assertEqual(careful.run.replace("careful", "careless"), careless.run)
        self.assertEqual(careful.check, careless.check)
        self.assertEqual(careful.setup, careless.setup)


class JournalWorkloadTest(unittest.TestCase):
    """The reference check accepts an honest run and catches each kind of damage."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data"
        self.env = dict(os.environ, HARNESS_DATA=str(self.data), HARNESS_CYCLE="1",
                        HARNESS_SEED="42")
        self.env.pop("HARNESS_ACK", None)
        subprocess.run([sys.executable, JOURNAL, "setup"], env=self.env, check=True,
                       capture_output=True)
        # Run the careful workload briefly; acks go to stdout.
        p = subprocess.Popen([sys.executable, JOURNAL, "run", "--mode", "careful",
                              "--state-bytes", "4096"], env=self.env,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            out, _ = p.communicate(timeout=0.7)
        except subprocess.TimeoutExpired:
            p.kill()
            out, _ = p.communicate()
        lines = out.split(b"\n")
        self.acks = b"\n".join(ln for ln in lines[:-1] if len(ln.split()) == 3) + b"\n"
        self.assertGreater(self.acks.count(b"\n"), 5)

    def tearDown(self):
        self.tmp.cleanup()

    def check(self):
        r = subprocess.run([sys.executable, JOURNAL, "check"], env=self.env, input=self.acks,
                           capture_output=True)
        return r.returncode, json.loads(r.stdout.decode().strip().splitlines()[-1])

    def test_intact_run_passes(self):
        code, ev = self.check()
        self.assertEqual(code, 0, ev)
        self.assertEqual(ev["missing"], 0)
        self.assertEqual(ev["state"], "ok")

    def test_lost_acknowledged_tail_fails(self):
        journal = self.data / "journal.log"
        os.truncate(journal, journal.stat().st_size - 40000)
        code, ev = self.check()
        self.assertEqual(code, 1)
        self.assertGreater(ev["missing"], 0)

    def test_corrupt_acknowledged_record_fails(self):
        journal = self.data / "journal.log"
        raw = bytearray(journal.read_bytes())
        # Flip a payload byte in the first record (always acknowledged).
        raw[20] = ord("A") if raw[20] != ord("A") else ord("B")
        journal.write_bytes(bytes(raw))
        code, ev = self.check()
        self.assertEqual(code, 1)
        self.assertEqual(ev["corrupt"], 1)

    def test_empty_state_fails(self):
        (self.data / "state.json").write_bytes(b"")
        code, ev = self.check()
        self.assertEqual((code, ev["state"]), (1, "empty"))

    def test_torn_state_fails(self):
        state = self.data / "state.json"
        state.write_bytes(state.read_bytes()[:1000])
        code, ev = self.check()
        self.assertEqual((code, ev["state"]), (1, "torn"))

    def test_recovery_drops_torn_tail_before_appending(self):
        journal = self.data / "journal.log"
        with open(journal, "ab") as f:
            f.write(b"R 1 999 10 garb")  # a write cut short, no newline
        env = dict(self.env, HARNESS_CYCLE="2", HARNESS_SEED="43")
        p = subprocess.Popen([sys.executable, JOURNAL, "run", "--mode", "careful"], env=env,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            out, _ = p.communicate(timeout=0.5)
        except subprocess.TimeoutExpired:
            p.kill()
            out, _ = p.communicate()
        acks2 = b"\n".join(ln for ln in out.split(b"\n")[:-1] if len(ln.split()) == 3) + b"\n"
        r = subprocess.run([sys.executable, JOURNAL, "check"], env=env, input=acks2,
                           capture_output=True)
        ev = json.loads(r.stdout.decode().strip().splitlines()[-1])
        self.assertEqual(r.returncode, 0, ev)
        self.assertEqual(ev["journal_bad_lines"], 0)


if __name__ == "__main__":
    unittest.main()
