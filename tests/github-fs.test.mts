import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
import { cloudFixture } from './helpers/github-preview-fixture.mts'
import { WorkspacePreviewManager } from '../src/main/services/workspace-preview.ts'

// Each scenario restarts a server on the same port; do not reuse pooled sockets
// from an already closed fixture (notably ECONNRESET on Windows).
const fetch = (input: string | URL, init: RequestInit = {}) =>
  globalThis.fetch(input, { ...init, headers: { ...init.headers, Connection: 'close' } })

// Bundle the real server; replace only the outbound transport and logger.
const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/main/services/github-fs.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'electron-log']
})
const loadServer = (fakeGithub: (input: string, init?: RequestInit) => Promise<Response>) => {
  const require = createRequire(import.meta.url)
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', built.outputFiles![0].text)(
    (name: string) =>
      name === 'electron'
        ? { net: { fetch: fakeGithub } }
        : name === 'electron-log'
          ? { info() {}, warn() {}, error() {} }
          : require(name),
    module,
    module.exports
  )
  module.exports.configureGithubFs(() => 'test-only-token')
  return module.exports
}

for (const initiallyEmpty of [false, true])
  test('cloud HTTP list/write/read/preview lifecycle; unborn repo=' + initiallyEmpty, async () => {
    const files = new Map<string, string>()
    const previewTransport = cloudFixture(
      {},
      { repoFullName: 'example/cloud-site', branch: 'feature/site' }
    )
    const previewManager = new WorkspacePreviewManager()
    const outbound: { method: string; url: URL; body?: any }[] = []
    const sha = 'a'.repeat(40),
      commit = 'b'.repeat(40)
    const fakeGithub = async (input: string, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(input)
      assert.equal(url.origin, 'https://api.github.com')
      if (url.pathname === '/repos/example/cloud-site') {
        assert.equal(initiallyEmpty, true)
        return Response.json({
          full_name: 'example/cloud-site',
          default_branch: 'feature/site',
          size: 0
        })
      }
      if (url.pathname === '/repos/example/cloud-site/branches') {
        assert.equal(url.search, '?per_page=1')
        return Response.json(files.size ? [{ name: 'feature/site' }] : [])
      }
      if (url.pathname.startsWith('/repos/example/cloud-site/git/')) {
        if (initiallyEmpty && !files.size)
          return Response.json({ message: 'Git Repository is empty.' }, { status: 409 })
        previewTransport.files.clear()
        for (const [name, content] of files) previewTransport.files.set(name, Buffer.from(content))
        return previewTransport.request(url.pathname + url.search, init)
      }
      assert.ok(url.pathname.startsWith('/repos/example/cloud-site/contents/'))
      const name = decodeURIComponent(url.pathname.split('/contents/')[1])
      const method = init.method ?? 'GET'
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      outbound.push({ method, url, body })
      if (method === 'PUT') {
        assert.equal(body.branch, 'feature/site')
        files.set(name, Buffer.from(body.content, 'base64').toString('utf8'))
        return Response.json({ commit: { sha: commit } }, { status: 201 })
      }
      assert.ok(['feature/site', commit].includes(url.searchParams.get('ref')!))
      if (!name)
        if (initiallyEmpty && !files.size)
          return Response.json({ message: 'This repository is empty.' }, { status: 404 })
      if (!name)
        return Response.json(
          [...files.entries()].map(([name, content]) => ({
            name,
            path: name,
            type: 'file',
            size: Buffer.byteLength(content)
          }))
        )
      if (!files.has(name)) return Response.json({}, { status: 404 })
      return Response.json({
        name,
        path: name,
        type: 'file',
        sha,
        encoding: 'base64',
        content: Buffer.from(files.get(name)!).toString('base64')
      })
    }
    const server = loadServer(fakeGithub)
    try {
      const mount = await server.mountGithubRepo({
        repoFullName: 'example/cloud-site',
        branch: 'feature/site'
      })
      const headers = {
        Authorization: 'Bearer ' + mount.apiKey,
        'Content-Type': 'application/json'
      }
      assert.equal(server.getGithubPreviewSource('unregistered'), undefined)
      const emptyPreviewSource = server.getGithubPreviewSource(mount.id)
      assert.deepEqual(await previewManager.inspect(emptyPreviewSource.root, emptyPreviewSource), {
        available: false
      })
      assert.deepEqual(server.listGithubPreviewWorkspaces(), [
        { id: mount.id, cwd: emptyPreviewSource.root }
      ])
      const request = (route: string, init: RequestInit = {}) =>
        fetch(mount.url + route, { ...init, headers: { ...headers, ...init.headers } })
      assert.equal(
        (await fetch(mount.url + '/files/write', { method: 'POST', body: '{}' })).status,
        401
      )
      assert.equal(
        (await request('/files/write', { method: 'POST', body: 'not-json' })).status,
        400
      )
      assert.equal(
        (
          await request('/files/write', {
            method: 'POST',
            body: JSON.stringify({ path: '../escape', content: 'x' })
          })
        ).status,
        400
      )
      assert.equal(outbound.length, 0)
      const schema = await (await request('/openapi.json')).json()
      assert.equal(schema.paths['/files/write'].post.operationId, 'write_file')
      const emptyListing = await request('/files/list?directory=/')
      assert.equal(emptyListing.status, 200)
      assert.deepEqual(await emptyListing.json(), { dir: '/', entries: [] })
      const content = '<h1>Cloud works ✓</h1>'
      const saved = await request('/files/write', {
        method: 'POST',
        body: JSON.stringify({
          path: 'index.html',
          content,
          repoFullName: 'another/repository',
          branch: 'wrong-branch'
        })
      })
      assert.equal(saved.status, 200)
      assert.equal((await saved.json()).verified, true)
      assert.equal(files.get('index.html'), content)
      const previewSource = server.getGithubPreviewSource(mount.id)
      assert.notEqual(
        previewSource,
        emptyPreviewSource,
        'file writes invalidate availability cache'
      )
      assert.equal(server.getGithubPreviewSource(mount.id), previewSource)
      assert.notEqual(
        server.getGithubPreviewSource(mount.id, true),
        previewSource,
        'reload resolves a fresh branch snapshot'
      )
      assert.deepEqual(await previewManager.inspect(previewSource.root, previewSource), {
        available: true,
        entryPath: 'index.html'
      })
      const preview = await previewManager.open(
        { workspacePath: previewSource.root },
        previewSource
      )
      assert.equal(await (await fetch(preview.url)).text(), content)
      await server.mountGithubRepo({ repoFullName: 'example/cloud-site', branch: 'feature/site' })
      assert.equal(
        previewSource.isActive(),
        true,
        're-registering the same mount keeps its open preview valid'
      )
      const listed = await (await request('/files/list?directory=/')).json()
      assert.deepEqual(
        listed.entries.map((entry: any) => entry.name),
        ['index.html'],
        'write invalidates the old empty directory cache'
      )
      const read = await (await request('/files/read?path=index.html')).json()
      assert.equal(read.content, content)
      assert.equal(outbound.filter((call) => call.method === 'PUT').length, 1)
      assert.equal((await request('/execute', { method: 'POST', body: '{}' })).status, 405)
      assert.equal(server.unmountGithubRepos(new Set()), 1)
      assert.equal(previewSource.isActive(), false)
      assert.equal((await fetch(preview.url)).status, 403)
      assert.equal((await request('/files/read?path=index.html')).status, 404)
    } finally {
      await previewManager.closeAll()
      await server.stopGithubFs()
    }
  })

