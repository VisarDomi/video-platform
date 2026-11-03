"""Regress the mixed ABI actually observed when first linking the native adapter."""
import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).resolve().parents[1] / 'scripts/verify-ffmpeg.py'
spec = importlib.util.spec_from_file_location('verify_ffmpeg', path)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class FFmpegBindings(unittest.TestCase):
    fixed = '''
                 (undefined) external _avcodec_version (from AetherLibavcodec)
                 (undefined) external _avcodec_send_packet (from AetherLibavcodec)
                 (undefined) external _avformat_open_input (from AetherLibavformat)
                 (undefined) external _av_frame_alloc (from AetherLibavutil)
                 (undefined) external _sws_scale (from AetherLibswscale)
                 (undefined) external _swr_convert (from AetherLibswresample)
'''

    def test_version_match_does_not_excuse_mixed_struct_abi(self):
        # The actual first linked binary had the right version function, while
        # calls consuming FFmpeg8 structs resolved to VLC's older implementation.
        mixed = self.fixed.replace('_avcodec_send_packet (from AetherLibavcodec)',
                                   '_avcodec_send_packet (from VLCKit)')
        with self.assertRaisesRegex(AssertionError, 'Mixed FFmpeg ABI'):
            verify.verify_bindings(mixed)
        verify.verify_bindings(self.fixed)

    def test_subtitle_and_utility_symbols_are_protected_too(self):
        for symbol in ['avsubtitle_free', 'av_dict_set', 'av_buffersrc_add_frame_flags']:
            with self.subTest(symbol=symbol), self.assertRaisesRegex(AssertionError, 'Mixed FFmpeg ABI'):
                verify.verify_bindings(self.fixed + f'\n (undefined) external _{symbol} (from VLCKit)')
