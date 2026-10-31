"""Stage shared private build inputs before syncing any provider's app mirror."""
import os
from pathlib import Path
import secrets
import tempfile


def stage_private_inputs(app: Path, registry: dict, data_root: Path) -> None:
    if not any(config.get('native') == 'tango' for config in registry.values()):
        return
    key = data_root / 'tango-phone-key'
    if not key.exists():
        key.parent.mkdir(parents=True, exist_ok=True)
        with os.fdopen(os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
            output.write(secrets.token_hex(32) + '\n')
    private = app / 'Private'
    private.mkdir(mode=0o700, exist_ok=True)
    private.chmod(0o700)
    target = private / 'tango-phone-key'
    descriptor, temporary = tempfile.mkstemp(prefix='tango-phone-key.', dir=private)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(key.read_bytes()); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
