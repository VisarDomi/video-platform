"""Workload specs: a directory with workload.toml (or workload.json) and its files.

    name        = "journal-careful"           # defaults to the directory name
    description = "..."
    packages    = ["python3"]                 # guest packages, installed by `prepare`
    include     = ["../shared/journal.py"]    # extra files copied next to the spec
    setup       = "python3 journal.py setup"  # once per run, after the copy
    run         = "exec python3 journal.py run --mode careful"
    check       = "python3 journal.py check"
    setup_timeout_s = 300                     # optional
    check_timeout_s = 120                     # optional

All three commands run as root through /bin/sh with the workload directory as the
working directory. See README.md, "Writing a workload", for the contract.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path

from common import WORKLOADS_DIR, HarnessError

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    tomllib = None


@dataclass
class Workload:
    name: str
    root: Path
    run: str
    check: str
    setup: str = ""
    description: str = ""
    packages: list[str] = field(default_factory=list)
    include: list[str] = field(default_factory=list)
    setup_timeout_s: float = 300
    check_timeout_s: float = 120

    def files(self) -> dict[str, Path]:
        """Guest-relative name -> host path, for everything copied into the guest."""
        out = {}
        for p in sorted(self.root.iterdir()):
            if p.name.startswith(".") or p.name == "__pycache__":
                continue
            out[p.name] = p
        for rel in self.include:
            p = (self.root / rel).resolve()
            if not p.exists():
                raise HarnessError(f"{self.name}: include {rel!r} does not exist")
            if p.name in out:
                raise HarnessError(f"{self.name}: include {rel!r} clashes with {p.name}")
            out[p.name] = p
        return out


def resolve(ref: str) -> Path:
    """A workload given as a path, or as a name under deploy/vm/workloads/."""
    p = Path(ref)
    if p.is_dir():
        return p.resolve()
    named = WORKLOADS_DIR / ref
    if named.is_dir():
        return named.resolve()
    raise HarnessError(f"workload not found: {ref}")


def load(ref: str) -> Workload:
    root = resolve(ref)
    toml_path, json_path = root / "workload.toml", root / "workload.json"
    if toml_path.exists():
        if tomllib is None:
            raise HarnessError("workload.toml needs Python 3.11+; use workload.json instead")
        spec = tomllib.loads(toml_path.read_text())
    elif json_path.exists():
        spec = json.loads(json_path.read_text())
    else:
        raise HarnessError(f"{root} has no workload.toml or workload.json")
    known = {"name", "description", "packages", "include", "setup", "run", "check",
             "setup_timeout_s", "check_timeout_s"}
    unknown = set(spec) - known
    if unknown:
        raise HarnessError(f"{root}: unknown keys {sorted(unknown)}")
    for key in ("run", "check"):
        if not isinstance(spec.get(key), str) or not spec[key].strip():
            raise HarnessError(f"{root}: '{key}' command is required")
    return Workload(name=spec.get("name", root.name), root=root, run=spec["run"],
                    check=spec["check"], setup=spec.get("setup", ""),
                    description=spec.get("description", ""),
                    packages=list(spec.get("packages", [])),
                    include=list(spec.get("include", [])),
                    setup_timeout_s=float(spec.get("setup_timeout_s", 300)),
                    check_timeout_s=float(spec.get("check_timeout_s", 120)))


def all_workloads() -> list[Workload]:
    return [load(str(p)) for p in sorted(WORKLOADS_DIR.iterdir())
            if (p / "workload.toml").exists() or (p / "workload.json").exists()]
