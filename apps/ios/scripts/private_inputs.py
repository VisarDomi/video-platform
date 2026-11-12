"""Stage shared private build inputs before syncing any provider's app mirror."""
import os
from pathlib import Path
import secrets
import tempfile

# The key the PC's public address asks for (environment services/hetzner-pc, "pc-apps").
PC_APPS_KEY = Path.home() / '.local/share/hetzner-pc/keys/video-actions.key'


def _stage(source: Path, target: Path) -> None:
    private = target.parent
    private.mkdir(mode=0o700, exist_ok=True)
    private.chmod(0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=target.name + '.', dir=private)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(source.read_bytes()); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def stage_private_inputs(app: Path, registry: dict, data_root: Path, pc_apps_key: Path = PC_APPS_KEY) -> None:
    # Tango's key for the PC's phone login: created once, shared by every build.
    if any(config.get('native') == 'tango' for config in registry.values()):
        key = data_root / 'tango-phone-key'
        if not key.exists():
            key.parent.mkdir(parents=True, exist_ok=True)
            with os.fdopen(os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
                output.write(secrets.token_hex(32) + '\n')
        _stage(key, app / 'Private/tango-phone-key')
    # The apps with download lists (Video Vault, Tango) reach the PC away from home with the
    # public address's key. It is made on the PC by pc_apps.py; without it they stay home-only.
    if any(config.get('native') for config in registry.values()) and pc_apps_key.exists():
        _stage(pc_apps_key, app / 'Private/pc-apps-key')
