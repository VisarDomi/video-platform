"""Generate one shared native host, selecting a required provider."""
import hashlib
import json
import plistlib
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
registry = json.loads((root/'build/providers.json').read_text())
if len(sys.argv) != 2 or sys.argv[1] not in registry: raise SystemExit('One supported provider is required')
key = sys.argv[1]
config = registry[key]
product = config['name']
generated = root/'build'/key
projectdir = generated/(product+'.xcodeproj')
projectdir.mkdir(parents=True,exist_ok=True)
objects = {}
def ident(name): return hashlib.sha256(name.encode()).hexdigest()[:24].upper()
def obj(label, isa, **fields):
    key = ident(label)
    objects[key] = dict(isa=isa, **fields)
    return key
def config_list(name, settings):
    configs = [obj(name + variant, 'XCBuildConfiguration', buildSettings=settings, name=variant) for variant in ('Debug', 'Release')]
    return obj(name + 'configs', 'XCConfigurationList', buildConfigurations=configs, defaultConfigurationIsVisible=0, defaultConfigurationName='Release')
files = []
products = []
targets = []
for name, kind in [(product+suffix,suffix) for suffix in config['extensions']] + [(product,'App')]:
    extension = kind != 'App'
    sources = (['Shared/Login.swift', 'Login/Handler.swift'] if kind == 'Login' else ['Xvid/Handler.swift']) if extension else [str(p.relative_to(root)) for p in sorted((root/'App').glob('*.swift'))]+['Shared/Login.swift']
    resources = (['Login/Resources/' + file for file in ['manifest.json', 'popup.html', 'popup.js', 'cookies.js']] if kind == 'Login' else ['build/'+key+'/Xvid/'+file for file in ['manifest.json','content.js']]) if extension else ['build/'+key+'/Web', 'Resources/LocalCA.cer']
    phases = []
    for phase_kind, paths in [('Sources', sources), ('Resources', resources)]:
        refs = []
        for path in paths:
            ref = obj(path, 'PBXFileReference', lastKnownFileType='sourcecode.swift' if path.endswith('.swift') else ('folder' if path.endswith('/Web') else 'text'), path=str(root/path), sourceTree='<group>')
            files.append(ref)
            refs.append(obj(name+path, 'PBXBuildFile', fileRef=ref))
        phases.append(obj(name+phase_kind, 'PBX'+phase_kind+'BuildPhase', buildActionMask=2147483647, files=refs, runOnlyForDeploymentPostprocessing=0))
    phases.append(obj(name+'Frameworks', 'PBXFrameworksBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0))
    bundle = config['bundleId'] + ('.'+kind if extension else '')
    product_ref = obj(name+'Product', 'PBXFileReference', explicitFileType='wrapper.app-extension' if extension else 'wrapper.application', includeInIndex=0, path=name+('.appex' if extension else '.app'), sourceTree='BUILT_PRODUCTS_DIR')
    products.append(product_ref)
    settings = dict(CODE_SIGN_STYLE='Automatic', CURRENT_PROJECT_VERSION='9', GENERATE_INFOPLIST_FILE='NO',
        INFOPLIST_FILE=str(generated/(kind+'-Info.plist' if extension else 'Info.plist')), MARKETING_VERSION='1.0', PRODUCT_BUNDLE_IDENTIFIER=bundle,
        PRODUCT_NAME='$(TARGET_NAME)', TARGETED_DEVICE_FAMILY='1',
        SWIFT_VERSION='5.0', IPHONEOS_DEPLOYMENT_TARGET='17.0', CLANG_ENABLE_MODULES='YES', SDKROOT='iphoneos')
    if kind != 'Xvid': settings['CODE_SIGN_ENTITLEMENTS'] = str(generated/'Login.entitlements')
    dependencies = []
    if extension:
        settings.update(APPLICATION_EXTENSION_API_ONLY='YES', SKIP_INSTALL='YES')
    else:
        embedded = []
        for suffix in config['extensions']:
            target = product+suffix
            embedded.append(obj('embed'+suffix, 'PBXBuildFile', fileRef=ident(target+'Product'), settings={'ATTRIBUTES':['CodeSignOnCopy','RemoveHeadersOnCopy']}))
            proxy = obj('proxy'+suffix, 'PBXContainerItemProxy', containerPortal=ident('Project'), proxyType=1, remoteGlobalIDString=ident(target+'Target'), remoteInfo=target)
            dependencies.append(obj('dependency'+suffix,'PBXTargetDependency',target=ident(target+'Target'),targetProxy=proxy))
        phases.append(obj('Embed', 'PBXCopyFilesBuildPhase', buildActionMask=2147483647, dstPath='', dstSubfolderSpec=13,
            files=embedded, name='Embed App Extensions', runOnlyForDeploymentPostprocessing=0))
    targets.append(obj(name+'Target','PBXNativeTarget', buildConfigurationList=config_list(name,settings),buildPhases=phases,
        buildRules=[],dependencies=dependencies,name=name,productName=name,productReference=product_ref,
        productType='com.apple.product-type.app-extension' if extension else 'com.apple.product-type.application'))
    info = dict(CFBundleDevelopmentRegion='en', CFBundleDisplayName=('Xvid' if kind == 'Xvid' else product+' Login') if extension else product,
        CFBundleExecutable='$(EXECUTABLE_NAME)', CFBundleIdentifier='$(PRODUCT_BUNDLE_IDENTIFIER)',
        CFBundleInfoDictionaryVersion='6.0',CFBundleName='$(PRODUCT_NAME)',CFBundlePackageType='XPC!' if extension else 'APPL',
        CFBundleShortVersionString='$(MARKETING_VERSION)',CFBundleVersion='$(CURRENT_PROJECT_VERSION)',
        LoginKeychainGroup='$(DEVELOPMENT_TEAM).'+config['bundleId'])
    if kind == 'Xvid': info.pop('LoginKeychainGroup')
    if extension:
        info['NSExtension'] = dict(NSExtensionPointIdentifier='com.apple.Safari.web-extension',NSExtensionPrincipalClass='$(PRODUCT_MODULE_NAME).Handler')
    else:
        info.update(LSRequiresIPhoneOS=True,UILaunchScreen={},UIRequiredDeviceCapabilities=['arm64'],
                    UISupportedInterfaceOrientations=['UIInterfaceOrientationPortrait'],
                    NSAppTransportSecurity={'NSAllowsLocalNetworking':True},
                    NSLocalNetworkUsageDescription='Connect to your PC download list when it is available.', UIViewControllerBasedStatusBarAppearance=True)
    (root / settings['INFOPLIST_FILE']).write_bytes(plistlib.dumps(info))
entitlements = plistlib.dumps({'keychain-access-groups':['$(AppIdentifierPrefix)'+config['bundleId']]})
entitlements_path = generated/'Login.entitlements'
if not entitlements_path.exists() or entitlements_path.read_bytes() != entitlements: entitlements_path.write_bytes(entitlements)
product_group=obj('Products','PBXGroup',children=products,name='Products',sourceTree='<group>')
group=obj('Main','PBXGroup',children=list(dict.fromkeys(files))+[product_group],sourceTree='<group>')
project=obj('Project','PBXProject',buildConfigurationList=config_list('Project',{}),compatibilityVersion='Xcode 14.0',
    developmentRegion='en',knownRegions=['en','Base'],mainGroup=group,productRefGroup=product_group,projectDirPath='',projectRoot='',targets=targets)
def encode(value):
    if isinstance(value,dict): return '{'+''.join(json.dumps(k)+' = '+encode(v)+';\n' for k,v in value.items())+'}'
    if isinstance(value,list): return '('+','.join(encode(v) for v in value)+')'
    return json.dumps(value)
document=dict(archiveVersion=1,classes={},objectVersion=56,objects=objects,rootObject=project)
(projectdir/'project.pbxproj').write_text('// !$*UTF8*$!\n'+encode(document)+'\n')
