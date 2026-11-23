"""Generate the Xcode project of one app of a registry (scripts/registry.py): the engine (App/),
its plug-ins, NativeKit (Kit/) and the app's Info.plist, in <registry>/build/app/VideoApp.xcodeproj.

    python3 scripts/project.py live-a-local                  # the public registry (apps/ios)
    python3 engine/scripts/project.py --registry . <app>     # a deployment's, from its folder

Every app of a registry is the same target, VideoApp, with identical compiler inputs, so the apps
share compiled modules. What differs is the Info.plist: the provider the app shows, its traits
(App/ProviderTraits.swift), where the PC is, the keys it carries, and its Safari web extensions
(staged by the deployment in build/<app>/<extension>/). An app with `overrides` has its own
generator in that folder."""
import argparse
import hashlib
import json
import os
import plistlib
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from registry import ENGINE, Registry, write_plugins

parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
parser.add_argument('--registry', help='the registry folder (default: this engine\'s apps/ios)')
parser.add_argument('app')
args = parser.parse_args()
registry = Registry(args.registry)
root = registry.root
if args.app not in registry.apps: raise SystemExit('Supply exactly one app: ' + ', '.join(registry.apps))
key = args.app
config = registry.apps[key]
# A provider with its own engine has its own generator in its override folder.
if config.get('overrides'):
    os.execv(sys.executable, [sys.executable, str(root / config['overrides'] / 'project.py'), key])
# The engine plays the PC's HLS recordings, original files and the plug-ins' sites through AVPlayer.
simulator = bool(os.environ.get('SIMULATOR'))
product = config['product']
bundle_id = registry.bundle_id(key)
pc_server = registry.get('pcServer', 'https://localhost:29999')
provider = config['provider']
generated = root / 'build' / key
projectdir = root / 'build' / 'app' / 'VideoApp.xcodeproj'
projectdir.mkdir(parents=True, exist_ok=True)
generated.mkdir(parents=True, exist_ok=True)

plugins_file = write_plugins(root / 'build' / 'app' / 'Plugins.generated.swift', registry.plugin_manifests())
sources = registry.sources(simulator) + [plugins_file]
inputs = sources + sorted((ENGINE / 'Kit/Sources').rglob('*.swift')) + [ENGINE / 'Kit/Package.swift', ENGINE / 'Extension/Handler.swift',
          ENGINE / 'scripts/project.py', ENGINE / 'scripts/registry.py', root / 'apps.json']
inputs += [folder / 'plugin.json' for folder in registry.plugins()]
def label(path):
    path = Path(path)
    return 'engine/' + str(path.relative_to(ENGINE)) if path.is_relative_to(ENGINE) else str(path.relative_to(root))
source_hash = hashlib.sha256(key.encode())
for source in sorted(inputs, key=label):
    source_hash.update(label(source).encode() + b'\0')
    source_hash.update(hashlib.sha256(Path(source).read_bytes()).digest())
source_revision = source_hash.hexdigest()[:16]

objects = {}
def ident(name): return hashlib.sha256(name.encode()).hexdigest()[:24].upper()
def obj(label, isa, **fields):
    identifier = ident(label)
    objects[identifier] = dict(isa=isa, **fields)
    return identifier
def config_list(name, settings):
    configs = [obj(name + variant, 'XCBuildConfiguration', buildSettings=settings, name=variant) for variant in ('Debug', 'Release')]
    return obj(name + 'configs', 'XCConfigurationList', buildConfigurations=configs, defaultConfigurationIsVisible=0, defaultConfigurationName='Release')

files = []
def phase(target, kind, paths):
    refs = []
    for path in paths:
        path = Path(path)
        filetype = {'.swift': 'sourcecode.swift', '.js': 'sourcecode.javascript', '.json': 'text.json'}[path.suffix]
        ref = obj(str(path), 'PBXFileReference', lastKnownFileType=filetype, path=str(path), sourceTree='<group>')
        if ref not in files: files.append(ref)
        refs.append(obj(target + kind + str(path), 'PBXBuildFile', fileRef=ref))
    return obj(target + kind, 'PBX' + kind + 'BuildPhase', buildActionMask=2147483647, files=refs, runOnlyForDeploymentPostprocessing=0)

