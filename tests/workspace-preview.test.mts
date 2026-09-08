import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  WorkspacePreviewError,
  WorkspacePreviewManager
} from '../src/main/services/workspace-preview.ts'
import {
  WORKSPACE_PREVIEW_SANDBOX,
  isWorkspacePreviewNavigationAllowed,
  getWorkspacePreviewRequestHeaders,
  validWorkspacePreviewBounds
} from '../src/shared/workspace-preview.ts'

test('preview overlay is confined to the webview viewport', () => {
  assert.equal(
    validWorkspacePreviewBounds({ left: 0.7, top: 0.05, width: 0.3, height: 0.95 }),
    true
  )
  for (const bounds of [
    null,
    {},
    { left: -1, top: 0, width: 1, height: 1 },
    { left: 0.8, top: 0, width: 0.4, height: 1 },
    { left: 0, top: NaN, width: 1, height: 1 },
    { left: 0, top: 0, width: 0, height: 1 }
  ])
    assert.equal(validWorkspacePreviewBounds(bounds), false)
})

test('preview navigation allows only the current loopback origin and fails closed', () => {
  const active = 'http://127.0.0.1:43210/index.html?__desktop_preview=test'
  assert.equal(
    isWorkspacePreviewNavigationAllowed('http://127.0.0.1:43210/page.html', active),
    true
  )
  for (const target of [
    'https://example.com',
    'http://127.0.0.1:8080/',
    'http://localhost:43210/',
    'data:text/html,hello',
    'javascript:alert(1)',
    'blob:http://127.0.0.1:43210/id',
    'file:///C:/secret.html',
    'about:blank',
    'http://user:password@127.0.0.1:43210/'
  ])
    assert.equal(isWorkspacePreviewNavigationAllowed(target, active), false, target)
  for (const invalid of [
    null,
    undefined,
    '',
    'https://127.0.0.1:43210/',
    'http://127.0.0.1/',
    'http://user@127.0.0.1:43210/'
  ]) {
    assert.equal(isWorkspacePreviewNavigationAllowed(active, invalid), false)
  }
})

test('trusted preview headers never leak capabilities to external or retired origins', () => {
  const capability = 'a'.repeat(64)
  const active = `http://127.0.0.1:43210/index.html?__desktop_preview=${capability}`
  const original = { Accept: 'text/css', 'x-desktop-preview': 'stale' }
  assert.deepEqual(
    getWorkspacePreviewRequestHeaders('http://127.0.0.1:43210/style.css', active, original),
    {
      Accept: 'text/css',
      'X-Desktop-Preview': capability
    }
  )
  for (const target of [
    'http://127.0.0.1:43211/style.css',
    'https://example.com/style.css',
    'data:text/html,hello'
  ]) {
    assert.deepEqual(getWorkspacePreviewRequestHeaders(target, active, original), {
      Accept: 'text/css'
    })
  }
  assert.deepEqual(getWorkspacePreviewRequestHeaders(active, null, original), {
    Accept: 'text/css'
  })
  assert.deepEqual(
    getWorkspacePreviewRequestHeaders(active, active.replace(capability, 'bad'), original),
    { Accept: 'text/css' }
  )
  assert.equal(original['x-desktop-preview'], 'stale', 'caller headers are not mutated')
})

type Fixture = { directory: string; root: string; second: string; manager: WorkspacePreviewManager }

test('availability appears only for real local HTML and never replaces an active preview', async () => {
  const f = await fixture()
  try {
    const preview = await f.manager.open({ workspacePath: f.root })
    assert.deepEqual(await f.manager.inspect(f.root), { available: true, entryPath: 'index.html' })
    assert.deepEqual(await f.manager.inspect(path.join(f.root, 'assets')), { available: false })
    await writeFile(path.join(f.root, 'assets', 'custom.htm'), '<h1>Custom</h1>')
    assert.deepEqual(await f.manager.inspect(path.join(f.root, 'assets')), {
      available: true,
      entryPath: 'custom.htm'
    })
    assert.deepEqual(await f.manager.inspect(path.join(f.root, 'missing')), { available: false })
    assert.equal(f.manager.getActive()?.id, preview.id)
  } finally {
    await f.manager.closeAll()
    await rm(f.directory, { recursive: true, force: true })
  }
})

