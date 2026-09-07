import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTerminalStoreBridge } from '../src/renderer/src/lib/guest/terminal-store-bridge.ts'

interface TestStore<T> {
  value: T
  changes: T[]
  set(next: T): void
  subscribe(run: (value: T) => void): () => void
}
interface Fixture {
  stores: {
    terminalServers: TestStore<Array<{ id?: string; url: string }> | null>
    selectedTerminalId: TestStore<string | null>
    showFileNavPath: TestStore<string | null>
    showFileNavDir: TestStore<string | null>
    showControls: TestStore<boolean>
  }
  calls: Array<{ url: string; init?: RequestInit }>
  bridge: ReturnType<typeof createTerminalStoreBridge>
}

function writable<T>(value: T): TestStore<T> {
  const changes: T[] = []
  return {
    get value() {
      return value
    },
    changes,
    set(next: T): void {
      value = next
      changes.push(next)
    },
    subscribe(run: (value: T) => void): () => void {
      run(value)
      return () => {}
    }
  }
}

function setup(fetchOverride?: typeof fetch): Fixture {
  const stores: Fixture['stores'] = {
    terminalServers: writable([{ url: 'https://custom.example' }]),
    selectedTerminalId: writable('desktop-ws-test'),
    showFileNavPath: writable('C:/work/test/old.html'),
    showFileNavDir: writable('C:/work/test/old.html'),
    showControls: writable(true)
  }
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const bridge = createTerminalStoreBridge(
    stores,
    async (url, init) => {
      calls.push({ url: String(url), init })
      if (fetchOverride) return fetchOverride(url, init)
      return Response.json(
        String(url).endsWith('/files/cwd')
          ? { cwd: 'C:/work/whitemode' }
          : [
              { id: 'desktop-ws-test', url: 'http://127.0.0.1:1' },
              { id: 'desktop-ws-white', url: 'http://127.0.0.1:2' }
            ]
      )
    },
    () => 'test-session-token'
  )
  return { stores, calls, bridge }
}

test('same-chat folder switch resets preview and back stack before selecting the new terminal', async () => {
  const h = setup()
  assert.equal(
    await h.bridge.select('desktop-ws-white', () => true, {
      path: 'C:/work/whitemode',
      chatId: 'same-chat',
      context: 'same-chat'
    }),
    true
  )
  assert.deepEqual(h.stores.selectedTerminalId.changes, [null, 'desktop-ws-white'])
  assert.equal(h.stores.showFileNavPath.value, null)
  assert.equal(h.stores.showFileNavDir.value, null)
  assert.deepEqual(
    h.stores.terminalServers.value!.map((t) => t.url),
    [
      'https://custom.example',
      '/api/v1/terminals/desktop-ws-test',
      '/api/v1/terminals/desktop-ws-white'
    ]
  )
  const cwd = h.calls.find((c) => c.url.endsWith('/files/cwd'))!
  assert.equal(cwd.url, '/api/v1/terminals/desktop-ws-white/files/cwd')
  assert.equal((cwd.init?.headers as Record<string, string>)['X-Session-Id'], 'same-chat')
  assert.deepEqual(JSON.parse(cwd.init?.body as string), { path: 'C:/work/whitemode' })
})

test('another message in the same workspace keeps the current preview but reasserts the selected root', async () => {
  const h = setup()
  const workspace = { path: 'C:/work/test', chatId: 'chat', context: 'chat' }
  await h.bridge.select('desktop-ws-test', () => true, workspace)
  h.stores.selectedTerminalId.changes.length = 0
  h.stores.showFileNavPath.set('C:/work/test/current.html')
  await h.bridge.select('desktop-ws-test', () => true, workspace)
  assert.equal(h.stores.showFileNavPath.value, 'C:/work/test/current.html')
  assert.ok(!h.stores.selectedTerminalId.changes.includes(null))
  assert.equal(h.calls.filter((c) => c.url.endsWith('/files/cwd')).length, 2)
})

test('changing chats using the same terminal still clears the previous chat preview', async () => {
  const h = setup()
  await h.bridge.select('desktop-ws-test', () => true, { context: 'first' })
  h.stores.selectedTerminalId.changes.length = 0
  await h.bridge.select('desktop-ws-test', () => true, { context: 'second' })
  assert.equal(h.stores.showFileNavPath.value, null)
  assert.deepEqual(h.stores.selectedTerminalId.changes, [null, 'desktop-ws-test'])
})

test('a delayed terminal-list response cannot restore a superseded selection', async () => {
  let resolve!: (response: Response) => void
  let current = true
  const h = setup(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const pending = h.bridge.select('desktop-ws-white', () => current)
  await Promise.resolve()
  current = false
  resolve(Response.json([{ id: 'desktop-ws-white' }]))
  assert.equal(await pending, false)
  assert.deepEqual(h.stores.selectedTerminalId.changes, [])
  assert.deepEqual(h.stores.showFileNavPath.changes, [])
})

test('failure to set the current chat directory leaves the old selection intact', async () => {
  const h = setup(async (url) =>
    Response.json(
      String(url).endsWith('/files/cwd')
        ? { detail: 'not available' }
        : [{ id: 'desktop-ws-white' }],
      { status: String(url).endsWith('/files/cwd') ? 503 : 200 }
    )
  )
  assert.equal(
    await h.bridge.select('desktop-ws-white', () => true, { path: 'C:/work/whitemode' }),
    false
  )
  assert.equal(h.stores.selectedTerminalId.value, 'desktop-ws-test')
})

test('detaching clears stale file-open requests without a network call', async () => {
  const h = setup()
  assert.equal(await h.bridge.select(null), true)
  assert.equal(h.stores.showFileNavPath.value, null)
  assert.equal(h.stores.showFileNavDir.value, null)
  assert.equal(h.stores.selectedTerminalId.value, null)
  assert.equal(h.calls.length, 0)
})

test('the store bridge remains self-contained when compiled into the injected script', () => {
  const factory = new Function('return (' + createTerminalStoreBridge.toString() + ')')()
  const h = setup()
  assert.doesNotThrow(() => factory(h.stores, fetch, () => ''))
})
