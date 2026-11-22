#!/usr/bin/env python3
"""Declare a registry's apps to a signing service (ios-tools push and renewal): their names,
bundle IDs, inputs, build command and output, as JSON.

    python3 apps/ios/scripts/renewal.py --team TEAMID --device UDID                    # the demo's apps
    python3 engine/scripts/renewal.py --registry . --team TEAMID --device UDID         # a deployment's

The inputs are relative to the registry folder: the engine's (through the registry's `engine`
link when the registry is not the engine itself), the registry's apps.json and apps.local.json,
its plug-ins, each app's keys and staged web extensions, and an override folder with what its
override.json declares. Bundle IDs come from bundlePrefix (apps.local.json may set it) or an
app's own bundleId.
"""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from registry import ENGINE, Registry


def declare(registry, team, device):
    root = registry.root
    engine = '' if root.resolve() == ENGINE else registry.get('engine', 'engine') + '/'
    common = [engine + name for name in ['App', 'Kit', 'Extension', 'scripts/project.py', 'scripts/build-app.py', 'scripts/registry.py']]
    common += ['apps.json'] + (['apps.local.json'] if registry.local_file else [])
    plugins = [str(folder.relative_to(root)) for folder in registry.plugins()]
    apps = []
    for key, config in registry.apps.items():
        bundle = registry.bundle_id(key)
        extensions = config.get('extensions', [])
        inputs = list(common)
        # Keys and web extensions are staged before a push (the deployment's prepare step).
        inputs += list(config.get('keys', {}).values())
        inputs += ['build/' + key + '/' + suffix for suffix in config.get('webExtensions', {})]
        if config.get('overrides'):
            # A provider with its own engine compiles no plug-ins: its folder and what it declares.
            inputs += [config['overrides']] + json.loads((root / config['overrides'] / 'override.json').read_text())['renewalInputs']
        else: inputs += plugins
        apps.append(dict(name=registry.signing_name(key), root=str(root),
                         app='build/' + key + '/native/Release-iphoneos/' + config['product'] + '.app',
                         bundleIds=[bundle] + [bundle + '.' + suffix for suffix in extensions], inputs=inputs,
                         build=['/usr/bin/python3', engine + 'scripts/build-app.py'] + (['--registry', '.'] if engine else []) + [key],
                         environment={'DEVELOPMENT_TEAM': team, 'SIGNING_DEVICE': device}))
    return dict(repo=registry.get('repo', 'video-platform-apps'), apps=apps)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--registry')
    parser.add_argument('--team', required=True)
    parser.add_argument('--device', required=True)
    args = parser.parse_args()
    print(json.dumps(declare(Registry(args.registry), args.team, args.device)))
