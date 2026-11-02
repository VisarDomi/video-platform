#!/usr/bin/env python3
"""Stage checksum-pinned VLCKit runtime slices; retain symbols in the original cache archive."""
import argparse,fcntl,hashlib,json,os,pathlib,plistlib,shutil,tempfile,urllib.request,zipfile

ROOT=pathlib.Path(__file__).resolve().parents[1]
NAME='VLCKit-4.0-20260929-1631.zip'
URL='https://download.videolan.org/cocoapods/unstable/'+NAME
SHA='f37c8dbdd4427d1a3f5d75dc4b8bd1ae863cef4426f9a405a2fd1c5c9012f1fb'
LAYOUT='ios-runtime-only-v1'

def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
 return h.hexdigest()

def prepare(archive_override=None):
 cache=pathlib.Path.home()/'.cache/video-ios-dependencies'
 cache.mkdir(parents=True,exist_ok=True)
 with (cache/'VLCKit.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  stage_runtime(cache,archive_override)

def stage_runtime(cache,archive_override):
 destination=ROOT/'ThirdParty/VLCKit/VLCKit.xcframework'
 receipt=destination.parent/'binary-receipt.json'
 receipt.with_suffix('.partial').unlink(missing_ok=True)
 try:
  state=json.loads(receipt.read_text())
  libraries=plistlib.loads((destination/'Info.plist').read_bytes())['AvailableLibraries']
  valid=(state.get('layout')==LAYOUT and state.get('archiveSHA256')==SHA and state.get('binaries') and libraries
         and not any('DebugSymbolsPath' in item for item in libraries)
         and not any(destination.glob('*/dSYMs'))
         and all((destination/name).is_file() and digest(destination/name)==value for name,value in state['binaries'].items()))
 except (OSError,ValueError,AttributeError,KeyError):valid=False
 if valid:
  print('Verified official VLCKit iOS runtime cache');return
 archive=archive_override or cache/NAME
 if archive.exists() and digest(archive)!=SHA:
  if archive_override:raise SystemExit('Official VLCKit archive checksum mismatch')
  archive.unlink()
 if not archive.exists():
  partial=archive.with_suffix('.partial')
  urllib.request.urlretrieve(URL,partial)
  if digest(partial)!=SHA:
   partial.unlink(missing_ok=True);raise SystemExit('Official VLCKit archive checksum mismatch')
  with partial.open('rb') as stream:os.fsync(stream.fileno())
  os.replace(partial,archive)
 destination.parent.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(archive) as source,tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
  info=plistlib.loads(source.read('VLCKit.xcframework/Info.plist'))
  libraries=[item for item in info['AvailableLibraries'] if item['SupportedPlatform']=='ios' and item.get('SupportedPlatformVariant')!='maccatalyst']
  assert any('arm64' in item['SupportedArchitectures'] and not item.get('SupportedPlatformVariant') for item in libraries)
  assert any('x86_64' in item['SupportedArchitectures'] and item.get('SupportedPlatformVariant')=='simulator' for item in libraries)
  # Debug symbols are not app/runtime inputs. Keep their exact archive for
  # on-demand symbolication instead of copying ~600 MiB into every checkpoint.
  prefixes=['VLCKit.xcframework/'+item['LibraryIdentifier']+'/'+item['LibraryPath']+'/' for item in libraries]
  for name in source.namelist():
   if name.startswith(tuple(prefixes)) and not name.endswith('/'):
    relative=pathlib.PurePosixPath(name)
    assert '..' not in relative.parts and not relative.is_absolute()
    source.extract(name,temporary)
    mode=(source.getinfo(name).external_attr>>16)&0o777
    if mode:os.chmod(pathlib.Path(temporary)/name,mode)
  for item in libraries:item.pop('DebugSymbolsPath',None)
  info['AvailableLibraries']=libraries
  staged=pathlib.Path(temporary)/'VLCKit.xcframework'
  (staged/'Info.plist').write_bytes(plistlib.dumps(info))
  if destination.is_symlink():destination.unlink()
  elif destination.exists():shutil.rmtree(destination)
  shutil.move(staged,destination)
 binaries={}
 for item in libraries:
  binary=pathlib.Path(item['LibraryIdentifier'])/item['LibraryPath']/'VLCKit'
  binaries[str(binary)]=digest(destination/binary)
 partial_receipt=receipt.with_suffix('.partial')
 with partial_receipt.open('w') as output:
  output.write(json.dumps({'url':URL,'archiveSHA256':SHA,'layout':LAYOUT,'binaries':binaries},indent=2)+'\n')
  output.flush();os.fsync(output.fileno())
 os.replace(partial_receipt,receipt)
 print('Staged verified official VLCKit iOS runtime slices; symbols retained in '+str(archive))

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--archive',type=pathlib.Path)
 prepare(parser.parse_args().archive)
