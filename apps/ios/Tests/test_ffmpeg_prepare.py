"""Interrupted dependency staging must repair itself on the next push."""
import concurrent.futures
import contextlib
import hashlib
import importlib.util
import io
import pathlib
import plistlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).resolve().parents[1] / 'scripts/prepare-ffmpeg.py'
spec = importlib.util.spec_from_file_location('prepare_ffmpeg', source)
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class Recovery(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(prepare, 'ROOT', self.root / 'app'))
        self.stack.enter_context(patch.object(prepare, 'CACHE', self.root / 'cache'))
        self.destination = prepare.ROOT / 'ThirdParty/LibDovi'
        self.archive = self.root / 'source.tar.gz'
        entries = []
        for identifier, arches, variant in [('ios-arm64', ['arm64'], None),
                                            ('ios-arm64_x86_64-simulator', ['arm64', 'x86_64'], 'simulator')]:
            row = dict(LibraryIdentifier=identifier, LibraryPath='libdovi.a', HeadersPath='Headers', SupportedPlatform='ios', SupportedArchitectures=arches)
            if variant:
                row['SupportedPlatformVariant'] = variant
            entries.append(row)
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name, data in [('Info.plist', plistlib.dumps(dict(AvailableLibraries=entries))),
                               ('ios-arm64/libdovi.a', b'original-device-bytes'),
                               ('ios-arm64_x86_64-simulator/libdovi.a', b'original-simulator-bytes'),
                               ('ios-arm64/Headers/dovi.h', b'device-header'),
                               ('ios-arm64_x86_64-simulator/Headers/dovi.h', b'simulator-header')]:
                member = tarfile.TarInfo('LibDovi-pinned/Dovi.xcframework/' + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        self.sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.arguments = ('LibDovi', self.archive.as_uri(), self.sha, '.')

    def test_truncated_receipt_and_archive_then_partial_framework_recover(self):
        self.destination.mkdir(parents=True)
        receipt = self.destination / 'binary-receipt.json'
        receipt.write_text('{"files":')
        prepare.CACHE.mkdir()
        cached = prepare.CACHE / ('LibDovi-' + self.sha[:16] + '.tar.gz')
        cached.write_bytes(b'power cut during archive flush')
        prepare.prepare(*self.arguments)
        self.assertEqual(prepare.digest(cached), self.sha)
        binary = self.destination / 'Dovi.xcframework/ios-arm64/libdovi.a'
        self.assertEqual(binary.read_bytes(), b'original-device-bytes')
        self.assertEqual((binary.parent / 'Headers/dovi.h').read_bytes(), b'device-header')
        binary.write_bytes(b'power cut during extraction')
        receipt.write_text('[]')
        receipt.with_suffix('.partial').write_text('unfinished receipt')
        with patch.object(prepare.urllib.request, 'urlretrieve', side_effect=AssertionError('Verified archive should be reused')):
            prepare.prepare(*self.arguments)
            prepare.prepare(*self.arguments)
        self.assertEqual(binary.read_bytes(), b'original-device-bytes')
        self.assertFalse(receipt.with_suffix('.partial').exists())

    def test_concurrent_push_preparation_downloads_and_stages_once(self):
        retrieve = prepare.urllib.request.urlretrieve
        with patch.object(prepare.urllib.request, 'urlretrieve', wraps=retrieve) as download:
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                list(pool.map(lambda _: prepare.prepare(*self.arguments), range(2)))
        self.assertEqual(download.call_count, 1)
        self.assertEqual((self.destination / 'Dovi.xcframework/ios-arm64/libdovi.a').read_bytes(), b'original-device-bytes')
