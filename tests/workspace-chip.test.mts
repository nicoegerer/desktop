import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildWorkspaceChipScript } from '../src/renderer/src/lib/guest/workspace-chip.ts'

const script = (): string =>
  buildWorkspaceChipScript({
    alwaysOnToolIds: ['server:desktop-garmin', 'server:mcp:desktop-github-mcp'],
    hiddenToolNames: ['Garmin', 'GitHub MCP'],
    german: true
  })

test('the injected script is syntactically valid JavaScript', () => {
  // It is handed to the Open WebUI page as text, where a syntax error would be
  // silent — the chip would simply never appear.
  assert.doesNotThrow(() => new Function(script()))
})

test('the payload rewriter survives being injected as text', () => {
  const source = script()

  // `applyWorkspaceToPayload` is embedded via toString(); a reference to an
  // import would compile here and fail only inside the page.
  assert.ok(source.includes('function applyWorkspaceToPayload'))
  assert.ok(!/\bchat_payload_1\b|\bimport\b/.test(source))
})

test('the connectors and hidden names are embedded', () => {
  const source = script()

  assert.ok(source.includes('server:desktop-garmin'))
  assert.ok(source.includes('server:mcp:desktop-github-mcp'))
  assert.ok(source.includes('GitHub MCP'))
})

test('running the script twice reconfigures instead of stacking patches', () => {
  const source = script()

  // A second injection after a reload must not wrap fetch again.
  assert.ok(source.includes('if (window[FLAG])'))
  assert.ok(source.includes('configure'))
})

test('the chat request is the only request that gets rewritten', () => {
  const source = script()

  assert.ok(source.includes("url.indexOf('/api/chat/completions')"))
})

// ─── Running the script ─────────────────────────────────
//
// The checks above only read the source. These execute it against a stub of the
// browser surface it touches, because the failures that matter — a rejected
// fetch, a render loop — only appear when it runs.

interface Harness {
  window: Record<string, unknown>
  calls: Array<{ url: string; body: unknown }>
  bridge: Array<Record<string, unknown>>
  mutate: () => void
  flushFrames: (rounds?: number) => void
  settle: (rounds?: number) => Promise<void>
  storage: () => Record<string, string>
  renderCount: () => number
  navigate: (path: string) => void
}

