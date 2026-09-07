import asyncio
import importlib.util
from pathlib import Path
import tempfile
import unittest
import sys

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('workspace_guard', ROOT / 'resources/open-terminal-workspace.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class Rejected(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        super().__init__(detail)


class FakeFS:
    async def write(self, path, content, encoding='utf-8'):
        Path(path).write_text(content, encoding=encoding)

    async def write_bytes(self, path, data):
        Path(path).write_bytes(data)

    async def mkdir(self, path):
        Path(path).mkdir()

    async def remove(self, path):
        Path(path).unlink()

    async def move(self, source, destination):
        Path(source).rename(destination)

    async def read(self, path):
        return Path(path).read_text()


BaseFS = FakeFS
if '--real' in sys.argv:
    sys.argv.remove('--real')
    from open_terminal.utils.fs import UserFS
    from fastapi import HTTPException
    BaseFS = UserFS
    Rejected = HTTPException


class WorkspaceGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='desktop-workspace-guard-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.old = self.base / 'test'
        self.current = self.base / 'whitemode'
        self.old.mkdir()
        self.current.mkdir()

        class IsolatedFS(BaseFS):
            pass
        guard.install_workspace_write_guard(self.current, IsolatedFS, Rejected)
        self.fs = IsolatedFS()

    def test_current_workspace_write_is_verified_on_disk(self):
        target = self.current / 'light.html'
        asyncio.run(self.fs.write(target, '<h1>Light</h1>'))
        self.assertEqual(target.read_text(), '<h1>Light</h1>')

    def test_old_absolute_path_is_rejected_without_creating_a_file(self):
        old_output = self.old / 'light.html'
        with self.assertRaisesRegex(Rejected, 'Workspace mismatch') as error:
            asyncio.run(self.fs.write(old_output, 'wrong'))
        self.assertEqual(error.exception.status_code, 409)
        self.assertIn(str(self.current.resolve()).lower(), str(error.exception).lower())
        self.assertFalse(old_output.exists())

    def test_parent_traversal_and_sibling_prefix_are_rejected(self):
        sibling = self.base / 'whitemode-other'
        sibling.mkdir()
        for target in (self.current / '..' / 'test' / 'bad', sibling / 'bad'):
            with self.assertRaises(Rejected):
                asyncio.run(self.fs.write(path=target, content='wrong'))
            self.assertFalse(target.exists())

    def test_reading_previous_source_files_is_not_restricted(self):
        source = self.old / 'dark.html'
        source.write_text('existing source')
        content = asyncio.run(self.fs.read(source))
        self.assertEqual(content.decode() if isinstance(content, bytes) else content, 'existing source')

    def test_old_file_cannot_be_overwritten_or_deleted(self):
        source = self.old / 'keep.txt'
        source.write_text('keep')
        for operation in (lambda: self.fs.write_bytes(source, b'bad'), lambda: self.fs.remove(source)):
            with self.assertRaises(Rejected):
                asyncio.run(operation())
            self.assertEqual(source.read_text(), 'keep')

    def test_moving_a_file_validates_both_ends(self):
        source = self.current / 'keep.txt'
        source.write_text('keep')
        with self.assertRaises(Rejected):
            asyncio.run(self.fs.move(source, self.old / 'wrong.txt'))
        old_source = self.old / 'old.txt'
        old_source.write_text('old')
        with self.assertRaises(Rejected):
            asyncio.run(self.fs.move(old_source, self.current / 'new.txt'))
        self.assertTrue(source.exists())
        self.assertTrue(old_source.exists())

    def test_symlink_escape_is_rejected_when_supported(self):
        link = self.current / 'escape'
        try:
            link.symlink_to(self.old, target_is_directory=True)
        except OSError:
            self.skipTest('Creating symlinks is not permitted on this host')
        with self.assertRaises(Rejected):
            asyncio.run(self.fs.write(link / 'bad.txt', 'wrong'))
        self.assertFalse((self.old / 'bad.txt').exists())

    def test_a_changed_upstream_contract_fails_closed(self):
        class ChangedFS(FakeFS):
            async def move(self, renamed_source, renamed_destination):
                pass
        with self.assertRaisesRegex(RuntimeError, 'contract changed'):
            guard.install_workspace_write_guard(self.current, ChangedFS, Rejected)


if __name__ == '__main__':
    unittest.main()
