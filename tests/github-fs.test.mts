import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

test('the authenticated cloud HTTP tool creates, verifies, lists and reads a scoped GitHub file', async () => {
  // Bundle the real server; only Electron's outbound GitHub transport and logging
  // are replaced. No credentials or repositories from the desktop are accessed.
  const built = await build({
    entryPoints: [fileURLToPath(new URL('../src/main/services/github-fs.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'electron-log']
  })
  const files = new Map<string, string>()
  const outbound: { method: string; url: URL; body?: any }[] = []
  const sha = 'a'.repeat(40),
    commit = 'b'.repeat(40)
  const fakeGithub = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://api.github.com')
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
  const server = module.exports
  server.configureGithubFs(() => 'test-only-token')
  try {
    const mount = await server.mountGithubRepo({
      repoFullName: 'example/cloud-site',
      branch: 'feature/site'
    })
    const headers = { Authorization: 'Bearer ' + mount.apiKey, 'Content-Type': 'application/json' }
    const request = (route: string, init: RequestInit = {}) =>
      fetch(mount.url + route, { ...init, headers: { ...headers, ...init.headers } })
    assert.equal(
      (await fetch(mount.url + '/files/write', { method: 'POST', body: '{}' })).status,
      401
    )
    assert.equal((await request('/files/write', { method: 'POST', body: 'not-json' })).status, 400)
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
    assert.deepEqual((await (await request('/files/list?directory=/')).json()).entries, [])
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
    assert.equal((await request('/files/read?path=index.html')).status, 404)
  } finally {
    await server.stopGithubFs()
  }
})
