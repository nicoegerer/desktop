import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createWorkspacePreviewHandlers } from '../src/main/services/workspace-preview-ipc.ts'
import type { WorkspacePreviewHandlers } from '../src/main/services/workspace-preview-ipc.ts'
import type {
  WorkspacePreviewInfo,
  WorkspacePreviewRequest
} from '../src/shared/workspace-preview.ts'

interface Fixture {
  trusted: object
  handlers: WorkspacePreviewHandlers
  opens: WorkspacePreviewRequest[]
  closes: string[]
  replaceTerminals(next: { id: string; cwd: string }[]): void
  setOpen(next: (request: WorkspacePreviewRequest) => Promise<WorkspacePreviewInfo>): void
  closeAllCount(): number
}

const fixture = (): Fixture => {
  const trusted = {}
  let terminals = [{ id: 'desktop-first', cwd: '/projects/first' }]
  let active: WorkspacePreviewInfo | null = null
  const opens: WorkspacePreviewRequest[] = []
  const closes: string[] = []
  let closeAllCount = 0
  let openImpl = async (request: WorkspacePreviewRequest): Promise<WorkspacePreviewInfo> => {
    active = {
      id: 'preview-first',
      url: 'http://127.0.0.1:43210/index.html',
      ...request,
      entryPath: request.entryPath ?? 'index.html'
    }
    return active
  }
  const handlers = createWorkspacePreviewHandlers({
    manager: {
      inspect: async () => ({ available: true, entryPath: 'index.html' }),
      open: async (request) => {
        opens.push(request)
        return openImpl(request)
      },
      close: async (id) => {
        closes.push(id)
        if (active?.id === id) active = null
      },
      closeAll: async () => {
        closeAllCount++
        active = null
      },
      getActive: () => active
    },
    listTerminals: () => terminals,
    isTrustedSender: (event) => event === trusted,
    describeError: () => ({ ok: false, code: 'PREVIEW_START_FAILED', error: 'Safe error.' })
  })
  return {
    trusted,
    handlers,
    opens,
    closes,
    replaceTerminals: (next: typeof terminals) => {
      terminals = next
    },
    setOpen: (next: typeof openImpl) => {
      openImpl = next
    },
    closeAllCount: () => closeAllCount
  }
}

test('preview IPC takes cwd only from a registered terminal, not the renderer payload', async () => {
  const f = fixture()
  const result = await f.handlers.open(f.trusted, {
    terminalId: 'desktop-first',
    entryPath: 'pages/site.html',
    workspacePath: '/private',
    cwd: '/private'
  })
  assert.equal(result.ok, true)
  assert.deepEqual(f.opens, [{ workspacePath: '/projects/first', entryPath: 'pages/site.html' }])
})

test('availability uses registered local workspaces and never opens a server', async () => {
  const f = fixture()
  assert.deepEqual(await f.handlers.inspect({}, { terminalId: 'desktop-first' }), {
    available: false
  })
  assert.deepEqual(await f.handlers.inspect(f.trusted, { terminalId: 'cloud-repo' }), {
    available: false
  })
  assert.deepEqual(await f.handlers.inspect(f.trusted, null), { available: false })
  assert.deepEqual(
    await f.handlers.inspect(f.trusted, { terminalId: 'desktop-first', workspacePath: '/private' }),
    { available: true, entryPath: 'index.html' }
  )
  assert.deepEqual(f.opens, [])
  assert.equal(f.handlers.getActive(f.trusted).ok, true)
})

test('unknown, cloud, malformed and untrusted preview requests never reach the filesystem manager', async () => {
  const f = fixture()
  for (const request of [
    null,
    [],
    'desktop-first',
    {},
    { terminalId: 'cloud-repo' },
    { terminalId: '/private' }
  ]) {
    assert.equal((await f.handlers.open(f.trusted, request)).ok, false)
  }
  assert.equal((await f.handlers.open({}, { terminalId: 'desktop-first' })).ok, false)
  assert.equal(
    (await f.handlers.open(f.trusted, { terminalId: 'desktop-first', entryPath: {} })).ok,
    false
  )
  assert.deepEqual(f.opens, [])
  assert.equal(f.handlers.getActive({}).ok, false)
})

test('preview IPC returns only safe errors when startup fails', async () => {
  const f = fixture()
  f.setOpen(async () => {
    throw new Error('secret-token and private path')
  })
  assert.deepEqual(await f.handlers.open(f.trusted, { terminalId: 'desktop-first' }), {
    ok: false,
    code: 'PREVIEW_START_FAILED',
    error: 'Safe error.'
  })
})

test('a workspace removed while its preview starts is rejected and retired', async () => {
  const f = fixture()
  f.setOpen(async (request) => {
    f.replaceTerminals([])
    return {
      id: 'late-preview',
      url: 'http://127.0.0.1:43210/',
      ...request,
      entryPath: request.entryPath ?? 'index.html'
    }
  })
  const result = await f.handlers.open(f.trusted, { terminalId: 'desktop-first' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'SUPERSEDED')
  assert.deepEqual(f.closes, ['late-preview'])
})

test('stale close IDs cannot close the current preview; unknown senders cannot close any preview', async () => {
  const f = fixture()
  await f.handlers.open(f.trusted, { terminalId: 'desktop-first' })
  assert.equal((await f.handlers.close({}, { id: 'preview-first' })).ok, false)
  assert.deepEqual(f.closes, [])
  await f.handlers.close(f.trusted, { id: 'old-preview' })
  const active = f.handlers.getActive(f.trusted)
  assert.ok(active.ok && active.preview?.id === 'preview-first')
  await f.handlers.close(f.trusted, { id: 'preview-first' })
  assert.deepEqual(f.handlers.getActive(f.trusted), { ok: true, preview: null })
})

test('workspace release and lifecycle cleanup retire only the relevant preview', async () => {
  const f = fixture()
  await f.handlers.open(f.trusted, { terminalId: 'desktop-first' })
  await f.handlers.releaseTerminal('another-terminal')
  assert.equal(f.closeAllCount(), 0)
  await f.handlers.releaseTerminal('desktop-first')
  assert.equal(f.closeAllCount(), 1)
  assert.deepEqual(f.handlers.getActive(f.trusted), { ok: true, preview: null })
  await f.handlers.closeAll()
  assert.equal(f.closeAllCount(), 2)
})

test('Electron wiring enforces main-frame IPC and subframe navigation confinement', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(source, /event\?\.sender === mainWindow\.webContents/)
  assert.match(source, /event\.senderFrame === mainWindow\.webContents\.mainFrame/)
  assert.match(
    source,
    /on\('will-frame-navigate'[\s\S]*?!event\.isMainFrame[\s\S]*?isWorkspacePreviewNavigationAllowed[\s\S]*?event\.preventDefault\(\)/
  )
  assert.match(source, /app\.on\('before-quit'[\s\S]*?await workspacePreview\.closeAll\(\)/)
})
