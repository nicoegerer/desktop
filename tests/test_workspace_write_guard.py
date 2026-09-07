import asyncio
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.parse
import urllib.request
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
REAL_HTTP = '--real-http' in sys.argv
if REAL_HTTP:
    sys.argv.remove('--real-http')
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


class HttpErrorCompatibilityTests(unittest.TestCase):
    def test_missing_subprocess_is_bound_lazily_before_original_server_call(self):
        api = SimpleNamespace()
        original = Mock(return_value='started')
        server = SimpleNamespace(run=original)
        with patch.object(guard.importlib, 'import_module', side_effect=[api, subprocess]) as importer:
            guard.install_http_error_compatibility(server)
            importer.assert_not_called()
            self.assertEqual(server.run('open_terminal.main:app', host='127.0.0.1', port=1234), 'started')
        self.assertIs(api.subprocess, subprocess)
        self.assertEqual([call.args[0] for call in importer.call_args_list], ['open_terminal.main', 'subprocess'])
        original.assert_called_once_with('open_terminal.main:app', host='127.0.0.1', port=1234)

    def test_existing_or_future_upstream_binding_is_not_replaced(self):
        existing = object()
        api = SimpleNamespace(subprocess=existing)
        server = SimpleNamespace(run=Mock())
        with patch.object(guard.importlib, 'import_module', return_value=api) as importer:
            guard.install_http_error_compatibility(server)
            server.run('open_terminal.main:app')
        self.assertIs(api.subprocess, existing)
        importer.assert_called_once_with('open_terminal.main')

    def test_other_server_targets_are_unchanged_and_import_nothing(self):
        original = Mock(return_value='other')
        server = SimpleNamespace(run=original)
        with patch.object(guard.importlib, 'import_module') as importer:
            guard.install_http_error_compatibility(server)
            self.assertEqual(server.run('other:app', log_level='warning'), 'other')
        importer.assert_not_called()
        original.assert_called_once_with('other:app', log_level='warning')

    def test_original_import_and_server_failures_are_not_masked(self):
        for failure_from_import in (False, True):
            error = RuntimeError('original startup error')
            original = Mock(side_effect=error)
            server = SimpleNamespace(run=original)
            with patch.object(guard.importlib, 'import_module',
                              side_effect=error if failure_from_import else None,
                              return_value=SimpleNamespace(subprocess=subprocess)):
                guard.install_http_error_compatibility(server)
                with self.assertRaises(RuntimeError) as caught:
                    server.run('open_terminal.main:app')
            self.assertIs(caught.exception, error)
            if failure_from_import:
                original.assert_not_called()


