"""Generate the shared VideoApp host for exactly one provider from providers.json."""
import hashlib
import json
import os
import plistlib
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
registry = json.loads((root/'providers.json').read_text())
if len(sys.argv) > 1 and sys.argv[1] == 'bunkr':
    script = root/'Bunkr/project.py'
    os.execv(sys.executable, [sys.executable, str(script), *sys.argv[1:]])
if len(sys.argv) != 2 or sys.argv[1] not in registry: raise SystemExit('Supply exactly one provider: ' + ', '.join(registry))
key = sys.argv[1]
config = registry[key]
probe = os.environ.get('DECODER_PROBE') == '1'
if probe:
    assert key == 'bunkr'
    config = dict(config, product='OriginalVideoProbe', name='Original video check', bundleId='com.visar.OriginalVideoProbe.paid', build='1')
product = config['product']
source_hash = hashlib.sha256(key.encode())
source_files = list((root/'VideoApp').glob('*.swift')) + list((root/'Shared').glob('*.swift')) + list((root/'Kit/Sources').rglob('*.swift'))
source_files += [root/'providers.json', root/'scripts/project.py', root/'scripts/build-provider.py', root/'Kit/Package.swift']
if key == 'bunkr': source_files += [root/'ThirdParty/VLCKit/Package.swift', root/'scripts/prepare-vlckit.py']
for source in sorted(source_files):
    source_hash.update(str(source.relative_to(root)).encode()+b'\0')
    source_hash.update(hashlib.sha256(source.read_bytes()).digest())
source_revision = source_hash.hexdigest()[:16]
generated = root/'build'/key
projectdir = generated/(product+'.xcodeproj')
projectdir.mkdir(parents=True, exist_ok=True)
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
        filetype = 'folder' if (root/path).is_dir() else {'swift': 'sourcecode.swift', 'js': 'sourcecode.javascript', 'json': 'text.json', 'html': 'text.html', 'txt': 'text'}[path.rsplit('.', 1)[1]]
        ref = obj(path, 'PBXFileReference', lastKnownFileType=filetype, path=str(root/path), sourceTree='<group>')
        if ref not in files: files.append(ref)
        refs.append(obj(target+kind+path, 'PBXBuildFile', fileRef=ref))
    return obj(target+kind, 'PBX'+kind+'BuildPhase', buildActionMask=2147483647, files=refs, runOnlyForDeploymentPostprocessing=0)
common = dict(CODE_SIGN_STYLE='Automatic', CURRENT_PROJECT_VERSION=config.get('build', '1'), MARKETING_VERSION='1.0',
    GENERATE_INFOPLIST_FILE='NO', PRODUCT_NAME='$(TARGET_NAME)', TARGETED_DEVICE_FAMILY='1', SWIFT_VERSION='5.0',
    IPHONEOS_DEPLOYMENT_TARGET='26.0', CLANG_ENABLE_MODULES='YES', SDKROOT='iphoneos', SUPPORTED_PLATFORMS='iphoneos iphonesimulator')
