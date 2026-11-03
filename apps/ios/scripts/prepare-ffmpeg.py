#!/usr/bin/env python3
"""Stage checksum-pinned original-file decoding libraries, keeping iOS/simulator slices."""
import fcntl,hashlib,json,os,pathlib,plistlib,shutil,tarfile,tempfile,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
CACHE=pathlib.Path.home()/'.cache/video-ios-dependencies'
LAYOUT='ios-runtime-only-v1'
DEPENDENCIES=[
 ('FFmpegBuild','https://codeload.github.com/superuser404notfound/FFmpegBuild/tar.gz/9c87af0231fd1403654c14a0e867fe8aa43c5bea','307b2ba5e20da7cb113872b415cf094afbbe0a46829c5e9aa15a0978354b7943','Sources'),
 ('LibDovi','https://codeload.github.com/superuser404notfound/LibDovi/tar.gz/2.1.0','4e09d1981fe1e4f38bd5f7a7d8909a60c859096eb9cd83cff4fb3be3fe3f7e88','.'),
]
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
def files(root):
 return {str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ['binary-receipt.json','binary-receipt.partial']}
def prepare(name,url,sha,relative):
 CACHE.mkdir(parents=True,exist_ok=True)
 with (CACHE/(name+'.lock')).open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  prepare_locked(name,url,sha,relative)

def prepare_locked(name,url,sha,relative):
 destination=ROOT/'ThirdParty'/name
 receipt=destination/'binary-receipt.json'
 partial_receipt=receipt.with_suffix('.partial')
 partial_receipt.unlink(missing_ok=True)
 if receipt.exists():
  try:saved=json.loads(receipt.read_text())
  except (ValueError,OSError):saved={}
  if not isinstance(saved,dict):saved={}
  if saved.get('layout')==LAYOUT and saved.get('archiveSHA256')==sha and saved.get('files')==files(destination):
   print('Verified '+name,flush=True);return
 archive=CACHE/(name+'-'+sha[:16]+'.tar.gz')
 if archive.exists() and digest(archive)!=sha:archive.unlink()
 if not archive.exists():
  partial=archive.with_suffix('.partial')
  urllib.request.urlretrieve(url,partial)
  if digest(partial)!=sha:
   partial.unlink(missing_ok=True)
   raise SystemExit(name+' checksum mismatch')
  with partial.open('rb') as stream:os.fsync(stream.fileno())
  os.replace(partial,archive)
 destination.mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
  stage=pathlib.Path(temporary)
  with tarfile.open(archive,'r:gz') as source:
   for member in source:
    path=pathlib.PurePosixPath(member.name)
    if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk():
     # XCFramework iOS slices use ordinary files. Never follow archive links.
     if member.issym() or member.islnk():continue
     raise SystemExit('Unsafe dependency member')
    if not (member.isdir() or member.isfile()):raise SystemExit('Unsupported dependency member')
    if hasattr(tarfile,'data_filter'):source.extract(member,stage,filter='data')
    else:source.extract(member,stage)
  checkout=next(stage.iterdir())
  frameworks=list((checkout/relative).glob('*.xcframework'))
  assert len(frameworks)==(9 if name=='FFmpegBuild' else 1), 'Missing pinned frameworks'
  for framework in frameworks:
   info=plistlib.loads((framework/'Info.plist').read_bytes())
   libraries=[x for x in info['AvailableLibraries'] if x['SupportedPlatform']=='ios' and x.get('SupportedPlatformVariant') in (None,'simulator')]
   assert any('arm64' in x['SupportedArchitectures'] and not x.get('SupportedPlatformVariant') for x in libraries)
   assert any('x86_64' in x['SupportedArchitectures'] and x.get('SupportedPlatformVariant')=='simulator' for x in libraries)
   output=destination/relative/framework.name
   if output.exists():shutil.rmtree(output)
   output.mkdir(parents=True)
   for library in libraries:
    source_slice=framework/library['LibraryIdentifier']
    target_slice=output/library['LibraryIdentifier']
    target_slice.mkdir()
    for field in ['LibraryPath','HeadersPath']:
     if not library.get(field):continue
     path=pathlib.PurePosixPath(library[field])
     assert not path.is_absolute() and '..' not in path.parts
     source_part=source_slice/path;target_part=target_slice/path
     if source_part.is_dir():shutil.copytree(source_part,target_part)
     else:shutil.copy2(source_part,target_part)
    library.pop('DebugSymbolsPath',None)
   info['AvailableLibraries']=libraries
   (output/'Info.plist').write_bytes(plistlib.dumps(info))
 with partial_receipt.open('w') as output:
  output.write(json.dumps({'url':url,'archiveSHA256':sha,'layout':LAYOUT,'files':files(destination)},indent=2)+'\n')
  output.flush();os.fsync(output.fileno())
 os.replace(partial_receipt,receipt)
 print('Staged '+name+' iOS libraries',flush=True)
if __name__=='__main__':
 for dependency in DEPENDENCIES:prepare(*dependency)