const run = (seed?: Record<string, unknown>, initialPath = '/c/chat-123'): Harness => {
  const calls: Array<{ url: string; body: unknown }> = []
  const bridge: Array<Record<string, unknown>> = []
  const store: Record<string, string> = {}
  if (seed) store['desktop:workspace-selection'] = JSON.stringify(seed)
  let frames: Array<() => void> = []
  let observerCallback: (() => void) | null = null
  let renders = 0
  // A real MutationObserver delivers as a microtask, so a runaway render shows
  // up as an unbounded chain of callbacks rather than a stack overflow.
  let queued = 0
  const notify = (): void => {
    if (!observerCallback || queued > 200) return
    queued++
    queueMicrotask(() => {
      queued--
      observerCallback?.()
    })
  }

  const byId = new Map<string, Record<string, unknown>>()

  const element = (): Record<string, unknown> => {
    let text = ''
    const node: Record<string, unknown> = {
      style: { cssText: '', opacity: '', background: '' },
      dataset: {},
      title: '',
      isConnected: true,
      children: [] as unknown[],
      classList: { toggle: () => {}, add: () => {}, remove: () => {} },
      getAttribute: () => null,
      setAttribute: (name: string, value: string) => {
        if (name === 'id') byId.set(value, node)
      },
      querySelector: () => null,
      querySelectorAll: () => [] as unknown[],
      closest: () => null,
      contains: () => false,
      appendChild: (child: unknown) => {
        renders++
        ;(node.children as unknown[]).push(child)
        notify()
      },
      removeChild: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0 })
    }
    // Elements the script injects must be findable afterwards, or a
    // create-if-missing helper would recreate them on every pass and the test
    // would blame the script for the stub's forgetfulness.
    Object.defineProperty(node, 'id', {
      get: () => '',
      set: (value: string) => byId.set(value, node)
    })
    // Assigning textContent replaces the element's text node, which a
    // childList observer reports — that is what turned an unconditional write
    // into an endless render loop.
    Object.defineProperty(node, 'textContent', {
      get: () => text,
      set: (value: string) => {
        text = value
        renders++
        notify()
      }
    })
    return node
  }

  const row = element()
  const anchor = element()
  const other = element()
  anchor.parentElement = row
  row.contains = (node: unknown) => node === other || node === anchor
  ;(row as Record<string, unknown>).parentElement = null

  const pageLocation = { pathname: initialPath }
  const win: Record<string, unknown> = {
    fetch: (url: unknown, init: unknown) => {
      // Mirrors the browser: the real fetch is bound to window and throws when
      // invoked with any other receiver.
      // eslint-disable-next-line @typescript-eslint/no-invalid-this
      calls.push({ url: String(url), body: (init as { body?: string })?.body })
      return Promise.resolve({ ok: true })
    },
    addEventListener: () => {},
    electronAPI: {
      send: (data: Record<string, unknown>) => {
        bridge.push(data)
        return Promise.resolve(null)
      }
    },
    innerWidth: 1200,
    innerHeight: 800,
    requestAnimationFrame: (fn: () => void) => {
      frames.push(fn)
      return frames.length
    },
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      }
    },
    location: pageLocation,
    history: {
      pushState: (_state: unknown, _title: string, path: string) => {
        pageLocation.pathname = path
      },
      replaceState: (_state: unknown, _title: string, path: string) => {
        pageLocation.pathname = path
      }
    },
    console: { warn: () => {} },
    MutationObserver: class {
      constructor(cb: () => void) {
        observerCallback = cb
      }
      observe(): void {}
      disconnect(): void {}
    }
  }

  // The real fetch rejects a foreign receiver; reproduce that so a `.call(this)`
  // from a strict-mode module is caught here instead of in the app.
  const boundFetch = win.fetch as (...args: unknown[]) => unknown
  win.fetch = function (this: unknown, ...args: unknown[]) {
    if (this !== win) throw new TypeError('Illegal invocation')
    return boundFetch(...args)
  }

  const doc: Record<string, unknown> = {
    head: element(),
    documentElement: element(),
    body: element(),
    addEventListener: () => {},
    createElement: () => element(),
    getElementById: (id: string) =>
      id === 'input-menu-button'
        ? anchor
        : id === 'integration-menu-button'
          ? other
          : (byId.get(id) ?? null),
    querySelector: () => null,
    querySelectorAll: () => [] as unknown[]
  }

  const fn = new Function(
    'window',
    'document',
    'localStorage',
    'location',
    'console',
    'MutationObserver',
    'requestAnimationFrame',
    script()
  )
  fn(
    win,
    doc,
    win.localStorage,
    win.location,
    win.console,
    win.MutationObserver,
    win.requestAnimationFrame
  )

  return {
    window: win,
    calls,
    bridge,
    storage: () => store,
    navigate: (path: string) => {
      ;(
        win.history as { pushState: (state: unknown, title: string, path: string) => void }
      ).pushState(null, '', path)
    },
    mutate: () => notify(),
    settle: async (rounds = 50) => {
      for (let i = 0; i < rounds; i++) {
        const due = frames
        frames = []
        due.forEach((f) => f())
        await Promise.resolve()
      }
    },
    flushFrames: (rounds = 5) => {
      for (let i = 0; i < rounds; i++) {
        const due = frames
        frames = []
        due.forEach((f) => f())
      }
    },
    renderCount: () => renders
  }
}

test('a bare fetch call still works after the patch', async () => {
  const h = run()

  // Open WebUI's bundles are strict-mode modules, so `fetch(...)` arrives with
  // an undefined receiver. Forwarding that receiver made every request in the
  // page fail and the app never finished loading.
  const detached = h.window.fetch as (url: string, init?: unknown) => Promise<unknown>
  await assert.doesNotReject(() => detached('/api/v1/models'))
  assert.equal(h.calls.length, 1)
})

test('a chat request is rewritten without breaking the call', async () => {
  const h = run()
  const detached = h.window.fetch as (url: string, init?: unknown) => Promise<unknown>

  await detached('/api/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  })

  const sent = JSON.parse(String(h.calls[0].body))
  assert.deepEqual(sent.tool_ids, ['server:desktop-garmin', 'server:mcp:desktop-github-mcp'])
})

test('the selected workspace applies to every message in the same conversation', async () => {
  const h = run({
    'chat-123': { mode: 'local', terminalId: 'desktop-ws-test', label: 'test' }
  })
  const detached = h.window.fetch as (url: string, init?: unknown) => Promise<unknown>

  for (const content of ['first message', 'second message']) {
    await detached('/api/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content }] })
    })
  }

  assert.equal(JSON.parse(String(h.calls[0].body)).terminal_id, 'desktop-ws-test')
  assert.equal(JSON.parse(String(h.calls[1].body)).terminal_id, 'desktop-ws-test')
})

test('a request the page makes with no init is passed through', async () => {
  const h = run()
  const detached = h.window.fetch as (url: string) => Promise<unknown>

  await assert.doesNotReject(() => detached('/api/config'))
})

