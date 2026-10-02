"""Generate the shared LocalVideos host for exactly one provider from providers.json."""
import hashlib
import json
import plistlib
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
registry = json.loads((root/'providers.json').read_text())
if len(sys.argv) != 2 or sys.argv[1] not in registry: raise SystemExit('Supply exactly one provider: ' + ', '.join(registry))
key = sys.argv[1]
config = registry[key]
product = config['product']
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
build_files = []
for path in sorted(str(p.relative_to(root)) for p in (root/'LocalVideos').glob('*.swift')):
    ref = obj(path, 'PBXFileReference', lastKnownFileType='sourcecode.swift', path=str(root/path), sourceTree='<group>')
    files.append(ref)
    build_files.append(obj('build'+path, 'PBXBuildFile', fileRef=ref))
phases = [obj('Sources', 'PBXSourcesBuildPhase', buildActionMask=2147483647, files=build_files, runOnlyForDeploymentPostprocessing=0),
          obj('Resources', 'PBXResourcesBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0),
          obj('Frameworks', 'PBXFrameworksBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0)]
product_ref = obj('Product', 'PBXFileReference', explicitFileType='wrapper.application', includeInIndex=0, path=product+'.app', sourceTree='BUILT_PRODUCTS_DIR')
settings = dict(CODE_SIGN_STYLE='Automatic', CURRENT_PROJECT_VERSION='1', MARKETING_VERSION='1.0', GENERATE_INFOPLIST_FILE='NO',
    INFOPLIST_FILE=str(generated/'Info.plist'), PRODUCT_BUNDLE_IDENTIFIER=config['bundleId'], PRODUCT_NAME='$(TARGET_NAME)',
    TARGETED_DEVICE_FAMILY='1', SWIFT_VERSION='5.0', IPHONEOS_DEPLOYMENT_TARGET='17.0', CLANG_ENABLE_MODULES='YES', SDKROOT='iphoneos')
target = obj('Target', 'PBXNativeTarget', buildConfigurationList=config_list(product, settings), buildPhases=phases, buildRules=[],
    dependencies=[], name=product, productName=product, productReference=product_ref, productType='com.apple.product-type.application')
# Safari's iPhone orientations; no icon, launch artwork or entitlements, like the other personal apps.
info = dict(CFBundleDevelopmentRegion='en', CFBundleDisplayName=config['name'], CFBundleExecutable='$(EXECUTABLE_NAME)',
    CFBundleIdentifier='$(PRODUCT_BUNDLE_IDENTIFIER)', CFBundleInfoDictionaryVersion='6.0', CFBundleName='$(PRODUCT_NAME)',
    CFBundlePackageType='APPL', CFBundleShortVersionString='$(MARKETING_VERSION)', CFBundleVersion='$(CURRENT_PROJECT_VERSION)',
    LSRequiresIPhoneOS=True, UILaunchScreen={}, UIRequiredDeviceCapabilities=['arm64'],
    UISupportedInterfaceOrientations=['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    UIViewControllerBasedStatusBarAppearance=True, NSAppTransportSecurity={'NSAllowsLocalNetworking': True},
    NSLocalNetworkUsageDescription='Open your PC\'s ' + config['name'].removesuffix(' local') + ' videos on your home network.',
    LocalVideosURL=config['url'])
(generated/'Info.plist').write_bytes(plistlib.dumps(info))
product_group = obj('Products', 'PBXGroup', children=[product_ref], name='Products', sourceTree='<group>')
group = obj('Main', 'PBXGroup', children=files+[product_group], sourceTree='<group>')
project = obj('Project', 'PBXProject', buildConfigurationList=config_list('Project', {}), compatibilityVersion='Xcode 14.0',
    developmentRegion='en', knownRegions=['en', 'Base'], mainGroup=group, productRefGroup=product_group, projectDirPath='', projectRoot='', targets=[target])
def encode(value):
    if isinstance(value, dict): return '{'+''.join(json.dumps(k)+' = '+encode(v)+';\n' for k, v in value.items())+'}'
    if isinstance(value, list): return '('+','.join(encode(v) for v in value)+')'
    return json.dumps(value)
document = dict(archiveVersion=1, classes={}, objectVersion=56, objects=objects, rootObject=project)
(projectdir/'project.pbxproj').write_text('// !$*UTF8*$!\n'+encode(document)+'\n')