const fixture = async (): Promise<Fixture> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-workspace-preview-test-'))
  const root = path.join(directory, 'website')
  const second = path.join(directory, 'second')
  await mkdir(path.join(root, 'assets'), { recursive: true })
  await mkdir(second)
  await writeFile(
    path.join(root, 'index.html'),
    '<link rel="stylesheet" href="/style.css"><h1>First site</h1>'
  )
  await writeFile(path.join(root, 'style.css'), 'h1 { color: rgb(1, 2, 3) }')
  await writeFile(
    path.join(root, 'assets', 'module.mjs'),
    'document.body.dataset.module = "loaded"'
  )
  await writeFile(path.join(second, 'index.html'), '<h1>Second site</h1>')
  await writeFile(path.join(directory, 'outside.css'), 'private outside file')
  return { directory, root, second, manager: new WorkspacePreviewManager() }
}

const cleanup = async (value: Fixture): Promise<void> => {
  await value.manager.closeAll()
  const resolved = path.resolve(value.directory)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('desktop-workspace-preview-test-'))
  await rm(resolved, { recursive: true, force: true })
}

const request = (
  entryUrl: string,
  resource?: string,
  options: { headers?: Record<string, string>; method?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const url = new URL(entryUrl)
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: resource ?? `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: options.headers
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.once('error', reject)
        res.once('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.setTimeout(10_000, () => req.destroy(new Error('Preview request timed out')))
    req.once('error', reject)
    req.end()
  })

test('serves HTML with relative/root-relative styles and module assets on one isolated origin', async () => {
  const value = await fixture()
  try {
    const preview = await value.manager.open({ workspacePath: value.root })
    assert.equal(preview.workspacePath, await realpath(value.root))
    assert.equal(preview.entryPath, 'index.html')
    assert.equal(new URL(preview.url).hostname, '127.0.0.1')
    assert.equal((await request(preview.url)).status, 200)
    const css = await request(preview.url, '/style.css', { headers: { Referer: preview.url } })
    assert.equal(css.status, 200)
    assert.match(css.headers['content-type'] ?? '', /^text\/css/)
    assert.match(css.body, /rgb\(1, 2, 3\)/)
    const module = await request(preview.url, '/assets/module.mjs', {
      headers: { Referer: `${new URL(preview.url).origin}/style.css`, Origin: 'null' }
    })
    assert.equal(module.status, 200)
    assert.equal(module.headers['access-control-allow-origin'], 'null')
    assert.equal(module.headers['access-control-allow-credentials'], undefined)
    const opaqueAsset = await request(preview.url, '/assets/module.mjs', {
      headers: {
        Origin: 'null',
        'X-Desktop-Preview': new URL(preview.url).searchParams.get('__desktop_preview')!
      }
    })
    assert.equal(opaqueAsset.status, 200, 'opaque iframe assets have no Referer')
    assert.equal(opaqueAsset.headers['access-control-allow-origin'], 'null')
    assert.equal(
      (await request(preview.url, '/assets/module.mjs', { headers: { Origin: 'null' } })).status,
      403
    )
  } finally {
    await cleanup(value)
  }
})

test('sandbox and CSP forbid app origins, network APIs, forms, workers and privileged browser access', async () => {
  const value = await fixture()
  try {
    const preview = await value.manager.open({ workspacePath: value.root })
    const response = await request(preview.url)
    const csp = String(response.headers['content-security-policy'])
    assert.equal(WORKSPACE_PREVIEW_SANDBOX, 'allow-scripts')
    assert.match(csp, /sandbox allow-scripts(?:;|$)/)
    assert.doesNotMatch(csp, /allow-same-origin|allow-popups|allow-top-navigation|unsafe-eval/)
    for (const directive of [
      'connect-src',
      'form-action',
      'worker-src',
      'frame-src',
      'object-src'
    ]) {
      assert.ok(csp.includes(`${directive} 'none'`), directive)
    }
    assert.equal(response.headers['referrer-policy'], 'same-origin')
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.headers['set-cookie'], undefined)
    assert.equal(response.headers['access-control-allow-origin'], undefined)
  } finally {
    await cleanup(value)
  }
})

test('requires a preview capability or same-origin resource chain; rejects guessed ports and hostile Host headers', async () => {
  const value = await fixture()
  try {
    const preview = await value.manager.open({ workspacePath: value.root })
    assert.equal((await request(preview.url, '/index.html')).status, 403)
    assert.equal((await request(preview.url, '/index.html?__desktop_preview=wrong')).status, 403)
    assert.equal(
      (
        await request(preview.url, '/style.css', {
          headers: { Referer: 'https://evil.example/', Origin: 'null' }
        })
      ).status,
      403
    )
    assert.equal(
      (await request(preview.url, '/style.css', { headers: { Referer: 'not-a-url' } })).status,
      403
    )
    assert.equal(
      (await request(preview.url, undefined, { headers: { Host: 'evil.example' } })).status,
      403
    )
    assert.equal((await request(preview.url, undefined, { method: 'POST' })).status, 405)
    assert.equal((await request(preview.url, undefined, { method: 'OPTIONS' })).status, 405)
  } finally {
    await cleanup(value)
  }
})

test('rejects traversal before URL normalization, Windows aliases, hidden files and unapproved types', async () => {
  const value = await fixture()
  try {
    await writeFile(path.join(value.root, '.secret.css'), 'hidden')
    await writeFile(path.join(value.root, 'credentials.json'), '{"key":"do not serve"}')
    const preview = await value.manager.open({ workspacePath: value.root })
    for (const resource of [
      '/../outside.css',
      '/%2e%2e/outside.css',
      '/assets/../../outside.css',
      '/assets%2f..%2f..%2foutside.css',
      '/assets%5c..%5coutside.css',
      '/C%3a/secret.css',
      '/index.html%3a%3a%24DATA',
      '/.secret.css',
      '/credentials.json',
      '/assets./module.mjs',
      '/NUL.html',
      '/%00index.html',
      '/%ZZ'
    ]) {
      const result = await request(preview.url, resource, { headers: { Referer: preview.url } })
      assert.equal(result.status, 403, resource)
      assert.doesNotMatch(result.body, /private outside file|do not serve|hidden/)
      assert.ok(!result.body.includes(value.directory))
    }
    const missing = await request(preview.url, '/absent.html', {
      headers: { Referer: preview.url }
    })
    assert.equal(missing.status, 404)
    assert.ok(!missing.body.includes(value.directory))
  } finally {
    await cleanup(value)
  }
})

test('rejects outside and inside directory symlinks/junctions on every HTTP request', async () => {
  const value = await fixture()
  try {
    const preview = await value.manager.open({ workspacePath: value.root })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(value.directory, path.join(value.root, 'outside-link'), linkType)
    await symlink(path.join(value.root, 'assets'), path.join(value.root, 'inside-link'), linkType)
    for (const resource of ['/outside-link/outside.css', '/inside-link/module.mjs']) {
      assert.equal(
        (await request(preview.url, resource, { headers: { Referer: preview.url } })).status,
        403
      )
    }
  } finally {
    await cleanup(value)
  }
})

test('reload reads current file bytes; HEAD has no body and no file is changed by serving', async () => {
  const value = await fixture()
  try {
    const preview = await value.manager.open({ workspacePath: value.root })
    const before = await readFile(path.join(value.root, 'index.html'), 'utf8')
    const head = await request(preview.url, undefined, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body, '')
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(before))
    assert.equal(await readFile(path.join(value.root, 'index.html'), 'utf8'), before)
    await writeFile(path.join(value.root, 'index.html'), '<h1>Updated site</h1>')
    assert.match((await request(preview.url)).body, /Updated site/)
  } finally {
    await cleanup(value)
  }
})

test('workspace changes retire old URLs and never reuse a preview origin within the manager', async () => {
  const value = await fixture()
  try {
    const origins = new Set<string>()
    let previousUrl: string | undefined
    let previousId: string | undefined
    for (let index = 0; index < 6; index++) {
      const preview = await value.manager.open({
        workspacePath: index % 2 ? value.second : value.root
      })
      const origin = new URL(preview.url).origin
      assert.ok(!origins.has(origin))
      origins.add(origin)
      if (previousUrl) {
        await assert.rejects(request(previousUrl))
        assert.equal(
          (await request(preview.url, '/index.html', { headers: { Referer: previousUrl } })).status,
          403
        )
      }
      if (previousId) await value.manager.close(previousId)
      assert.equal(value.manager.getActive()?.id, preview.id)
      assert.match((await request(preview.url)).body, index % 2 ? /Second site/ : /First site/)
      previousUrl = preview.url
      previousId = preview.id
    }
    await value.manager.closeAll()
    assert.equal(value.manager.getActive(), null)
    await assert.rejects(request(previousUrl!))
  } finally {
    await cleanup(value)
  }
})

test('missing/invalid new selections clear old preview and return actionable typed errors', async () => {
  const value = await fixture()
  try {
    const preview = await value.manager.open({ workspacePath: value.root })
    await assert.rejects(
      value.manager.open({ workspacePath: value.root, entryPath: 'missing.html' }),
      {
        code: 'ENTRY_NOT_FOUND'
      }
    )
    assert.equal(value.manager.getActive(), null)
    await assert.rejects(request(preview.url))
    await assert.rejects(value.manager.open({ workspacePath: 'relative' }), {
      code: 'INVALID_WORKSPACE'
    })
    await assert.rejects(value.manager.open({ workspacePath: path.parse(value.root).root }), {
      code: 'INVALID_WORKSPACE'
    })
    await assert.rejects(
      value.manager.open({ workspacePath: value.root, entryPath: '../outside.css' }),
      { code: 'UNSAFE_PATH' }
    )
    await assert.rejects(
      value.manager.open({ workspacePath: value.root, entryPath: 'style.css' }),
      { code: 'UNSUPPORTED_ENTRY' }
    )
  } finally {
    await cleanup(value)
  }
})

test('subdirectory entry preserves asset paths and directory index URLs', async () => {
  const value = await fixture()
  try {
    await mkdir(path.join(value.root, 'page with spaces'))
    await writeFile(path.join(value.root, 'page with spaces', 'index.html'), '<h1>Nested</h1>')
    const preview = await value.manager.open({
      workspacePath: value.root,
      entryPath: 'page with spaces'
    })
    assert.match(new URL(preview.url).pathname, /page%20with%20spaces\/index.html$/)
    assert.equal((await request(preview.url)).status, 200)
    assert.equal(
      (await request(preview.url, '/page%20with%20spaces/', { headers: { Referer: preview.url } }))
        .status,
      200
    )
  } finally {
    await cleanup(value)
  }
})

test('concurrent opens are last-wins, and closeAll invalidates pending selections', async () => {
  const value = await fixture()
  try {
    const first = value.manager.open({ workspacePath: value.root })
    const second = value.manager.open({ workspacePath: value.second })
    const results = await Promise.allSettled([first, second])
    assert.equal(results[0].status, 'rejected')
    if (results[0].status === 'rejected') {
      assert.ok(results[0].reason instanceof WorkspacePreviewError)
      assert.equal(results[0].reason.code, 'SUPERSEDED')
    }
    assert.equal(results[1].status, 'fulfilled')
    assert.equal(value.manager.getActive()?.workspacePath, await realpath(value.second))
    const pending = value.manager.open({ workspacePath: value.root })
    await value.manager.closeAll()
    await assert.rejects(pending, { code: 'SUPERSEDED' })
    assert.equal(value.manager.getActive(), null)
  } finally {
    await cleanup(value)
  }
})