if probe: common['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = 'ORIGINAL_CODEC_PROBE'
# Tango's Google login arrives through the Tango Login Safari helper and a shared Keychain group.
login = config.get('tangoLogin') is True
entitlements = generated/'Login.entitlements'
if login:
    data = plistlib.dumps({'keychain-access-groups': ['$(AppIdentifierPrefix)'+config['bundleId']]})
    if not entitlements.exists() or entitlements.read_bytes() != data: entitlements.write_bytes(data)
plist_base = dict(CFBundleDevelopmentRegion='en', CFBundleExecutable='$(EXECUTABLE_NAME)', CFBundleIdentifier='$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleInfoDictionaryVersion='6.0', CFBundleName='$(PRODUCT_NAME)', CFBundleShortVersionString='$(MARKETING_VERSION)',
    CFBundleVersion='$(CURRENT_PROJECT_VERSION)')
if login: plist_base['LoginKeychainGroup'] = '$(DEVELOPMENT_TEAM).'+config['bundleId']

products, targets, embedded, dependencies = [], [], [], []
web = config.get('webExtensions', {})
for suffix in config.get('extensions', []):
    name = product + suffix
    if suffix == 'Login' and login:
        sources = ['Shared/Login.swift', 'Login/Handler.swift']
        resources = ['Login/Resources/' + f for f in ['manifest.json', 'popup.html', 'popup.js', 'cookies.js']]
        display = config['name'] + ' Login'
    elif suffix in web:
        # Prepared Safari web extensions (staged by deploy.py sync) with a no-op native handler.
        sources = ['Extension/Handler.swift']
        resources = ['build/' + key + '/' + suffix + '/' + f for f in ['manifest.json', 'content.js', 'background.js']]
        display = web[suffix]['name']
    else: raise SystemExit('Unsupported extension: ' + suffix)
    phases = [phase(name, 'Sources', sources), phase(name, 'Resources', resources), phase(name, 'Frameworks', [])]
    product_ref = obj(name+'Product', 'PBXFileReference', explicitFileType='wrapper.app-extension', includeInIndex=0,
                      path=name+'.appex', sourceTree='BUILT_PRODUCTS_DIR')
    products.append(product_ref)
    settings = dict(common, INFOPLIST_FILE=str(generated/(suffix+'-Info.plist')), PRODUCT_BUNDLE_IDENTIFIER=config['bundleId']+'.'+suffix,
                    APPLICATION_EXTENSION_API_ONLY='YES', SKIP_INSTALL='YES')
    if suffix == 'Login': settings['CODE_SIGN_ENTITLEMENTS'] = str(entitlements)
    targets.append(obj(name+'Target', 'PBXNativeTarget', buildConfigurationList=config_list(name, settings), buildPhases=phases, buildRules=[],
        dependencies=[], name=name, productName=name, productReference=product_ref, productType='com.apple.product-type.app-extension'))
    (generated/(suffix+'-Info.plist')).write_bytes(plistlib.dumps(dict(plist_base, CFBundleDisplayName=display,
        CFBundlePackageType='XPC!', NSExtension=dict(NSExtensionPointIdentifier='com.apple.Safari.web-extension',
                                                     NSExtensionPrincipalClass='$(PRODUCT_MODULE_NAME).Handler'))))
    embedded.append(obj('embed'+suffix, 'PBXBuildFile', fileRef=product_ref, settings={'ATTRIBUTES': ['CodeSignOnCopy', 'RemoveHeadersOnCopy']}))
    proxy = obj('proxy'+suffix, 'PBXContainerItemProxy', containerPortal=ident('Project'), proxyType=1,
                remoteGlobalIDString=ident(name+'Target'), remoteInfo=name)
    dependencies.append(obj('dependency'+suffix, 'PBXTargetDependency', target=ident(name+'Target'), targetProxy=proxy))

sources = sorted(str(p.relative_to(root)) for p in (root/'VideoApp').glob('*.swift')) + ['Shared/Login.swift']
if key == 'bunkr':
    overrides = {p.name: str(p.relative_to(root)) for p in (root/'Bunkr').glob('*.swift')}
    sources = [overrides.pop(Path(p).name, p) for p in sources] + sorted(overrides.values())
if probe:
    sources = ['VideoApp/'+name+'.swift' for name in ['ViewerVideo','ViewerDecoder','VLCVideoDecoder','VideoTerminalState','ViewerUnit','ViewerHost','ViewerPlaybackPolicy']] + ['Tests/OriginalVideoProbe.swift']
# NativeKit (apps/ios/Kit, vendored from ios-tools native/Kit) as a local package.
kit = obj('KitPackage', 'XCLocalSwiftPackageReference', relativePath=os.path.relpath(root/'Kit', generated))
kit_names = ['KitCore', 'KitNet', 'KitHTML', 'KitLifecycle', 'KitMigration', 'KitTestHooks']
if os.environ.get('SIMULATOR'): kit_names += ['KitReader']  # Static zoom checks only.
kit_products = [obj('KitProduct'+name, 'XCSwiftPackageProductDependency', productName=name) for name in kit_names]
packages = [kit]
if key == 'bunkr':
    decoder_package = obj('DecoderPackage', 'XCLocalSwiftPackageReference', relativePath=os.path.relpath(root/'ThirdParty/VLCKit', generated))
    packages.append(decoder_package)
    kit_products.append(obj('DecoderProduct', 'XCSwiftPackageProductDependency', productName='VLCKit', package=decoder_package))
frameworks = obj(product+'Frameworks', 'PBXFrameworksBuildPhase', buildActionMask=2147483647,
                 files=[obj('KitBuild'+ref, 'PBXBuildFile', productRef=ref) for ref in kit_products], runOnlyForDeploymentPostprocessing=0)
resources = ['ThirdParty/VLCKit/LICENSE.txt'] if key == 'bunkr' else []
phases = [phase(product, 'Sources', sources), phase(product, 'Resources', resources), frameworks]
if embedded:
    phases.append(obj('Embed', 'PBXCopyFilesBuildPhase', buildActionMask=2147483647, dstPath='', dstSubfolderSpec=13,
                      files=embedded, name='Embed App Extensions', runOnlyForDeploymentPostprocessing=0))
product_ref = obj('Product', 'PBXFileReference', explicitFileType='wrapper.application', includeInIndex=0, path=product+'.app', sourceTree='BUILT_PRODUCTS_DIR')
products.insert(0, product_ref)
settings = dict(common, INFOPLIST_FILE=str(generated/'Info.plist'), PRODUCT_BUNDLE_IDENTIFIER=config['bundleId'])
if key == 'bunkr': settings['LD_RUNPATH_SEARCH_PATHS'] = '$(inherited) @executable_path/Frameworks'
if login: settings['CODE_SIGN_ENTITLEMENTS'] = str(entitlements)
targets.insert(0, obj('Target', 'PBXNativeTarget', buildConfigurationList=config_list(product, settings), buildPhases=phases, buildRules=[],
    dependencies=dependencies, name=product, productName=product, productReference=product_ref, productType='com.apple.product-type.application',
    packageProductDependencies=kit_products))
# Safari's iPhone orientations; no icon or launch artwork, like the other personal apps.
# The native viewer plays on through lock and the background (audio), and reaches the PC's
# website API and download lists itself (local network).
info = dict(plist_base, CFBundleDisplayName=config['name'], CFBundlePackageType='APPL', VideoSourceRevision=source_revision,
    LSRequiresIPhoneOS=True, UILaunchScreen={}, UIRequiredDeviceCapabilities=['arm64'],
    UISupportedInterfaceOrientations=['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    UIViewControllerBasedStatusBarAppearance=True, StartURL=config['url'], UIBackgroundModes=['audio'],
    UIApplicationSceneManifest={'UIApplicationSupportsMultipleScenes': False},
    NSAppTransportSecurity={'NSAllowsLocalNetworking': True},
    NSLocalNetworkUsageDescription='Add or remove streamers in your PC\'s download lists on your home network.')
if config.get('native'):
    # A native list of the sites (VideoApp/VaultList.swift, TangoList.swift).
    info['NativeList'] = config['native']
    if login: info['TangoLogin'] = True
    # The PC's Tango login for this phone needs its key (a private build input, never in Git).
    key = root/'Private'/'tango-phone-key'
    if config['native'] == 'tango' and key.exists(): info['TangoPhoneKey'] = key.read_text().strip()
else:
    info['NSLocalNetworkUsageDescription'] = 'Open your PC\'s ' + config['name'].removesuffix(' local') + ' videos on your home network.'
    # A native list on the PC's API (VideoApp/LocalList.swift) instead of the website.
    info['LocalProvider'] = key
    info['LocalMediaKind'] = config.get('mediaKind', 'hls')
if probe: info.pop('UIApplicationSceneManifest', None)
(generated/'Info.plist').write_bytes(plistlib.dumps(info))
product_group = obj('Products', 'PBXGroup', children=products, name='Products', sourceTree='<group>')
group = obj('Main', 'PBXGroup', children=files+[product_group], sourceTree='<group>')
project = obj('Project', 'PBXProject', buildConfigurationList=config_list('Project', {}), compatibilityVersion='Xcode 14.0',
    developmentRegion='en', knownRegions=['en', 'Base'], mainGroup=group, productRefGroup=product_group, projectDirPath='', projectRoot='', targets=targets,
    packageReferences=packages)
def encode(value):
    if isinstance(value, dict): return '{'+''.join(json.dumps(k)+' = '+encode(v)+';\n' for k, v in value.items())+'}'
    if isinstance(value, list): return '('+','.join(encode(v) for v in value)+')'
    return json.dumps(value)
document = dict(archiveVersion=1, classes={}, objectVersion=60, objects=objects, rootObject=project)
(projectdir/'project.pbxproj').write_text('// !$*UTF8*$!\n'+encode(document)+'\n')
