"""Synthetic negative controls for archive integrity; no renderer expectations change."""
import copy
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('archive', Path(__file__).with_name('rendering-evidence-archive.py'))
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchiveIntegrity(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'evidence.tar'
        self.manifest = {'source': archive.SOURCE, 'base': archive.BASE, 'files': [
            {'path': 'evidence/a.txt', 'mode': '100644', 'bytes': 3, 'sha256': archive.sha256(b'one')},
            {'path': 'evidence/b.txt', 'mode': '100644', 'bytes': 3, 'sha256': archive.sha256(b'two')},
        ]}
        self.original = [('evidence/a.txt', b'one', tarfile.REGTYPE), ('evidence/b.txt', b'two', tarfile.REGTYPE)]

    def write(self, records):
        with tarfile.open(self.path, 'w', format=tarfile.GNU_FORMAT) as output:
            for name, data, kind in records:
                entry = tarfile.TarInfo(name)
                entry.type, entry.mode, entry.size = kind, 0o644, len(data)
                if kind == tarfile.SYMTYPE:
                    entry.linkname, entry.size = '../outside', 0
                output.addfile(entry, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
        data = self.path.read_bytes()
        # Rebind only the outer transport hash so inner membership/digest checks must catch tampering.
        self.manifest.update(archiveBytes=len(data), archiveSha256=archive.sha256(data))

    def partition_context(self):
        all_items = copy.deepcopy(self.manifest['files'])
        for index, item in enumerate(all_items):
            item['gitBlob'] = str(index + 1) * 40
        archived = {**self.manifest, 'files': all_items[:1]}
        retained = {**self.manifest, 'files': all_items[1:]}
        root = Path(self.temporary.name)
        kept = root / all_items[1]['path']
        kept.parent.mkdir(parents=True)
        kept.write_bytes(b'two')
        def source(*args):
            if args[0] == 'diff':
                return b'evidence/a.txt\nevidence/b.txt\n'
            if args[0] == 'ls-tree':
                return b''.join(('100644 blob ' + item['gitBlob'] + '\t' + item['path'] + '\0').encode() for item in all_items)
            if args[0] == 'cat-file':
                return b'one' if args[2] == all_items[0]['gitBlob'] else b'two'
            raise AssertionError(args)
        return root, kept, source, archived, retained

    def test_partition_missing_and_same_count_replacement(self):
        root, kept, source, archived, retained = self.partition_context()
        with patch.object(archive, 'ROOT', root), patch.object(archive, 'git', side_effect=source):
            self.assertEqual(set(archive.check_partition(archived, retained)), {'evidence/a.txt'})
            original_source = source
            def missing_source(*args):
                return b'evidence/a.txt\nevidence/b.txt\nevidence/missing.txt\n' if args[0] == 'diff' else original_source(*args)
            with patch.object(archive, 'git', side_effect=missing_source):
                with self.assertRaisesRegex(ValueError, 'Incomplete source partition'):
                    archive.check_partition(archived, retained)
            for changed in [[{**retained['files'][0], 'path': 'evidence/c.txt'}]]:
                with self.subTest(paths=[item['path'] for item in changed]):
                    with self.assertRaisesRegex(ValueError, 'Incomplete source partition'):
                        archive.check_partition(archived, {**retained, 'files': changed})

    def test_changed_retained_file(self):
        root, kept, source, archived, retained = self.partition_context()
        kept.write_bytes(b'Two')
        with patch.object(archive, 'ROOT', root), patch.object(archive, 'git', side_effect=source):
            with self.assertRaisesRegex(ValueError, 'Member digest'):
                archive.check_partition(archived, retained)

    def test_valid_exact_members(self):
        self.write(self.original)
        self.assertEqual(archive.verify_archive(self.path, self.manifest)['verifiedFiles'], 2)

    def test_missing(self):
        self.write(self.original[:1])
        with self.assertRaisesRegex(ValueError, 'Missing archive member'):
            archive.verify_archive(self.path, self.manifest)

    def test_extra(self):
        self.write(self.original + [('evidence/extra.txt', b'new', tarfile.REGTYPE)])
        with self.assertRaisesRegex(ValueError, 'Unexpected archive member'):
            archive.verify_archive(self.path, self.manifest)

    def test_duplicate(self):
        self.write(self.original + self.original[:1])
        with self.assertRaisesRegex(ValueError, 'Duplicate archive path'):
            archive.verify_archive(self.path, self.manifest)

    def test_changed_byte(self):
        self.write([('evidence/a.txt', b'One', tarfile.REGTYPE), self.original[1]])
        with self.assertRaisesRegex(ValueError, 'Member digest'):
            archive.verify_archive(self.path, self.manifest)

    def test_size(self):
        self.write([('evidence/a.txt', b'one!', tarfile.REGTYPE), self.original[1]])
        with self.assertRaisesRegex(ValueError, 'Member size'):
            archive.verify_archive(self.path, self.manifest)

    def test_symlink(self):
        self.write([('evidence/a.txt', b'', tarfile.SYMTYPE), self.original[1]])
        with self.assertRaisesRegex(ValueError, 'Non-regular archive member'):
            archive.verify_archive(self.path, self.manifest)

    def test_path_traversal(self):
        self.write([('../outside', b'one', tarfile.REGTYPE), self.original[1]])
        with self.assertRaisesRegex(ValueError, 'Unexpected archive member'):
            archive.verify_archive(self.path, self.manifest)
        self.manifest['files'][0]['path'] = '../outside'
        with self.assertRaisesRegex(ValueError, 'Unsafe path'):
            archive.verify_archive(self.path, self.manifest)

    def test_same_count_different_members(self):
        self.write(self.original)
        self.manifest['files'][1]['path'] = 'evidence/c.txt'
        with self.assertRaisesRegex(ValueError, 'Unexpected archive member'):
            archive.verify_archive(self.path, self.manifest)

    def test_outer_digest_and_duplicate_manifest(self):
        self.write(self.original)
        self.manifest['archiveSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'Archive digest'):
            archive.verify_archive(self.path, self.manifest)
        self.manifest['files'][1] = copy.deepcopy(self.manifest['files'][0])
        with self.assertRaisesRegex(ValueError, 'Duplicate manifest path'):
            archive.verify_archive(self.path, self.manifest)


if __name__ == '__main__':
    unittest.main(verbosity=2)
