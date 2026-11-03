#!/usr/bin/env python3
"""Reject mixed FFmpeg ABIs and missing original-decoder frameworks before delivery."""
import pathlib,re,subprocess,sys
PREFIX=re.compile(r' external _(av[a-z]*|sws|swr|dav1d)_')
def verify_bindings(bindings):
 bad=[line for line in bindings.splitlines() if PREFIX.search(line) and '(from VLCKit)' in line]
 assert not bad,'Mixed FFmpeg ABI: '+str(bad)
 required=['_avcodec_send_packet','_avformat_open_input','_av_frame_alloc','_sws_scale','_swr_convert']
 for symbol in required:
  lines=[line for line in bindings.splitlines() if ('external '+symbol+' ') in line]
  assert len(lines)==1 and '(from AetherLib' in lines[0], 'Unexpected binding: '+symbol+str(lines)

def verify(app):
 import plistlib
 product=plistlib.loads((app/'Info.plist').read_bytes())['CFBundleExecutable']
 binary=app/product
 bindings=subprocess.check_output(['/usr/bin/nm','-m',str(binary)],text=True)
 verify_bindings(bindings)
 for name in ['avcodec','avformat','avutil','swresample','swscale','avfilter','dav1d','zimg','zvbi']:
  framework='AetherLib'+name
  assert (app/'Frameworks'/f'{framework}.framework'/framework).is_file(),'Missing '+framework
 print('Verified original-decoder frameworks and FFmpeg ABI bindings')
if __name__=='__main__':verify(pathlib.Path(sys.argv[1]))
