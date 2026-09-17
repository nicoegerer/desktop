import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspacePreviewManager } from '../src/main/services/workspace-preview.ts'
import { createWorkspacePreviewHandlers } from '../src/main/services/workspace-preview-ipc.ts'
import {
  cloudFixture,
  createGithubPreviewSource,
  blobSha
} from './helpers/github-preview-fixture.mts'

test('cloud preview IPC resolves only the registered repository and ignores renderer source/path injection', async () => {
  const f = cloudFixture({ 'index.html': '<h1>Registered cloud</h1>' })
  const manager = new WorkspacePreviewManager(),
    trusted = {},
    source = f.source()
  let terminals = [{ id: 'desktop-gh-fixture', cwd: source.root }]
  const refreshes: boolean[] = []
  const handlers = createWorkspacePreviewHandlers({
    manager,
    listTerminals: () => terminals,
    isTrustedSender: (event) => event === trusted,
    getRemoteSource: (id, fresh) => {
      assert.equal(id, 'desktop-gh-fixture')
      refreshes.push(fresh)
      return fresh ? f.source() : source
    },
    describeError: () => ({ ok: false, code: 'PREVIEW_START_FAILED', error: 'Safe failure' })
  })
  try {
    assert.deepEqual(await handlers.inspect(trusted, { terminalId: 'desktop-gh-fixture' }), {
      available: true,
      entryPath: 'index.html'
    })
    assert.deepEqual(await handlers.inspect(trusted, { terminalId: 'unregistered' }), {
      available: false
    })
    assert.equal((await handlers.open({}, { terminalId: 'desktop-gh-fixture' })).ok, false)
    const opened = await handlers.open(trusted, {
      terminalId: 'desktop-gh-fixture',
      workspacePath: '/private',
      source: { root: '/private' },
      repoFullName: 'other/repo'
    })
    assert.ok(opened.ok)
    assert.equal(opened.preview.workspacePath, source.root)
    assert.match(await (await fetch(opened.preview.url)).text(), /Registered cloud/)
    assert.deepEqual(refreshes, [false, true])
    terminals = []
    await handlers.releaseTerminal('desktop-gh-fixture')
    assert.equal(manager.getActive(), null)
    await assert.rejects(fetch(opened.preview.url))
  } finally {
    await handlers.closeAll()
  }
})

test('cloud preview serves HTML, relative CSS/modules and binary images through its isolated HTTP origin', async () => {
  const fixture = cloudFixture({
    'pages/index.html':
      '<link rel="stylesheet" href="../assets/style.css"><script src="../assets/app.js"></script>',
    'assets/style.css': 'body { color: rgb(1,2,3) }',
    'assets/app.js': 'document.body.dataset.loaded = "yes"',
    'assets/picture.png': Buffer.from([137, 80, 78, 71, 0, 255]),
    '.env': 'never served',
    'secret.json': '{"private":true}'
  })
  const manager = new WorkspacePreviewManager()
  const source = fixture.source()
  try {
    assert.deepEqual(await manager.inspect(source.root, source), {
      available: true,
      entryPath: 'pages/index.html'
    })
    assert.equal(manager.getActive(), null)
    const preview = await manager.open(
      { workspacePath: source.root, entryPath: 'pages/index.html' },
      source
    )
    const headers = {
      'X-Desktop-Preview': new URL(preview.url).searchParams.get('__desktop_preview')!
    }
    const html = await fetch(preview.url)
    assert.match(await html.text(), /\.\.\/assets\/style.css/)
    assert.match(html.headers.get('content-security-policy')!, /connect-src 'none'/)
    for (const [name, type] of [
      ['style.css', 'text/css'],
      ['app.js', 'text/javascript'],
      ['picture.png', 'image/png']
    ]) {
      const response = await fetch(new URL('/assets/' + name, preview.url), { headers })
      assert.equal(response.status, 200)
      assert.ok(response.headers.get('content-type')!.startsWith(type))
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        fixture.files.get('assets/' + name)
      )
    }
    assert.equal((await fetch(new URL('/assets/style.css', preview.url))).status, 403)
    for (const name of ['.env', 'secret.json', '%2e%2e%2fsecret.html'])
      assert.equal((await fetch(new URL('/' + name, preview.url), { headers })).status, 403)
    assert.equal((await fetch(preview.url, { method: 'POST' })).status, 405)
    assert.ok(fixture.calls[0].includes('trees/feature%2Fwebsite?recursive=1'))
  } finally {
    await manager.closeAll()
  }
})

