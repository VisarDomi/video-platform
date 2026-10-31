import importlib.util
from pathlib import Path
import tempfile
import unittest

source = Path(__file__).resolve().parents[1] / 'scripts/private_inputs.py'
spec = importlib.util.spec_from_file_location('private_inputs', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateInputsTests(unittest.TestCase):
    def test_local_app_sync_preserves_the_existing_shared_tango_key(self):
        with tempfile.TemporaryDirectory() as root:
            app = Path(root) / 'app'; app.mkdir()
            data = Path(root) / 'data'; data.mkdir()
            original = b'a' * 64 + b'\n'; (data / 'tango-phone-key').write_bytes(original)
            registry = {'bunkr': {'mediaKind': 'mp4'}, 'tango-live': {'native': 'tango'}}
            for _ in range(2):
                module.stage_private_inputs(app, registry, data)
                self.assertEqual((app / 'Private/tango-phone-key').read_bytes(), original)
                self.assertEqual((data / 'tango-phone-key').read_bytes(), original)
                self.assertEqual((app / 'Private/tango-phone-key').stat().st_mode & 0o777, 0o600)

    def test_initial_key_is_created_once_and_unused_registries_create_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            app = Path(root) / 'app'; app.mkdir(); data = Path(root) / 'data'
            module.stage_private_inputs(app, {'bunkr': {}}, data)
            self.assertFalse(data.exists()); self.assertFalse((app / 'Private').exists())
            registry = {'tango-live': {'native': 'tango'}}
            module.stage_private_inputs(app, registry, data)
            original = (data / 'tango-phone-key').read_bytes()
            self.assertRegex(original.decode().strip(), r'^[a-f0-9]{64}$')
            module.stage_private_inputs(app, registry, data)
            self.assertEqual((data / 'tango-phone-key').read_bytes(), original)


if __name__ == '__main__': unittest.main()
