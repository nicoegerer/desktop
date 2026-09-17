import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

// Exercise the actual Electron callbacks, without starting Electron. This catches
// divergent authentication checks between listing repos and selecting a repo.
const source = ts.createSourceFile(
  'index.ts',
  readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)
const callbacks = new Map<string, string>()
const visit = (node: ts.Node): void => {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(source) === 'ipcMain' &&
    node.expression.name.text === 'handle' &&
    ts.isStringLiteral(node.arguments[0]) &&
    ['workspace:chip:repos', 'workspace:chip:cloud'].includes(node.arguments[0].text)
  ) {
    callbacks.set(node.arguments[0].text, node.arguments[1].getText(source))
  }
  ts.forEachChild(node, visit)
}
visit(source)
assert.equal(callbacks.size, 2)

const fixture = (mode: 'cli' | 'token' | 'unavailable') => {
  const calls: string[] = []
  const request = async () => Response.json({})
  const access = mode === 'cli' ? request : mode === 'token' ? 'fixture-token' : null
  const dependencies = {
    getManagedServicesManager: () => ({
      getGithubCliRequest: () => (mode === 'cli' ? request : null),
      getGithubAccessToken: () => (mode === 'token' ? 'fixture-token' : null)
    }),
    listGithubRepositories: async (actual: unknown) => {
      assert.equal(actual, access)
      calls.push('list')
      return [{ fullName: 'owner/test', defaultBranch: 'main' }]
    },
    workspacePreview: {
      closeAll: async () => {
        calls.push('close-preview')
      }
    },
    mountGithubRepo: async (repo: unknown) => {
      assert.deepEqual(repo, { repoFullName: 'owner/test', branch: 'main' })
      calls.push('mount')
      return { id: 'desktop-gh-test', name: 'test' }
    },
    syncWorkspaceRegistration: async () => {
      calls.push('register')
    },
    chipError: (cause: Error) => ({ ok: false, error: cause.message })
  }
  const handler = (name: string) => {
    const body = ts.transpileModule('const handler = (' + callbacks.get(name) + ');', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText
    return new Function(...Object.keys(dependencies), body + '\nreturn handler;')(
      ...Object.values(dependencies)
    )
  }
  return { calls, list: handler('workspace:chip:repos'), open: handler('workspace:chip:cloud') }
}

for (const mode of ['cli', 'token'] as const) {
  test(`real workspace IPC lists AND opens repositories with ${mode} authentication`, async () => {
    const f = fixture(mode)
    assert.equal((await f.list()).ok, true)
    assert.deepEqual(await f.open({}, { repoFullName: 'owner/test', branch: 'main' }), {
      ok: true,
      terminal: { id: 'desktop-gh-test', name: 'test' }
    })
    assert.deepEqual(f.calls, ['list', 'close-preview', 'mount', 'register'])
  })
}

test('real workspace IPC fails closed when the GitHub connection is unavailable', async () => {
  const f = fixture('unavailable')
  assert.equal((await f.list()).ok, false)
  assert.equal((await f.open({}, { repoFullName: 'owner/test', branch: 'main' })).ok, false)
  assert.deepEqual(f.calls, [])
})

test('real workspace IPC rejects an incomplete selection before mounting or changing the preview', async () => {
  const f = fixture('cli')
  for (const repo of [null, {}, { repoFullName: 'owner/test' }, { branch: 'main' }]) {
    assert.equal((await f.open({}, repo)).ok, false)
  }
  assert.deepEqual(f.calls, [])
})
