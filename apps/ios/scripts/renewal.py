#!/usr/bin/env python3
"""Print this repo's paid apps for its renewal scheduler (ios-tools renewal; runs on the Mac mirror)."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--team', required=True)
parser.add_argument('--device', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
apps = []
# Local entries are named <provider>-local so they never collide with Tango (tango-live). Online apps
# also depend on their staged content script, and Tango on its Login helper and staged web extensions,
# so the Mac needs no Node.
for provider, product in json.loads((root / 'providers.json').read_text()).items():
    online = bool(product.get('hosts'))
    extensions = product.get('extensions', [])
    web = product.get('webExtensions', {})
    apps.append(dict(name=provider if online else provider + '-local', root=str(root),
                     app='build/' + provider + '/native/Release-iphoneos/' + product['product'] + '.app',
                     bundleIds=[product['bundleId']] + [product['bundleId'] + '.' + suffix for suffix in extensions],
                     inputs=['VideoApp', 'Shared', 'providers.json', 'scripts/project.py', 'scripts/build-provider.py']
                            + (['build/' + provider + '/content.js'] if online else [])
                            + (['Login'] if 'Login' in extensions else []) + (['Extension'] if web else [])
                            + ['build/' + provider + '/' + suffix for suffix in web],
                     build=['/usr/bin/python3', 'scripts/build-provider.py', provider],
                     environment={'DEVELOPMENT_TEAM': args.team, 'SIGNING_DEVICE': args.device}))
print(json.dumps(dict(repo='video-platform', apps=apps)))
