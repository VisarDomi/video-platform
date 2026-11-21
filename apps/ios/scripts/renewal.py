#!/usr/bin/env python3
"""Declare this shell's apps to a signing service (ios-tools push and renewal): their names, bundle
IDs, inputs, build command and output, as JSON.

    python3 apps/ios/scripts/renewal.py --team TEAMID --device UDID

The bundle IDs come from apps.local.json's bundlePrefix, which therefore is an input too (it is
not in Git; neither are the PC's addresses or the phone keys it holds).
"""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
parser.add_argument('--team', required=True)
parser.add_argument('--device', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
registry = json.loads((root / 'apps.json').read_text())
local_file = root / 'apps.local.json'
local = json.loads(local_file.read_text()) if local_file.exists() else {}
prefix = local.get('bundlePrefix', 'com.example.videoplatform')
apps = [dict(name=key, root=str(root),
             app='build/' + key + '/native/Release-iphoneos/' + config['product'] + '.app',
             bundleIds=[prefix + '.' + config['bundleSuffix']],
             inputs=['App', 'Kit', 'apps.json', 'scripts/project.py', 'scripts/build-app.py']
                    + (['apps.local.json'] if local_file.exists() else []),
             build=['/usr/bin/python3', 'scripts/build-app.py', key],
             environment={'DEVELOPMENT_TEAM': args.team, 'SIGNING_DEVICE': args.device})
        for key, config in registry.items()]
print(json.dumps(dict(repo='video-platform-apps', apps=apps)))