@unittest.skipUnless(REAL_HTTP, 'Use --real-http with the installed Open Terminal runtime')
class RealHttpWorkspaceTests(unittest.TestCase):
    """Exercise the official CLI/HTTP handlers, not just direct UserFS calls."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='desktop-workspace-http-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.base = Path(cls.temp.name).resolve()
        cls.current = cls.base / 'whitemode'
        cls.previous = cls.base / 'test'
        cls.current.mkdir()
        cls.previous.mkdir()
        cls.key = secrets.token_hex(32)
        cls.session_id = 'isolated-workspace-http-regression'
        config = cls.base / 'config.toml'
        config.write_text('enable_terminal = false\nenable_notebooks = false\nmulti_user = false\n')
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('OPEN_TERMINAL_', 'OPEN_WEBUI_DESKTOP_'))}
        env.update(OPEN_TERMINAL_API_KEY=cls.key,
                   OPEN_TERMINAL_LOG_DIR=str(cls.base / 'logs'),
                   OPEN_WEBUI_DESKTOP_WORKSPACE_ROOT=str(cls.current),
                   PYTHONDONTWRITEBYTECODE='1')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        cls.url = f'http://127.0.0.1:{port}'
        cls.server_log = cls.base / 'server.log'
        log = cls.server_log.open('wb')
        cls.addClassCleanup(log.close)
        cls.process = subprocess.Popen([
            sys.executable, '-B', str(ROOT / 'resources/open-terminal-workspace.py'),
            'run', '--host', '127.0.0.1', '--port', str(port), '--cwd', str(cls.current),
            '--config', str(config), '--cors-allowed-origins', 'http://127.0.0.1',
        ], cwd=cls.current, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        cls.addClassCleanup(cls.stop_server)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if cls.process.poll() is not None:
                raise RuntimeError('Isolated HTTP server exited: ' + cls.redacted_log())
            try:
                if cls.request('/openapi.json')[0] == 200:
                    break
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError('Isolated HTTP server startup timeout: ' + cls.redacted_log())
        status, _, payload = cls.request('/files/cwd', {'path': str(cls.current)})
        if status != 200 or Path(payload['cwd']).resolve() != cls.current:
            raise RuntimeError('Could not select the isolated current workspace')

    @classmethod
    def stop_server(cls):
        if cls.process.poll() is None:
            cls.process.terminate()
            try:
                cls.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                cls.process.kill()
                cls.process.wait(timeout=10)

    @classmethod
    def redacted_log(cls):
        return cls.server_log.read_text(errors='replace')[-4000:].replace(cls.key, '[test-key]')

    @classmethod
    def request(cls, endpoint, payload=None, method=None, authenticated=True):
        headers = {'Content-Type': 'application/json', 'X-Session-Id': cls.session_id}
        if authenticated:
            headers['Authorization'] = 'Bearer ' + cls.key
        request = urllib.request.Request(
            cls.url + endpoint, data=None if payload is None else json.dumps(payload).encode(),
            headers=headers, method=method or ('GET' if payload is None else 'POST'))
        # Do not route this generated credential through any configured proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            response = opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read().decode()
            try:
                result = json.loads(raw)
            except ValueError:
                result = raw
            return response.status, response.headers.get('Content-Type', ''), result

    def test_selected_relative_write_read_display_and_preview(self):
        content = '<!doctype html><title>Workspace</title><h1>Light</h1>'
        target = self.current / 'light.html'
        self.assertEqual(self.request('/files/write', {'path': 'light.html', 'content': content})[0], 200)
        self.assertEqual(target.read_text(), content)
        readback = self.request('/files/read?path=light.html')
        self.assertEqual(readback[0], 200)
        self.assertEqual(readback[2]['content'], content)
        absolute = urllib.parse.quote(str(target), safe='')
        display = self.request('/files/display?path=' + absolute)
        self.assertEqual(display[0], 200)
        self.assertTrue(display[2]['exists'])
        self.assertEqual(Path(display[2]['path']).resolve(), target)
        preview = self.request('/files/view?path=' + absolute)
        self.assertEqual(preview[0], 200)
        self.assertTrue(preview[1].startswith('text/html'))
        self.assertEqual(preview[2], content)

    def test_stale_absolute_write_preserves_409_and_recovery_detail(self):
        target = self.previous / 'must-not-exist.html'
        status, _, data = self.request('/files/write', {'path': str(target), 'content': 'wrong'})
        self.assertEqual(status, 409, self.redacted_log())
        self.assertIn('Workspace mismatch', data['detail'])
        self.assertIn('Retry the file operation', data['detail'])
        self.assertIn(str(self.current).lower(), data['detail'].lower())
        self.assertFalse(target.exists())

    def test_delete_and_move_keep_the_original_file_when_outside_root(self):
        source = self.previous / 'keep.txt'
        source.write_text('keep')
        deleted = self.request('/files/delete?path=' + urllib.parse.quote(str(source), safe=''), method='DELETE')
        self.assertEqual(deleted[0], 409, self.redacted_log())
        self.assertIn('Workspace mismatch', deleted[2]['detail'])
        destination = self.current / 'moved.txt'
        moved = self.request('/files/move', {'source': str(source), 'destination': str(destination)})
        self.assertEqual(moved[0], 409, self.redacted_log())
        self.assertEqual(source.read_text(), 'keep')
        self.assertFalse(destination.exists())

    def test_upstream_missing_file_auth_and_os_errors_are_preserved(self):
        self.assertEqual(self.request('/files/read?path=missing.txt')[0], 404)
        self.assertEqual(self.request('/files/read?path=missing.txt', authenticated=False)[0], 401)
        status, _, data = self.request('/files/write', {'path': str(self.current), 'content': 'not a file'})
        self.assertEqual(status, 400, self.redacted_log())
        self.assertNotIn('Workspace mismatch', data['detail'])


if __name__ == '__main__':
    unittest.main()
