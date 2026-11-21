"""Generate the Xcode project of one app from apps.json: the shared shell (App/), NativeKit (Kit/)
and the app's Info.plist (build/<app>/Info.plist), in build/app/VideoApp.xcodeproj.

    python3 scripts/project.py live-a-local

Every app is the same target, VideoApp, with identical compiler inputs, so the apps share compiled
modules. What differs is the Info.plist: the provider the app shows, its traits (ProviderTraits.swift)
and where the PC is. A deployment's own settings come from apps.local.json beside apps.json (never in
Git): {"bundlePrefix": "com.example", "pcServer": "https://192.168.1.10:29999", "pcAwayServer": ""}."""
import hashlib
import json
import os
import plistlib
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
registry = json.loads((root/'apps.json').read_text())
local_file = root/'apps.local.json'
local = json.loads(local_file.read_text()) if local_file.exists() else {}
if len(sys.argv) != 2 or sys.argv[1] not in registry: raise SystemExit('Supply exactly one app: ' + ', '.join(registry))
key = sys.argv[1]
config = registry[key]
product = config['product']
bundle_id = local.get('bundlePrefix', 'com.example.videoplatform') + '.' + config['bundleSuffix']
pc_server = local.get('pcServer', 'https://localhost:29999')
# The simulated tournament sites' download lists, by site.
list_names = {'ts-live': 'Wimbledon', 'ladder-live': 'Roland-Garros', 'fmp4-live': 'Australian Open'}
# Where the phone reaches a live site with an account: the demo pod's port on the host
# (deploy/demo); apps.local.json "liveSites" overrides it, and "phoneKeys" holds the PC's key
# for the site's phone sign-in (the shared state's <site>-phone-key; never in Git).
live_sites = dict({'ts-live': 'https://localhost:28081'}, **local.get('liveSites', {}))

sources = sorted(str(p.relative_to(root)) for p in (root/'App').glob('*.swift'))
source_hash = hashlib.sha256(key.encode())
for source in sorted([root/s for s in sources] + list((root/'Kit/Sources').rglob('*.swift')) + [root/'apps.json', root/'scripts/project.py', root/'Kit/Package.swift']):
    source_hash.update(str(source.relative_to(root)).encode()+b'\0')
    source_hash.update(hashlib.sha256(source.read_bytes()).digest())
source_revision = source_hash.hexdigest()[:16]
generated = root/'build'/key
projectdir = root/'build'/'app'/'VideoApp.xcodeproj'
projectdir.mkdir(parents=True, exist_ok=True)
generated.mkdir(parents=True, exist_ok=True)

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
        ref = obj(path, 'PBXFileReference', lastKnownFileType='sourcecode.swift', path=str(root/path), sourceTree='<group>')
        if ref not in files: files.append(ref)
        refs.append(obj(target+kind+path, 'PBXBuildFile', fileRef=ref))
    return obj(target+kind, 'PBX'+kind+'BuildPhase', buildActionMask=2147483647, files=refs, runOnlyForDeploymentPostprocessing=0)

common = dict(CODE_SIGN_STYLE='Automatic', CURRENT_PROJECT_VERSION=config.get('build', '1'), MARKETING_VERSION='1.0',
    GENERATE_INFOPLIST_FILE='NO', PRODUCT_NAME='$(TARGET_NAME)', TARGETED_DEVICE_FAMILY='1', SWIFT_VERSION='5.0',
    IPHONEOS_DEPLOYMENT_TARGET='26.0', CLANG_ENABLE_MODULES='YES', SDKROOT='iphoneos', SUPPORTED_PLATFORMS='iphoneos iphonesimulator')
plist_base = dict(CFBundleDevelopmentRegion='en', CFBundleExecutable='$(EXECUTABLE_NAME)', CFBundleIdentifier='$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion='6.0', CFBundleName='$(PRODUCT_NAME)', CFBundleShortVersionString='$(MARKETING_VERSION)',
    CFBundleVersion='$(CURRENT_PROJECT_VERSION)')

