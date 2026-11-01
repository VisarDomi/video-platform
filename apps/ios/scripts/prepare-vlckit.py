#!/usr/bin/env python3
"""Stage the official, checksum-pinned iOS VLCKit binary. Never build or transform media."""
import argparse, hashlib, json, os, pathlib, plistlib, shutil, tempfile, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
NAME = 'VLCKit-4.0-20260929-1631.zip'
URL = 'https://download.videolan.org/cocoapods/unstable/' + NAME
SHA = 'f37c8dbdd4427d1a3f5d75dc4b8bd1ae863cef4426f9a405a2fd1c5c9012f1fb'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive', type=pathlib.Path)
args = parser.parse_args()
destination = ROOT / 'ThirdParty/VLCKit/VLCKit.xcframework'
receipt = destination.parent / 'binary-receipt.json'
if receipt.exists() and destination.exists():
    state = json.loads(receipt.read_text())
    if state.get('archiveSHA256') == SHA and all(
        (destination / name).is_file() and hashlib.sha256((destination / name).read_bytes()).hexdigest() == digest
        for name, digest in state.get('binaries', {}).items()
    ) and state.get('binaries'):
        print('Verified official VLCKit iOS binary cache')
        raise SystemExit(0)
cache = pathlib.Path.home() / '.cache/video-ios-dependencies'
cache.mkdir(parents=True, exist_ok=True)
archive = args.archive or cache / NAME
if not archive.exists():
    partial = archive.with_suffix('.partial')
    urllib.request.urlretrieve(URL, partial)
    os.replace(partial, archive)
with archive.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else None
    if digest is None:
        h = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b''): h.update(chunk)
        digest = h.hexdigest()
assert digest == SHA, 'Official VLCKit archive checksum mismatch'
with zipfile.ZipFile(archive) as z, tempfile.TemporaryDirectory(dir=destination.parent) as stage:
    info_path = next(n for n in z.namelist() if n == 'VLCKit.xcframework/Info.plist')
    info = plistlib.loads(z.read(info_path))
    libraries = [x for x in info['AvailableLibraries'] if x['SupportedPlatform'] == 'ios' and not x.get('SupportedPlatformVariant') == 'maccatalyst']
    assert any('arm64' in x['SupportedArchitectures'] and not x.get('SupportedPlatformVariant') for x in libraries)
    assert any('x86_64' in x['SupportedArchitectures'] and x.get('SupportedPlatformVariant') == 'simulator' for x in libraries)
    prefixes = ['VLCKit.xcframework/' + x['LibraryIdentifier'] + '/' for x in libraries]
    for name in z.namelist():
        if name.startswith(tuple(prefixes)) and not name.endswith('/'):
            relative = pathlib.PurePosixPath(name)
            assert '..' not in relative.parts and not relative.is_absolute()
            z.extract(name, stage)
            mode = (z.getinfo(name).external_attr >> 16) & 0o777
            if mode: os.chmod(pathlib.Path(stage)/name, mode)
    staged = pathlib.Path(stage) / 'VLCKit.xcframework'
    info['AvailableLibraries'] = libraries
    (staged / 'Info.plist').write_bytes(plistlib.dumps(info))
    if destination.exists(): shutil.rmtree(destination)
    shutil.move(staged, destination)
binaries = {}
for library in libraries:
    binary = pathlib.Path(library['LibraryIdentifier']) / library['LibraryPath'] / 'VLCKit'
    binaries[str(binary)] = hashlib.sha256((destination / binary).read_bytes()).hexdigest()
receipt.write_text(json.dumps({'url': URL, 'archiveSHA256': SHA, 'binaries': binaries}, indent=2) + '\n')
print('Staged verified official VLCKit device and simulator slices')