test('empty-root handling preserves inaccessible repos, missing branches, subdirectories and API errors', async () => {
  for (const scenario of [
    { root: 404, metadata: 404, expected: 404 },
    { root: 403, expected: 403 },
    { root: 429, expected: 429 },
    { root: 500, expected: 500 },
    { root: 404, branch: 'different', expected: 404 },
    { root: 404, fullName: 'other/repo', expected: 404 },
    { root: 404, branches: [{ name: 'main' }], expected: 404 },
    { root: 404, branches: {}, expected: 404 },
    { root: 404, branchStatus: 403, expected: 403 },
    { root: 404, subdir: 'missing', expected: 404 },
    { root: 409, branches: [], expected: 200 }
  ]) {
    const calls: string[] = []
    const server = loadServer(async (input, init) => {
      assert.equal(init?.method ?? 'GET', 'GET', 'opening a repo must not initialize it')
      const url = new URL(input)
      calls.push(url.pathname)
      if (url.pathname.includes('/contents/')) return Response.json({}, { status: scenario.root })
      if (url.pathname.endsWith('/branches'))
        return Response.json(scenario.branches ?? [], { status: scenario.branchStatus ?? 200 })
      return Response.json(
        {
          full_name: scenario.fullName ?? 'example/empty',
          default_branch: scenario.branch ?? 'main',
          size: 0
        },
        { status: scenario.metadata ?? 200 }
      )
    })
    try {
      const mount = await server.mountGithubRepo({ repoFullName: 'example/empty', branch: 'main' })
      const response = await fetch(
        mount.url + '/files/list?directory=' + (scenario.subdir ?? '/'),
        {
          headers: { Authorization: 'Bearer ' + mount.apiKey }
        }
      )
      assert.equal(response.status, scenario.expected, JSON.stringify(scenario))
      if (scenario.expected === 200)
        assert.deepEqual(await response.json(), { dir: '/', entries: [] })
      if (scenario.subdir || ![404, 409].includes(scenario.root)) assert.equal(calls.length, 1)
    } finally {
      await server.stopGithubFs()
    }
  }
})

test('an initial empty root is not cached when the first commit is created outside the app', async () => {
  let initialized = false
  const server = loadServer(async (input) => {
    const url = new URL(input)
    if (url.pathname.includes('/contents/'))
      return initialized
        ? Response.json([{ name: 'first.txt', type: 'file', size: 1 }])
        : Response.json({}, { status: 404 })
    if (url.pathname.endsWith('/branches')) return Response.json([])
    return Response.json({ full_name: 'example/empty', default_branch: 'main' })
  })
  try {
    const mount = await server.mountGithubRepo({ repoFullName: 'example/empty', branch: 'main' })
    const list = () =>
      fetch(mount.url + '/files/list', {
        headers: { Authorization: 'Bearer ' + mount.apiKey }
      }).then((r) => r.json())
    assert.deepEqual((await list()).entries, [])
    initialized = true
    assert.equal((await list()).entries[0].name, 'first.txt')
  } finally {
    await server.stopGithubFs()
  }
})