test('cloud page resources stay pinned; refresh sees new files and closes the old origin', async () => {
  const f = cloudFixture({ 'index.html': '<h1>Old</h1>', 'style.css': 'old style' })
  const manager = new WorkspacePreviewManager()
  try {
    const source = f.source()
    const first = await manager.open({ workspacePath: source.root }, source)
    f.files.set('style.css', Buffer.from('new style'))
    f.files.set('index.html', Buffer.from('<h1>New</h1>'))
    assert.equal((await source.readFile('style.css')).toString(), 'old style')
    const nextSource = f.source()
    const second = await manager.open({ workspacePath: nextSource.root }, nextSource)
    assert.match(await (await fetch(second.url)).text(), /New/)
    assert.equal((await nextSource.readFile('style.css')).toString(), 'new style')
    assert.notEqual(new URL(first.url).port, new URL(second.url).port)
    await assert.rejects(fetch(first.url))
  } finally {
    await manager.closeAll()
  }
})

test('cloud preview fails closed after mount release, including previously cached bytes', async () => {
  const f = cloudFixture({ 'index.html': '<h1>Cloud</h1>' })
  const source = f.source(),
    manager = new WorkspacePreviewManager()
  try {
    const preview = await manager.open({ workspacePath: source.root }, source)
    f.retire()
    assert.equal((await fetch(preview.url)).status, 403)
    await assert.rejects(source.readFile('index.html'))
    assert.deepEqual(await manager.inspect(source.root, source), { available: false })
  } finally {
    await manager.closeAll()
  }
})

test('cloud repositories without safe static HTML do not expose a preview', async () => {
  const f = cloudFixture({
    'README.md': 'text',
    '.private/index.html': 'hidden',
    'app.ts': 'source'
  })
  const source = f.source(),
    manager = new WorkspacePreviewManager()
  assert.deepEqual(await manager.inspect(source.root, source), { available: false })
  assert.deepEqual(await manager.inspect('/another-root', source), { available: false })
  await assert.rejects(manager.open({ workspacePath: '/another-root' }, source))
})

test('cloud Git trees reject symlinks, submodules, oversized files and incomplete responses', async () => {
  const scope = { repoFullName: 'example/site', branch: 'main' }
  const entry = { path: 'index.html', mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 4 }
  const source = createGithubPreviewSource(
    scope,
    async () =>
      Response.json({
        sha: 'a'.repeat(40),
        truncated: false,
        tree: [
          { ...entry, mode: '120000' },
          { ...entry, path: 'submodule', mode: '160000', type: 'commit' },
          { ...entry, path: 'huge.html', size: 65 * 1024 * 1024 },
          { ...entry, path: '../escape.html' },
          entry
        ]
      }),
    () => true
  )
  assert.deepEqual(await source.listFiles(), ['index.html'])
  for (const response of [
    Response.json({}, { status: 403 }),
    Response.json({ sha: 'a'.repeat(40), truncated: true, tree: [entry] }),
    Response.json({ tree: [entry] })
  ]) {
    const bad = createGithubPreviewSource(
      scope,
      async () => response,
      () => true
    )
    await assert.rejects(bad.listFiles())
  }
})

test('cloud preview verifies Git blob bytes and does not trust response URLs', async () => {
  const bytes = Buffer.from('site'),
    sha = blobSha(bytes)
  const calls: string[] = []
  const source = createGithubPreviewSource(
    { repoFullName: 'example/site', branch: 'main' },
    async (route) => {
      calls.push(route)
      if (route.includes('/trees/'))
        return Response.json({
          sha: 'a'.repeat(40),
          truncated: false,
          tree: [
            {
              path: 'index.html',
              mode: '100644',
              type: 'blob',
              size: 4,
              sha,
              url: 'https://untrusted.example/'
            }
          ]
        })
      return Response.json({
        sha,
        size: 4,
        encoding: 'base64',
        content: Buffer.from('fake').toString('base64')
      })
    },
    () => true
  )
  await assert.rejects(source.readFile('index.html'))
  assert.equal(calls[1], '/repos/example/site/git/blobs/' + sha)
})