# NativeKit (apps/ios/Kit, vendored from ios-tools native/Kit) as a local package.
kit = obj('KitPackage', 'XCLocalSwiftPackageReference', relativePath=os.path.relpath(root/'Kit', projectdir.parent))
kit_names = ['KitCore', 'KitNet', 'KitHTML', 'KitLifecycle', 'KitMigration', 'KitTestHooks']
if os.environ.get('SIMULATOR'): kit_names += ['KitReader']  # Static zoom checks only.
kit_products = [obj('KitProduct'+name, 'XCSwiftPackageProductDependency', productName=name) for name in kit_names]
frameworks = obj(product+'Frameworks', 'PBXFrameworksBuildPhase', buildActionMask=2147483647,
                 files=[obj('KitBuild'+ref, 'PBXBuildFile', productRef=ref) for ref in kit_products], runOnlyForDeploymentPostprocessing=0)
phases = [phase(product, 'Sources', sources), phase(product, 'Resources', []), frameworks]
product_ref = obj('Product', 'PBXFileReference', explicitFileType='wrapper.application', includeInIndex=0, path=product+'.app', sourceTree='BUILT_PRODUCTS_DIR')
settings = dict(common, INFOPLIST_FILE=str(generated/'Info.plist'), PRODUCT_BUNDLE_IDENTIFIER=bundle_id,
                PRODUCT_NAME=product, PRODUCT_MODULE_NAME='VideoApp')
target = obj('Target', 'PBXNativeTarget', buildConfigurationList=config_list(product, settings), buildPhases=phases, buildRules=[],
    dependencies=[], name='VideoApp', productName=product, productReference=product_ref, productType='com.apple.product-type.application',
    packageProductDependencies=kit_products)

# Every orientation but upside down; no icon or launch artwork. The viewer plays on through lock
# and the background (audio), and reaches the PC's API itself (local network).
provider = config['provider']
info = dict(plist_base, CFBundleDisplayName=config['name'], CFBundlePackageType='APPL', VideoSourceRevision=source_revision,
    LSRequiresIPhoneOS=True, UILaunchScreen={}, UIRequiredDeviceCapabilities=['arm64'],
    UISupportedInterfaceOrientations=['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    UIViewControllerBasedStatusBarAppearance=True, UIBackgroundModes=['audio'],
    UIApplicationSceneManifest={'UIApplicationSupportsMultipleScenes': False},
    NSAppTransportSecurity={'NSAllowsLocalNetworking': True},
    PCServer=pc_server, PCAwayServer=local.get('pcAwayServer', ''), ListNames=list_names,
    LiveProviders=[provider] if config.get('native') else [], OriginalFileProviders=[provider] if config.get('mediaKind') == 'file' else [])
if config.get('native'):
    # The site's own list (App/NativeLists.swift), and the PC for its download lists.
    info['NativeList'] = config['native']
    info['NSLocalNetworkUsageDescription'] = 'Add or remove channels in your PC\'s download lists on your home network.'
    if config['native'] == 'live':
        info['LiveSite'] = live_sites[provider]
        info['PhoneKey'] = local.get('phoneKeys', {}).get(provider, '')
else:
    # The PC's recordings of one site (App/LocalList.swift).
    info['LocalProvider'] = provider
    info['LocalMediaKind'] = config.get('mediaKind', 'hls')
    info['StartURL'] = pc_server.rstrip('/') + '/'
    info['NSLocalNetworkUsageDescription'] = 'Open your PC\'s ' + config['name'].removesuffix(' local') + ' videos on your home network.'
(generated/'Info.plist').write_bytes(plistlib.dumps(info))

product_group = obj('Products', 'PBXGroup', children=[product_ref], name='Products', sourceTree='<group>')
group = obj('Main', 'PBXGroup', children=files+[product_group], sourceTree='<group>')
project = obj('Project', 'PBXProject', buildConfigurationList=config_list('Project', {}), compatibilityVersion='Xcode 14.0',
    developmentRegion='en', knownRegions=['en', 'Base'], mainGroup=group, productRefGroup=product_group, projectDirPath='', projectRoot='', targets=[target],
    packageReferences=[kit])
def encode(value):
    if isinstance(value, dict): return '{'+''.join(json.dumps(k)+' = '+encode(v)+';\n' for k, v in value.items())+'}'
    if isinstance(value, list): return '('+','.join(encode(v) for v in value)+')'
    return json.dumps(value)
document = dict(archiveVersion=1, classes={}, objectVersion=60, objects=objects, rootObject=project)
(projectdir/'project.pbxproj').write_text('// !$*UTF8*$!\n'+encode(document)+'\n')
print(f'{key}: {projectdir} ({product}, {bundle_id}, {source_revision})')
