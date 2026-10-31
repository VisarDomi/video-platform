import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

source = Path(__file__).resolve().parents[1] / 'scripts/validate_delivery.py'
spec = importlib.util.spec_from_file_location('validate_delivery', source)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


def fingerprint(root, inputs):
    digest = hashlib.sha256()
    for name in inputs:
        item = root / name
        files = sorted(item.rglob('*')) if item.is_dir() else [item]
        for file in files:
            if file.is_file(): digest.update(file.read_bytes())
    return digest.hexdigest()


class DeliveryTests(unittest.TestCase):
    def test_only_the_recorded_source_and_app_may_be_installed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'App.app').mkdir(); (root / 'state').mkdir()
            src = root / 'source.swift'; src.write_text('approved source')
            binary = root / 'App.app/binary'; binary.write_text('built app')
            config = {'root': str(root), 'app': 'App.app', 'stateDir': str(root / 'state'), 'inputs': ['source.swift']}
            with self.assertRaisesRegex(RuntimeError, 'receipt'): module.validate_delivery(config, fingerprint)
            record = root / 'state/delivery.json'
            record.write_text(json.dumps({'inputHash': fingerprint(root, config['inputs']), 'appHash': fingerprint(root, ['App.app'])}))
            module.validate_delivery(config, fingerprint)
            src.write_text('concurrent sync')
            with self.assertRaisesRegex(RuntimeError, 'inputs changed'): module.validate_delivery(config, fingerprint)
            src.write_text('approved source'); binary.write_text('another build replaced it')
            with self.assertRaisesRegex(RuntimeError, 'app changed'): module.validate_delivery(config, fingerprint)


if __name__ == '__main__': unittest.main()