common = dict(CODE_SIGN_STYLE='Automatic', CURRENT_PROJECT_VERSION=config.get('build', '1'), MARKETING_VERSION='1.0',
    GENERATE_INFOPLIST_FILE='NO', PRODUCT_NAME='$(TARGET_NAME)', TARGETED_DEVICE_FAMILY='1', SWIFT_VERSION='5.0',
    IPHONEOS_DEPLOYMENT_TARGET='26.0', CLANG_ENABLE_MODULES='YES', SDKROOT='iphoneos', SUPPORTED_PLATFORMS='iphoneos iphonesimulator')
plist_base = dict(CFBundleDevelopmentRegion='en', CFBundleExecutable='$(EXECUTABLE_NAME)', CFBundleIdentifier='$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion='6.0', CFBundleName='$(PRODUCT_NAME)', CFBundleShortVersionString='$(MARKETING_VERSION)',
    CFBundleVersion='$(CURRENT_PROJECT_VERSION)')

# Safari web extensions the app hosts (staged by the deployment), each with the no-op native handler.
products, targets, embedded, dependencies = [], [], [], []
web = config.get('webExtensions', {})
for suffix in config.get('extensions', []):
    if suffix not in web: raise SystemExit('Unsupported extension: ' + suffix)
    name = product + suffix
    resources = [generated / suffix / f for f in ['manifest.json', 'content.js', 'background.js']]
    phases = [phase(name, 'Sources', [ENGINE / 'Extension/Handler.swift']), phase(name, 'Resources', resources), phase(name, 'Frameworks', [])]
    product_ref = obj(name + 'Product', 'PBXFileReference', explicitFileType='wrapper.app-extension', includeInIndex=0,
                      path=name + '.appex', sourceTree='BUILT_PRODUCTS_DIR')
    products.append(product_ref)
    settings = dict(common, INFOPLIST_FILE=str(generated / (suffix + '-Info.plist')), PRODUCT_BUNDLE_IDENTIFIER=bundle_id + '.' + suffix,
                    APPLICATION_EXTENSION_API_ONLY='YES', SKIP_INSTALL='YES')
    targets.append(obj(name + 'Target', 'PBXNativeTarget', buildConfigurationList=config_list(name, settings), buildPhases=phases, buildRules=[],
        dependencies=[], name=name, productName=name, productReference=product_ref, productType='com.apple.product-type.app-extension'))
    (generated / (suffix + '-Info.plist')).write_bytes(plistlib.dumps(dict(plist_base, CFBundleDisplayName=web[suffix]['name'],
        CFBundlePackageType='XPC!', NSExtension=dict(NSExtensionPointIdentifier='com.apple.Safari.web-extension',
                                                     NSExtensionPrincipalClass='$(PRODUCT_MODULE_NAME).Handler'))))
    embedded.append(obj('embed' + suffix, 'PBXBuildFile', fileRef=product_ref, settings={'ATTRIBUTES': ['CodeSignOnCopy', 'RemoveHeadersOnCopy']}))
    proxy = obj('proxy' + suffix, 'PBXContainerItemProxy', containerPortal=ident('Project'), proxyType=1,
                remoteGlobalIDString=ident(name + 'Target'), remoteInfo=name)
    dependencies.append(obj('dependency' + suffix, 'PBXTargetDependency', target=ident(name + 'Target'), targetProxy=proxy))

# NativeKit (apps/ios/Kit, vendored from ios-tools native/Kit) as a local package.
kit = obj('KitPackage', 'XCLocalSwiftPackageReference', relativePath=os.path.relpath(ENGINE / 'Kit', projectdir.parent))
kit_names = ['KitCore', 'KitNet', 'KitHTML', 'KitLifecycle', 'KitMigration', 'KitTestHooks']
if simulator: kit_names += ['KitReader']  # Static zoom checks only.
kit_products = [obj('KitProduct' + name, 'XCSwiftPackageProductDependency', productName=name) for name in kit_names]
frameworks = obj(product + 'Frameworks', 'PBXFrameworksBuildPhase', buildActionMask=2147483647,
                 files=[obj('KitBuild' + ref, 'PBXBuildFile', productRef=ref) for ref in kit_products], runOnlyForDeploymentPostprocessing=0)
phases = [phase(product, 'Sources', sources), phase(product, 'Resources', []), frameworks]
if embedded:
    phases.append(obj('Embed', 'PBXCopyFilesBuildPhase', buildActionMask=2147483647, dstPath='', dstSubfolderSpec=13,
                      files=embedded, name='Embed App Extensions', runOnlyForDeploymentPostprocessing=0))
