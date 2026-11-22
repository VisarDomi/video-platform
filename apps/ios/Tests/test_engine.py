"""The engine (App/) names no provider, and any registry builds from it.

What differs between apps comes from a registry's apps.json (written into each Info.plist and read
through App/ProviderTraits.swift), from a plug-in folder (its plugin.json names its site lists and
checks), from the stream kind, or from an app's override folder. The engine never compares a
provider name, and the generator never tests an app's key."""
import json, os, pathlib, plistlib, re, subprocess, sys, tempfile, unittest
ENGINE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE / 'scripts'))
from registry import Registry


def code(path):
    # Comments out, so the engine may still explain where a provider's own code lives.
    return '\n'.join(line.split('//', 1)[0] for line in path.read_text().splitlines())


class EngineNamesNoProvider(unittest.TestCase):
    def engine(self):
        return sorted((ENGINE / 'App').glob('*.swift'))

    def test_no_provider_comparisons(self):
        for path in self.engine():
            with self.subTest(file=path.name):
                text = code(path)
                self.assertIsNone(re.search(r'\bprovider\s*[!=]=\s*"', text), 'compare a trait, not a provider name')
                self.assertIsNone(re.search(r'"\s*[!=]=\s*\w*\.?provider\b', text))
                self.assertIsNone(re.search(r'\[\s*"[\w-]+"(\s*,\s*"[\w-]+")*\s*\]\s*\.contains\(\s*\w*\.?provider', text))

    def test_no_plugin_or_override_symbols(self):
        plugin_types = set()
        for folder in (ENGINE / 'Providers').iterdir():
            for path in folder.glob('*.swift'):
                # The plug-in's own top-level types (nested ones may share an engine name).
                plugin_types |= set(re.findall(r'^(?:final\s+)?(?:class|struct|enum|actor|protocol)\s+(\w+)', code(path), re.M))
        for path in self.engine():
            with self.subTest(file=path.name):
                text = code(path)
                self.assertIsNone(re.search(r'\bVLC\w*|AetherEngine|canImport\(VLCKit\)', text))
                for name in plugin_types:
                    self.assertIsNone(re.search(r'\b' + name + r'\b', text), path.name + ' names the plug-in type ' + name)

    def test_generators_dispatch_by_registry(self):
        for name in ('project.py', 'build-app.py', 'renewal.py', 'registry.py'):
            with self.subTest(script=name):
                self.assertIsNone(re.search(r"\bkey\s*[!=]=\s*'", (ENGINE / 'scripts' / name).read_text()))


class Registries(unittest.TestCase):
    def generate(self, root, key, simulator=False):
        environment = {k: v for k, v in os.environ.items() if k != 'SIMULATOR'}
        if simulator: environment['SIMULATOR'] = '1'
        subprocess.run([sys.executable, str(ENGINE / 'scripts/project.py'), '--registry', str(root), key],
                       env=environment, check=True, capture_output=True)
        project = (root / 'build/app/VideoApp.xcodeproj/project.pbxproj').read_text()
        info = plistlib.loads((root / 'build' / key / 'Info.plist').read_bytes())
        return project, info

    def registry(self, folder, apps, **settings):
        (folder / 'apps.json').write_text(json.dumps(dict(settings, apps=apps)))
        return folder

    def test_apps_of_a_registry_compile_the_same_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            plugin = root / 'Providers/site'; plugin.mkdir(parents=True)
            (plugin / 'SiteList.swift').write_text('final class FixtureList {}\n')
            (plugin / 'SiteChecks.swift').write_text('#if targetEnvironment(simulator)\nfinal class FixtureChecks {}\n#endif\n')
            (plugin / 'plugin.json').write_text(json.dumps({'lists': {'site': 'FixtureList'}, 'checks': {'-site-check': 'FixtureChecks'}}))
            self.registry(root, {'recordings': {'name': 'Fixture local', 'product': 'FixtureLocal', 'bundleId': 'test.local', 'provider': 'fixture'},
                                 'site': {'name': 'Fixture', 'product': 'Fixture', 'bundleId': 'test.site', 'provider': 'fixture-live',
                                          'native': 'site', 'live': True, 'url': 'https://site.test/',
                                          'keys': {'SiteKey': 'Private/site-key'}}},
                          plugins=['Providers/site'], pcServer='https://pc.test:1', pcAwayServer='https://away.test/pc',
                          listNames={'fixture': 'Fixture'}, listsUsage='Lists on your home network.')
            (root / 'Private').mkdir(); (root / 'Private/site-key').write_text('secret\n')
            sources = {}
            for key in ('recordings', 'site'):
                project, info = self.generate(root, key)
                sources[key] = sorted(re.findall(r'"path" = "([^"\n]+\.swift)"', project))
            self.assertEqual(sources['recordings'], sources['site'], 'every app of a registry shares one module')
            names = [pathlib.Path(p).name for p in sources['site']]
            self.assertIn('SiteList.swift', names); self.assertIn('Plugins.generated.swift', names)
            self.assertNotIn('SiteChecks.swift', names, 'simulator checks never enter a phone build')
            glue = (root / 'build/app/Plugins.generated.swift').read_text()
            self.assertIn('case "site": return NativeLists.open(FixtureList.self)', glue)
            self.assertIn('if arguments.contains("-site-check") { return FixtureChecks() }', glue)
            self.assertEqual((info['NativeList'], info['LiveProviders'], info['StartURL'], info['SiteKey']), ('site', ['fixture-live'], 'https://site.test/', 'secret'))
            self.assertEqual((info['PCServer'], info['PCAwayServer'], info['ListNames']), ('https://pc.test:1', 'https://away.test/pc', {'fixture': 'Fixture'}))
            _, local = self.generate(root, 'recordings')
            self.assertEqual((local['LocalProvider'], local['LocalMediaKind'], local['StartURL'], local['LiveProviders']), ('fixture', 'hls', 'https://pc.test:1/', []))
            simulated, _ = self.generate(root, 'site', simulator=True)
            self.assertIn('SiteChecks.swift', simulated)

    def test_declared_inputs_exist(self):
        # ios-push freezes these inputs; a missing one refuses every push.
        declared = json.loads(subprocess.check_output([sys.executable, str(ENGINE / 'scripts/renewal.py'), '--team', 'T', '--device', 'D'], text=True))
        for app in declared['apps']:
            for name in app['inputs']:
                with self.subTest(app=app['name'], input=name):
                    self.assertTrue((ENGINE / name).exists(), name + ' is a build input but does not exist')

    def test_the_demo_registry(self):
        registry = Registry()
        self.assertEqual(registry.root, ENGINE)
        for folder in registry.plugins():
            self.assertTrue((folder / 'plugin.json').is_file(), folder)


if __name__ == '__main__':
    unittest.main()
