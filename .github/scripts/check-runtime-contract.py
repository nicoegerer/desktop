"""Test the actual published Open WebUI wheel without installing its dependencies.

Executes its ordered OpenAPI resolver with synthetic servers, no credentials or
user data. This is a compatibility gate, not a substitute for the live model test.
"""
import ast
import asyncio
import hashlib
import io
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.request import urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[2]
VERSIONS = json.loads((ROOT / 'src/shared/runtime-versions.json').read_text())
subprocess.run([sys.executable, '-B', str(ROOT / 'tests/test_workspace_write_guard.py')], check=True)


def published_wheel(package, version):
    with urlopen(f'https://pypi.org/pypi/{package}/{version}/json', timeout=60) as response:
        release = json.load(response)
    wheel = next(item for item in release['urls'] if item['filename'].endswith('.whl'))
    assert wheel['url'].startswith('https://files.pythonhosted.org/'), 'Unexpected package host'
    with urlopen(wheel['url'], timeout=120) as response:
        data = response.read()
    assert hashlib.sha256(data).hexdigest() == wheel['digests']['sha256']
    return zipfile.ZipFile(io.BytesIO(data))


async def check_resolver(source):
    tree = ast.parse(source)
    function = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'get_tools')
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), function], type_ignores=[])
    ast.fix_missing_locations(module)
    file_names = ['write_file', 'read_file', 'list_files', 'run_command']
    servers = [
        {'id': 'workspace', 'idx': 0, 'url': 'http://fixture.invalid', 'specs': [{'name': name} for name in file_names]},
        {'id': 'garmin', 'idx': 1, 'url': 'http://fixture.invalid', 'specs': [{'name': f'garmin_{i}'} for i in range(135)]},
    ]
    connections = [{'config': {'function_name_filter_list': ''}} for _ in servers]

    async def empty_groups(*args): return []
    async def empty_tools(*args): return {}
    async def get_servers(*args): return servers
    async def config_get(*args): return connections
    async def permitted(*args, **kwargs): return True
    async def headers(*args, **kwargs): return {}, {}
    async def wrap(function, *args, **kwargs): return function

    env = {
        'ENABLE_PLUGINS': True,
        'Groups': SimpleNamespace(get_groups_by_member_id=empty_groups),
        'Tools': SimpleNamespace(get_tools_by_ids=empty_tools),
        'Config': SimpleNamespace(get=config_get),
        'get_tool_servers': get_servers,
        'has_connection_access': permitted,
        'build_tool_server_headers': headers,
        'get_async_tool_function_and_apply_extra_params': wrap,
        'clean_openai_tool_schema': lambda spec: spec,
        'is_string_allowed': lambda *args: True,
    }
    exec(compile(module, 'published-open-webui-get_tools', 'exec'), env)
    user = SimpleNamespace(id='fixture', role='admin')
    resolved = await env['get_tools'](None, ['server:workspace', 'server:garmin'], user, {})
    assert len(resolved) == 139
    surviving = [entry['spec']['name'] for entry in resolved.values()][:128]
    assert set(file_names).issubset(surviving), 'Filesystem tools lost before provider limit'
    print('Published resolver: filesystem tools survive 135 connector functions + 128-tool router limit')


webui = published_wheel('open-webui', VERSIONS['openWebUI'])
asyncio.run(check_resolver(webui.read('open_webui/utils/tools.py').decode()))
# The desktop imports the shipped stores and remounts FileNav by clearing the
# selected terminal for one Svelte flush. Fail the upstream-sync/release gates
# when that contract changes; do not silently ship a stale file panel.
frontend_sources = {}
wanted = ('src/lib/stores/index.ts', 'src/lib/components/chat/ChatControls.svelte',
          'src/lib/components/chat/FileNav.svelte', 'src/lib/apis/terminal/index.ts')
for name in webui.namelist():
    if not name.endswith('.js.map') or '/_app/immutable/' not in name:
        continue
    source_map = json.loads(webui.read(name))
    for source, content in zip(source_map.get('sources', []), source_map.get('sourcesContent', [])):
        for target in wanted:
            if source.endswith(target):
                frontend_sources[target] = content
    if len(frontend_sources) == len(wanted):
        break
assert len(frontend_sources) == len(wanted), 'Required shipped frontend source maps are missing'
stores = frontend_sources[wanted[0]]
for name in ('terminalServers', 'selectedTerminalId', 'showControls', 'showFileNavPath', 'showFileNavDir', 'tools'):
    assert f'export const {name}' in stores, f'Frontend store contract changed: {name}'
controls = frontend_sources[wanted[1]]
assert "activeTab === 'files' && terminalFilesAvailable && $selectedTerminalId" in controls
file_nav = frontend_sources[wanted[2]]
assert 'showFileNavPath.subscribe' in file_nav and 'getCwd(' in file_nav
cwd_api = frontend_sources[wanted[3]]
assert '/files/cwd' in cwd_api and "headers['X-Session-Id'] = sessionId" in cwd_api
print('Published frontend: terminal remount, file-navigation stores and per-chat cwd contract verified')
middleware = webui.read('open_webui/utils/middleware.py').decode()
assert "form_data.pop('terminal_id'" in middleware or 'form_data.pop("terminal_id"' in middleware
assert 'get_terminal_tools(' in middleware and 'get_tools(' in middleware
terminal = published_wheel('open-terminal', VERSIONS['openTerminal'])
terminal_source = terminal.read('open_terminal/main.py').decode()
terminal_tree = ast.parse(terminal_source)
filesystem = ast.parse(terminal.read('open_terminal/utils/fs.py').decode())
fs_class = next(node for node in filesystem.body if isinstance(node, ast.ClassDef) and node.name == 'UserFS')
methods = {node.name: node for node in fs_class.body if isinstance(node, ast.AsyncFunctionDef)}
for method, parameters in {'write': ('path',), 'write_bytes': ('path',), 'mkdir': ('path',),
                           'remove': ('path',), 'move': ('source', 'destination')}.items():
    assert method in methods and set(parameters).issubset({arg.arg for arg in methods[method].args.args}), method
operation_names = {
    node.name for node in ast.walk(terminal_tree)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
} | {
    node.value.value for node in ast.walk(terminal_tree)
    if isinstance(node, ast.keyword) and node.arg == 'operation_id'
    and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
}
for name in ('write_file', 'read_file', 'run_command'):
    assert name in operation_names, f'Open Terminal lost {name}'
print(f"Runtime contract passed: Open WebUI {VERSIONS['openWebUI']}, Open Terminal {VERSIONS['openTerminal']}")
