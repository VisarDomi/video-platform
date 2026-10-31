"""Reject a stale or unrecorded build before changing the installed phone app."""
import json
from pathlib import Path


def validate_delivery(config, fingerprint):
    root = Path(config['root'])
    app = root / config['app']
    record = Path(config['stateDir']) / 'delivery.json'
    delivered = json.loads(record.read_text()) if record.exists() else {}
    if not delivered.get('inputHash') or not delivered.get('appHash'):
        raise RuntimeError('No completed build receipt; rebuild before installation')
    if fingerprint(root, config['inputs']) != delivered['inputHash']:
        raise RuntimeError('Build inputs changed; rebuild before installation')
    if fingerprint(app.parent, [app.name]) != delivered['appHash']:
        raise RuntimeError('Built app changed; rebuild before installation')
