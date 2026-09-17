import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const load = async (file: string) => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs'
  })
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', built.outputFiles![0].text)(
    createRequire(import.meta.url),
    module,
    module.exports
  )
  return module.exports
}
const { createGithubCliRequest, githubApiPath, githubActionsLogs } = await load(
  '../src/main/services/github-cli.ts'
)
const { GithubCliBridge, githubCliOpenApi } = await load(
  '../src/main/services/github-cli-bridge.ts'
)
const result = (status: number, body: unknown) => ({
  code: status >= 400 ? 1 : 0,
  stdout: `HTTP/2.0 ${status} Result\r\nContent-Type: application/json\r\nAuthorization: must-not-escape\r\n\r\n${JSON.stringify(body)}`
})

test('CLI transport uses fixed host and arguments; body goes through stdin, never argv', async () => {
  const calls: any[] = []
  const request = createGithubCliRequest(async (...args: any[]) => {
    calls.push(args)
    return result(201, { commit: 'verified-by-writer' })
  })
  const body = JSON.stringify({ content: 'not-a-command', branch: 'main' })
  const response = await request('/repos/owner/repo/contents/index.html', { method: 'PUT', body })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('authorization'), null)
  assert.equal(calls[0][1], body)
  assert.equal(calls[0][0].includes(body), false)
  assert.deepEqual(calls[0][0].slice(0, 6), [
    'api',
    '--hostname',
    'github.com',
    '--include',
    '--method',
    'PUT'
  ])
  assert.deepEqual(calls[0][0].slice(-3), ['--input', '-', '/repos/owner/repo/contents/index.html'])
})

test('GitHub errors preserve status and payload; CLI failure never falls back to another account', async () => {
  const request = createGithubCliRequest(async () =>
    result(403, { message: 'Resource not accessible by integration' })
  )
  const response = await request('/repos/o/r/pages')
  assert.equal(response.status, 403)
  assert.equal((await response.json()).message, 'Resource not accessible by integration')
  const failed = createGithubCliRequest(async () => ({ code: 1, stdout: '' }))
  await assert.rejects(failed('/user'), /No fallback account/)
})

test('API path rejects URLs, CLI injection, placeholders and traversal; transport rejects admin writes', async () => {
  for (const path of [
    'https://evil.test/',
    '//evil.test',
    '--hostname=evil.test',
    '/repos/{owner}/{repo}',
    '/repos/a/../x',
    '/repos/a/%2e%2e/x',
    '/repos/a\\x',
    '/user\n-H: x',
    '/%GG',
    '/user#x'
  ])
    assert.throws(() => githubApiPath(path))
  assert.equal(
    githubApiPath('/repos/o/r/actions/runs?per_page=5'),
    '/repos/o/r/actions/runs?per_page=5'
  )
  assert.equal(
    githubApiPath('/repos/o/r/contents/My%20Page%23one.html'),
    '/repos/o/r/contents/My%20Page%23one.html'
  )
  let called = false
  const request = createGithubCliRequest(async () => {
    called = true
    return result(200, {})
  })
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT'])
    await assert.rejects(request('/repos/o/r', { method }), /not account administration/)
  assert.equal(called, false)
})

test('Actions logs have validated arguments, pagination and explicit unavailable errors', async () => {
  const calls: any[] = []
  const run = async (args: string[]) => {
    calls.push(args)
    return { code: 0, stdout: 'x'.repeat(32_010) }
  }
  const first = await githubActionsLogs({ repository: 'o/r', run_id: '123' }, run)
  assert.equal(first.text.length, 32_000)
  assert.equal(first.next_offset, 32_000)
  assert.deepEqual(calls[0], ['run', 'view', '123', '--repo', 'github.com/o/r', '--log-failed'])
  const next = await githubActionsLogs(
    { repository: 'o/r', run_id: '123', offset: 32_000, failed_only: false },
    run
  )
  assert.equal(next.text.length, 10)
  assert.equal(next.next_offset, null)
  for (const invalid of [
    { repository: 'https://evil.test/o/r', run_id: '123' },
    { repository: 'o/r', run_id: '--help' }
  ])
    await assert.rejects(githubActionsLogs(invalid, run))
  await assert.rejects(
    githubActionsLogs({ repository: 'o/r', run_id: '123' }, async () => ({
      code: 1,
      stdout: 'private failure'
    })),
    /Actions logs are unavailable/
  )
})