test('rendering settles instead of driving itself in a loop', async () => {
  const h = run()

  // Mounting the chip and writing its label are themselves DOM changes the
  // observer reports. Without idempotent writes each render schedules the next
  // one and the page never goes idle.
  await h.settle()
  const mounted = h.renderCount()
  assert.ok(mounted > 0, 'the chip should have been mounted')

  await h.settle()
  assert.equal(h.renderCount(), mounted, 'the page must go quiet once the chip is up')
})

// ─── Releasing unused folders ───────────────────────────

test('only the workspaces conversations still point at are kept open', async () => {
  const h = run({
    'chat-123': { mode: 'local', terminalId: 'desktop-ws-aaa', label: 'test1' },
    'chat-456': { mode: 'local', terminalId: 'desktop-ws-bbb', label: 'desktop' },
    'chat-789': { mode: 'cloud', repoFullName: 'nicoegerer/test1', branch: 'main' }
  })
  await h.settle()

  // Open Terminal runs with the folder as its working directory, so a folder
  // held open for a conversation that no longer wants it cannot be deleted.
  const keepAlive = h.bridge.filter((c) => c.type === 'workspaceKeepAlive')
  assert.equal(keepAlive.length, 1)
  assert.deepEqual(keepAlive[0].ids, ['desktop-ws-aaa', 'desktop-ws-bbb'])
})

test('a cloud-only conversation keeps no folder open', async () => {
  const h = run({
    'chat-789': { mode: 'cloud', repoFullName: 'nicoegerer/test1', branch: 'main' }
  })
  await h.settle()

  const keepAlive = h.bridge.filter((c) => c.type === 'workspaceKeepAlive')
  assert.deepEqual(keepAlive[0].ids, [])
})

test('the same folder used by two conversations is reported once', async () => {
  const h = run({
    'chat-1': { mode: 'local', terminalId: 'desktop-ws-aaa', label: 'test1' },
    'chat-2': { mode: 'local', terminalId: 'desktop-ws-aaa', label: 'test1' }
  })
  await h.settle()

  const keepAlive = h.bridge.filter((c) => c.type === 'workspaceKeepAlive')
  assert.deepEqual(keepAlive[0].ids, ['desktop-ws-aaa'])
})

// ─── A draft becoming a real conversation ───────────────

test('the workspace picked before sending survives the chat getting an id', async () => {
  const h = run({ draft: { mode: 'cloud', repoFullName: 'nicoegerer/test1', branch: 'main' } })
  // The harness starts on /c/chat-123, which is what Open WebUI navigates to
  // once the first message creates the conversation.
  await h.settle()

  const stored = JSON.parse(String(h.storage()['desktop:workspace-selection']))
  assert.ok(!stored.draft, 'the draft slot should have been handed over')
  assert.equal(stored['chat-123'].repoFullName, 'nicoegerer/test1')
})

test('a workspace on an intermediate new-chat route follows the sent message', async () => {
  const selected = { mode: 'local', terminalId: 'desktop-ws-test', label: 'test' }
  const h = run({ new: selected }, '/c/new')
  const detached = h.window.fetch as (url: string, init?: unknown) => Promise<unknown>

  await detached('/api/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
  })
  h.navigate('/c/chat-created-after-send')
  await h.settle()

  const stored = JSON.parse(String(h.storage()['desktop:workspace-selection']))
  assert.ok(!stored.new, 'the temporary route must not retain the workspace')
  assert.deepEqual(stored['chat-created-after-send'], selected)
  const keepAlive = h.bridge.filter((c) => c.type === 'workspaceKeepAlive')
  assert.deepEqual(keepAlive.at(-1)?.ids, ['desktop-ws-test'])
})

test('an existing conversation is not overwritten by a leftover draft', async () => {
  const h = run({
    draft: { mode: 'cloud', repoFullName: 'nicoegerer/other', branch: 'main' },
    'chat-123': { mode: 'local', terminalId: 'desktop-ws-aaa', label: 'test1' }
  })
  await h.settle()

  const stored = JSON.parse(String(h.storage()['desktop:workspace-selection']))
  assert.equal(stored['chat-123'].label, 'test1')
})

test('a mounted repository is kept alive like a folder', async () => {
  const h = run({
    'chat-123': {
      mode: 'cloud',
      repoFullName: 'nicoegerer/test1',
      branch: 'main',
      terminalId: 'desktop-gh-abc123def456',
      label: 'nicoegerer/test1'
    }
  })
  await h.settle()

  const keepAlive = h.bridge.filter((c) => c.type === 'workspaceKeepAlive')
  assert.deepEqual(keepAlive[0].ids, ['desktop-gh-abc123def456'])
})
