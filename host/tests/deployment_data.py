import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

HOST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HOST / 'release'))
import data_init


class DataInitTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'host-data'
        self.options = {'trusted_root': self.root.parent}
        if os.name == 'posix':
            self.options.update(uid=os.getuid(), gid=os.getgid())

    def initialise(self):
        return data_init.initialise(self.root, **self.options)

    def test_new_volume_creates_only_the_five_approved_trees(self):
        result = self.initialise()
        self.assertTrue(result['rootCreated'])
        self.assertEqual(set(result['created']), set(data_init.DATA_TREES))
        self.assertEqual({path.name for path in self.root.iterdir()}, set(data_init.DATA_TREES))
        self.assertNotIn('connector-secrets', {path.name for path in self.root.iterdir()})
        if os.name == 'posix':
            for tree in data_init.DATA_TREES:
                self.assertEqual((self.root/tree).stat().st_mode & 0o777, 0o750)

    def test_existing_data_and_nested_metadata_are_not_rewritten(self):
        tree = self.root/'agents'/'agent-one'/'memory'
        tree.mkdir(parents=True)
        profile = tree/'profile.md'
        profile.write_text('remember me', encoding='utf-8')
        agents = self.root/'agents'
        if os.name == 'posix':
            agents.chmod(0o711)
            os.chown(agents, os.getuid(), os.getgid())
            os.utime(agents, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        top_before = agents.stat()
        before = profile.stat()
        result = self.initialise()
        after = profile.stat()
        top_after = agents.stat()
        self.assertEqual(set(result['created']), set(data_init.DATA_TREES) - {'agents'})
        self.assertEqual(profile.read_text(encoding='utf-8'), 'remember me')
        self.assertEqual((before.st_ino, before.st_mode, before.st_mtime_ns),
                         (after.st_ino, after.st_mode, after.st_mtime_ns))
        if os.name == 'posix':
            self.assertEqual((top_before.st_uid, top_before.st_gid, top_before.st_mode, top_before.st_mtime_ns),
                             (top_after.st_uid, top_after.st_gid, top_after.st_mode, top_after.st_mtime_ns))

    def test_existing_tree_is_idempotent(self):
        first = self.initialise()
        second = self.initialise()
        self.assertEqual(set(first['created']), set(data_init.DATA_TREES))
        self.assertEqual(second['created'], [])
        self.assertFalse(second['rootCreated'])

    def test_file_and_symlink_trees_are_rejected_without_following_them(self):
        self.root.mkdir()
        (self.root/'agents').write_text('not a directory', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'not a directory'):
            self.initialise()

        (self.root/'agents').unlink()
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside)
        (self.root/'agents').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.initialise()
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_parent_is_rejected(self):
        base = self.root.parent
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside)
        (base/'runtime').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            data_init.initialise(base/'runtime'/'host-data', trusted_root=base, **{k: v for k, v in self.options.items() if k != 'trusted_root'})
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