test('loopback bridge exposes only two read tools, enforces auth and rejects mutation arguments', async () => {
  const calls: string[][] = []
  const bridge = new GithubCliBridge(async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'run')
      return { code: 0, stdout: 'Setup Pages: Resource not accessible by integration' }
    const path = args.at(-1)
    return path === '/user'
      ? result(200, { login: 'fixture' })
      : path?.endsWith('/pages')
        ? result(403, { message: 'forbidden' })
        : result(200, { workflow_runs: [{ id: 123, conclusion: 'failure' }] })
  })
  try {
    assert.equal(await bridge.start(), 'fixture')
    const target = bridge.target('github-fixture', 'GitHub', true)
    assert.match(target.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.match(target.id, /^github-cli-/)
    const headers = { Authorization: 'Bearer ' + target.key, 'Content-Type': 'application/json' }
    assert.equal((await fetch(target.url + '/openapi.json')).status, 401)
    const schema = await (await fetch(target.url + '/openapi.json', { headers })).json()
    assert.deepEqual(schema, githubCliOpenApi)
    assert.deepEqual(Object.keys(schema.paths), ['/read', '/logs'])
    const request = (path: string, body: unknown) =>
      fetch(target.url + path, { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal((await request('/read', { path: '/user', method: 'DELETE' })).status, 400)
    assert.equal((await request('/read', { path: '/user', body_json: '{}' })).status, 400)
    assert.equal((await request('/api', { path: '/user' })).status, 404)
    const runs = await (await request('/read', { path: '/repos/o/r/actions/runs' })).json()
    assert.equal(runs.data.workflow_runs[0].conclusion, 'failure')
    const pages = await (await request('/read', { path: '/repos/o/r/pages' })).json()
    assert.deepEqual(pages, { status: 403, ok: false, data: { message: 'forbidden' } })
    const logs = await (await request('/logs', { repository: 'o/r', run_id: '123' })).json()
    assert.match(logs.text, /Resource not accessible/)
    assert.ok(calls.filter((args) => args[0] === 'api').every((args) => args[5] === 'GET'))
    await bridge.stop()
    assert.equal(bridge.target('id', 'name', true), null)
    await assert.rejects(fetch(target.url + '/openapi.json', { headers }))
  } finally {
    await bridge.stop()
  }
})

test('failed sign-in creates no registered tool server', async () => {
  const bridge = new GithubCliBridge(async () => result(401, { message: 'Bad credentials' }))
  await assert.rejects(bridge.start(), /login is not usable/)
  assert.equal(bridge.target('id', 'GitHub', true), null)
})

test('CLI transport allows only the approved Pages and Actions POST endpoints', async () => {
  const calls: string[][] = []
  const request = createGithubCliRequest(async (args: string[]) => {
    calls.push(args)
    return { code: 0, stdout: 'HTTP/2.0 204 No Content\r\nContent-Type: application/json\r\n\r\n' }
  })
  for (const path of [
    '/repos/o/r/pages',
    '/repos/o/r/actions/workflows/deploy.yml/dispatches',
    '/repos/o/r/actions/runs/123/rerun',
    '/repos/o/r/actions/runs/123/rerun-failed-jobs'
  ])
    assert.equal((await request(path, { method: 'POST' })).status, 204)
  for (const path of [
    '/user/keys',
    '/repos/o/r',
    '/repos/o/r/actions/runs/123/cancel',
    '/repos/o/r/pages?override=1',
    '/repos/o/r/collaborators',
    '/repos/o/r/actions/secrets'
  ])
    await assert.rejects(request(path, { method: 'POST' }))
  assert.equal(calls.length, 4)
})