product_ref = obj('Product', 'PBXFileReference', explicitFileType='wrapper.application', includeInIndex=0, path=product + '.app', sourceTree='BUILT_PRODUCTS_DIR')
products.insert(0, product_ref)
settings = dict(common, INFOPLIST_FILE=str(generated / 'Info.plist'), PRODUCT_BUNDLE_IDENTIFIER=bundle_id,
                PRODUCT_NAME=product, PRODUCT_MODULE_NAME='VideoApp')
targets.insert(0, obj('Target', 'PBXNativeTarget', buildConfigurationList=config_list(product, settings), buildPhases=phases, buildRules=[],
    dependencies=dependencies, name='VideoApp', productName=product, productReference=product_ref, productType='com.apple.product-type.application',
    packageProductDependencies=kit_products))

# Every orientation but upside down; no icon or launch artwork. The viewer plays on through lock
# and the background (audio), and reaches the PC's API itself (local network).
info = dict(plist_base, CFBundleDisplayName=config['name'], CFBundlePackageType='APPL', VideoSourceRevision=source_revision,
    LSRequiresIPhoneOS=True, UILaunchScreen={}, UIRequiredDeviceCapabilities=['arm64'],
    UISupportedInterfaceOrientations=['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    UIViewControllerBasedStatusBarAppearance=True, UIBackgroundModes=['audio'],
    UIApplicationSceneManifest={'UIApplicationSupportsMultipleScenes': False},
    NSAppTransportSecurity={'NSAllowsLocalNetworking': True},
    PCServer=pc_server, PCAwayServer=registry.get('pcAwayServer', ''), ListNames=registry.get('listNames', {}),
    LiveProviders=[provider] if config.get('live') else [], OriginalFileProviders=[provider] if config.get('mediaKind') == 'file' else [])
if config.get('url'): info['StartURL'] = config['url']
if config.get('native'):
    # A plug-in's site list (App/NativeLists.swift), and the PC for its download lists.
    info['NativeList'] = config['native']
    info['NSLocalNetworkUsageDescription'] = registry.get('listsUsage', 'Add or remove channels in your PC\'s download lists on your home network.')
    if provider in registry.get('liveSites', {}): info['LiveSite'] = registry.get('liveSites')[provider]
    if provider in registry.get('phoneKeys', {}): info['PhoneKey'] = registry.get('phoneKeys')[provider]
else:
    # The PC's recordings (or a file host's library) of one provider (App/LocalList.swift).
    info['LocalProvider'] = provider
    info['LocalMediaKind'] = config.get('mediaKind', 'hls')
    info.setdefault('StartURL', pc_server.rstrip('/') + '/')
    info['NSLocalNetworkUsageDescription'] = 'Open your PC\'s ' + config['name'].removesuffix(' local') + ' videos on your home network.'
# Private build inputs (never in Git), read from the registry folder when present: e.g. a site's
# phone sign-in key or the key the PC's public address asks for.
for name, path in config.get('keys', {}).items():
    if (root / path).exists(): info[name] = (root / path).read_text().strip()
(generated / 'Info.plist').write_bytes(plistlib.dumps(info))

product_group = obj('Products', 'PBXGroup', children=products, name='Products', sourceTree='<group>')
group = obj('Main', 'PBXGroup', children=files + [product_group], sourceTree='<group>')
project = obj('Project', 'PBXProject', buildConfigurationList=config_list('Project', {}), compatibilityVersion='Xcode 14.0',
    developmentRegion='en', knownRegions=['en', 'Base'], mainGroup=group, productRefGroup=product_group, projectDirPath='', projectRoot='', targets=targets,
    packageReferences=[kit])
def encode(value):
    if isinstance(value, dict): return '{' + ''.join(json.dumps(k) + ' = ' + encode(v) + ';\n' for k, v in value.items()) + '}'
    if isinstance(value, list): return '(' + ','.join(encode(v) for v in value) + ')'
    return json.dumps(value)
document = dict(archiveVersion=1, classes={}, objectVersion=60, objects=objects, rootObject=project)
(projectdir / 'project.pbxproj').write_text('// !$*UTF8*$!\n' + encode(document) + '\n')
print(f'{key}: {projectdir} ({product}, {bundle_id}, {source_revision})')
