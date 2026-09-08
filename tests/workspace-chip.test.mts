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
  assert.ok(!/\bchat_payload_1\b/.test(source))
})

test('workspace switching never reloads the embedded page', () => {
  assert.ok(!script().includes('location.reload'))
})

test('website preview is tied to the current local selection and invalidated before switching', () => {
  const source = script()
  assert.ok(source.includes("ask('workspacePreviewShow', data)"))
  assert.ok(source.includes("value.mode === 'local'"))
  assert.ok(source.includes('reportPreviewState(true);'))
  assert.ok(source.includes("ask('workspacePreviewState', data)"))
  assert.ok(source.includes("ask('workspacePreviewInspect'"))
  assert.ok(source.includes('panel.files.after(button)'))
  assert.ok(!source.includes('row.appendChild(previewButton)'))
  assert.ok(!source.includes('bridge.hideFiles()'))
})

test('the terminal control has no positional, CSS-class, or SVG heuristic', () => {
  const source = script()

  assert.ok(source.includes("semanticName !== 'Terminal'"))
  assert.ok(!source.includes('nearestGap'))
  assert.ok(!source.includes('getBoundingClientRect();\n      var gap'))
  assert.ok(!source.includes("querySelector('svg')"))
  assert.ok(!source.includes("cls.indexOf('translate-y"))
})

test('the cloud icon appears on the selected chip, not on repository rows', () => {
  const source = script()

  assert.ok(source.includes('results.appendChild(button(r.fullName'))
  assert.ok(
    source.includes(
      "var icon = s && s.mode === 'cloud' ? ICON_CLOUD : s ? ICON_FOLDER : ICON_EMPTY"
    )
  )
  assert.ok(source.includes("}, !!s && s.mode === 'cloud' && s.repoFullName === r.fullName));"))
})

test('system workspaces use the authenticated Open WebUI terminal proxy', () => {
  const source = script()

  assert.ok(source.includes("url: '/api/v1/terminals/' + encodeURIComponent(terminal.id)"))
  assert.ok(source.includes('direct.concat(proxiedSystemTerminals)'))
  assert.ok(!source.includes('direct.concat(systemTerminals)'))
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
  selectedTerminalId: () => string | null
  nativeClicks: () => { terminal: number; tools: number; integrations: number; globe: number }
  changeWorkspace: (load: () => Promise<unknown>) => Promise<boolean>
  toolsCounterHidden: () => boolean
  terminalHidden: () => boolean
}

const run = (
  seed?: Record<string, unknown>,
  initialPath = '/c/chat-123',
  ensureResult?: Record<string, unknown>,
  options: {
    select?: (id: string | null, current: () => boolean) => Promise<boolean>
    fetch?: (url: unknown, init: unknown) => Promise<unknown>
    counterCount?: number
    terminalDisabled?: boolean
  } = {}
): Harness => {
  const calls: Array<{ url: string; body: unknown }> = []
  const bridge: Array<Record<string, unknown>> = []
  const store: Record<string, string> = {}
  if (seed) store['desktop:workspace-selection'] = JSON.stringify(seed)
  let frames: Array<() => void> = []
  let observerCallback: (() => void) | null = null
  let renders = 0
  let selectedTerminalId: string | null = null
  let changeWorkspace!: Harness['changeWorkspace']
  let toolsCounterHidden = false
  const nativeClicks = { terminal: 0, tools: 0, integrations: 0, globe: 0 }
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
    const attributes: Record<string, string> = {}
    const node: Record<string, unknown> = {
      style: { cssText: '', opacity: '', background: '' },
      dataset: {},
      title: '',
      isConnected: true,
      children: [] as unknown[],
      classList: {
        toggle: (name: string, value: boolean) => {
          if (name === 'desktop-hide-tool-count') toolsCounterHidden = value
        },
        add: () => {},
        remove: () => {}
      },
      getAttribute: (name: string) => attributes[name] ?? null,
      setAttribute: (name: string, value: string) => {
        attributes[name] = value
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
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      click: () => {}
    }
    // Elements the script injects must be findable afterwards, or a
    // create-if-missing helper would recreate them on every pass and the test
    // would blame the script for the stub's forgetfulness.
    Object.defineProperty(node, 'id', {
      get: () => attributes.id ?? '',
      set: (value: string) => {
        attributes.id = value
        byId.set(value, node)
      }
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
  const tools = element()
  const globe = element()
  const terminal = element()
  const terminalTooltip = element()
  const terminalTrigger = element()
  anchor.id = 'input-menu-button'
  other.id = 'integration-menu-button'
  tools.setAttribute('aria-label', 'Available Tools')
  tools.textContent = String(options.counterCount ?? 0)
  globe.setAttribute('aria-label', 'Web Search')
  if (!options.terminalDisabled) {
    terminalTrigger.setAttribute('role', 'button')
    terminalTrigger.setAttribute('aria-haspopup', 'true')
  } else {
    terminal.setAttribute('disabled', '')
    terminal.setAttribute('aria-disabled', 'true')
  }
  terminal.parentElement = terminalTooltip
  terminalTooltip.parentElement = terminalTrigger
  terminalTooltip._tippy = { props: { content: 'Terminal' } }
  terminalTrigger.parentElement = row
  terminal.click = () => nativeClicks.terminal++
  tools.click = () => nativeClicks.tools++
  other.click = () => nativeClicks.integrations++
  globe.click = () => nativeClicks.globe++
  anchor.parentElement = row
  other.parentElement = row
  tools.parentElement = row
  globe.parentElement = row
  row.contains = (node: unknown) =>
    node === other || node === anchor || node === tools || node === globe || node === terminal
  row.querySelectorAll = (selector: string) =>
    selector === 'button[type="button"]' ? [anchor, other, tools, globe, terminal] : []
  ;(row as Record<string, unknown>).parentElement = null

  const pageLocation = { pathname: initialPath }
  const win: Record<string, unknown> = {
    fetch: (url: unknown, init: unknown) => {
      // Mirrors the browser: the real fetch is bound to window and throws when
      // invoked with any other receiver.
      calls.push({ url: String(url), body: (init as { body?: string })?.body })
      if (options.fetch) return options.fetch(url, init)
      return Promise.resolve({ ok: true })
    },
    addEventListener: () => {},
    __openWebUIDesktopTerminalBridge: {
      select: async (terminalId: string | null, current: () => boolean = () => true) => {
        if (options.select && !(await options.select(terminalId, current))) return false
        if (!current()) return false
        selectedTerminalId = terminalId
        return true
      }
    },
    electronAPI: {
      send: (data: Record<string, unknown>) => {
        bridge.push(data)
        if ((data.type === 'workspaceEnsure' || data.type === 'workspaceMountRepo') && ensureResult)
          return Promise.resolve(ensureResult)
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
      observe(): void {
        /* The fixture drives mutation delivery explicitly. */
      }
      disconnect(): void {
        /* No browser observer is allocated by the fixture. */
      }
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
    querySelector: (selector: string) =>
      selector === 'button[aria-label="Available Tools"]' ? tools : null,
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
    'captureChangeWorkspace',
    script().replace(
      'var select = function (value)',
      'captureChangeWorkspace(changeWorkspace); var select = function (value)'
    )
  )
  fn(
    win,
    doc,
    win.localStorage,
    win.location,
    win.console,
    win.MutationObserver,
    win.requestAnimationFrame,
    (change: Harness['changeWorkspace']) => {
      changeWorkspace = change
    }
  )

  return {
    window: win,
    calls,
    bridge,
    changeWorkspace: (load) => changeWorkspace(load),
    toolsCounterHidden: () => toolsCounterHidden,
    terminalHidden: () => terminal.getAttribute('data-desktop-terminal-menu') === '1',
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
    renderCount: () => renders,
    selectedTerminalId: () => selectedTerminalId,
    nativeClicks: () => ({ ...nativeClicks })
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
  assert.equal(h.selectedTerminalId(), 'desktop-ws-test')
})

test('the workspace bridge never clicks tools, integrations, globe, or the native terminal menu', async () => {
  const h = run({
    'chat-123': { mode: 'local', terminalId: 'desktop-ws-test', label: 'test' }
  })
  const detached = h.window.fetch as (url: string, init?: unknown) => Promise<unknown>

  await detached('/api/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'inspect workspace' }] })
  })

  assert.deepEqual(h.nativeClicks(), { terminal: 0, tools: 0, integrations: 0, globe: 0 })
})

test('a workspace change cannot open the available-tools dialog', async () => {
  const h = run({
    'chat-123': { mode: 'cloud', terminalId: 'desktop-gh-test', label: 'repo' }
  })
  await h.settle()

  assert.equal(h.nativeClicks().tools, 0)
})

test('the technical terminal cloud is hidden both idle and while generation disables its dropdown', async () => {
  for (const terminalDisabled of [false, true]) {
    const h = run(
      { 'chat-123': { mode: 'local', terminalId: 'desktop-ws-test', label: 'test' } },
      '/c/chat-123',
      undefined,
      { terminalDisabled }
    )
    await h.settle()
    assert.equal(h.terminalHidden(), true)
    assert.deepEqual(h.nativeClicks(), { terminal: 0, tools: 0, integrations: 0, globe: 0 })
  }
})

test('a saved local workspace is restored before the chat request is sent', async () => {
  const h = run(
    { 'chat-123': { mode: 'local', terminalId: 'desktop-ws-old', label: 'test' } },
    '/c/chat-123',
    {
      ok: true,
      path: 'C:\\work\\test',
      terminal: { id: 'desktop-ws-restored', name: 'test' }
    }
  )
  const detached = h.window.fetch as (url: string, init?: unknown) => Promise<unknown>

  await detached('/api/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'first' }] })
  })
  await detached('/api/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'second' }] })
  })

  assert.equal(JSON.parse(String(h.calls[0].body)).terminal_id, 'desktop-ws-restored')
  assert.equal(JSON.parse(String(h.calls[1].body)).terminal_id, 'desktop-ws-restored')
  assert.equal(h.selectedTerminalId(), 'desktop-ws-restored')
  assert.equal(h.bridge.filter((call) => call.type === 'workspaceEnsure').length, 1)
})

test('a saved cloud workspace is remounted before the chat request is sent', async () => {
  const h = run(
    {
      'chat-123': {
        mode: 'cloud',
        repoFullName: 'nicoegerer/test1',
        branch: 'main',
        terminalId: 'desktop-gh-old',
        label: 'nicoegerer/test1'
      }
    },
    '/c/chat-123',
    { ok: true, terminal: { id: 'desktop-gh-restored', name: 'nicoegerer/test1' } }
  )
  const detached = h.window.fetch as (url: string, init?: unknown) => Promise<unknown>

  await detached('/api/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'inspect repository' }] })
  })

  assert.equal(JSON.parse(String(h.calls[0].body)).terminal_id, 'desktop-gh-restored')
  assert.equal(h.selectedTerminalId(), 'desktop-gh-restored')
  assert.notEqual(h.selectedTerminalId(), 'desktop-ws-desktop')
  const mounts = h.bridge.filter((call) => call.type === 'workspaceMountRepo')
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].repoFullName, 'nicoegerer/test1')
  assert.equal(mounts[0].branch, 'main')
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
  const h = run({
    draft: {
      mode: 'cloud',
      repoFullName: 'nicoegerer/test1',
      branch: 'main',
      terminalId: 'desktop-gh-draft'
    }
  })
  // The harness starts on /c/chat-123, which is what Open WebUI navigates to
  // once the first message creates the conversation.
  await h.settle()

  const stored = JSON.parse(String(h.storage()['desktop:workspace-selection']))
  assert.ok(!stored.draft, 'the draft slot should have been handed over')
  assert.equal(stored['chat-123'].repoFullName, 'nicoegerer/test1')
  assert.equal(h.selectedTerminalId(), 'desktop-gh-draft')
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

// Exercise the real changeWorkspace closure without opening a native picker.
const workspace = (name: string): Record<string, string> => ({
  mode: 'local',
  terminalId: 'desktop-ws-' + name,
  path: 'C:/work/' + name,
  label: name
})
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const send = (
  h: Harness,
  messages: unknown[] = [{ role: 'user', content: 'create a file' }]
): Promise<Response> =>
  (h.window.fetch as typeof fetch)('/api/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages })
  })

test('test to whitemode in the SAME chat updates both the payload and composer', async () => {
  const h = run({ 'chat-123': workspace('test') })
  await send(h)
  assert.equal(await h.changeWorkspace(async () => workspace('whitemode')), true)
  await send(h, [
    { role: 'assistant', content: 'Created C:/work/test/dark.html' },
    { role: 'user', content: 'Create a light variant' }
  ])
  const payload = JSON.parse(String(h.calls.at(-1)?.body))
  assert.equal(payload.terminal_id, 'desktop-ws-whitemode')
  assert.equal(payload.tool_ids[0], 'server:desktop-workspace-desktop-ws-whitemode')
  assert.ok(!payload.tool_ids.includes('server:desktop-workspace-desktop-ws-test'))
  assert.ok(payload.messages[0].content.includes('C:/work/whitemode'))
  assert.ok(payload.messages[0].content.includes('earlier output paths as history'))
  assert.equal(h.selectedTerminalId(), 'desktop-ws-whitemode')
  assert.equal(
    JSON.parse(h.storage()['desktop:workspace-selection'])['chat-123'].label,
    'whitemode'
  )
})

test('sending while the new folder starts waits instead of using the previous folder', async () => {
  const h = run({ 'chat-123': workspace('test') })
  await h.settle()
  const ready = deferred<unknown>()
  const change = h.changeWorkspace(() => ready.promise)
  const request = send(h)
  await h.settle()
  assert.equal(h.calls.length, 0)
  ready.resolve(workspace('whitemode'))
  assert.equal(await change, true)
  await request
  assert.equal(JSON.parse(String(h.calls[0].body)).terminal_id, 'desktop-ws-whitemode')
})

test('a delayed old request cannot revert a manual folder switch', async () => {
  const delayed = deferred<boolean>()
  let blockOld = false
  const h = run({ 'chat-123': workspace('test') }, '/c/chat-123', undefined, {
    select: (id) => (blockOld && id === 'desktop-ws-test' ? delayed.promise : Promise.resolve(true))
  })
  await h.settle()
  blockOld = true
  const rejected = assert.rejects(send(h), /workspace changed/)
  await h.settle()
  assert.equal(await h.changeWorkspace(async () => workspace('whitemode')), true)
  delayed.resolve(true)
  await rejected
  await h.settle()
  assert.equal(h.selectedTerminalId(), 'desktop-ws-whitemode')
  assert.equal(
    JSON.parse(h.storage()['desktop:workspace-selection'])['chat-123'].label,
    'whitemode'
  )
  assert.equal(h.calls.length, 0, 'do not dispatch with a superseded workspace')
})

test('navigation during folder activation cannot save the old choice into another chat', async () => {
  const h = run({ 'chat-123': workspace('test'), 'chat-other': workspace('other') })
  await h.settle()
  const ready = deferred<unknown>()
  const changing = h.changeWorkspace(() => ready.promise)
  h.navigate('/c/chat-other')
  await h.settle()
  ready.resolve(workspace('whitemode'))
  assert.equal(await changing, false)
  await h.settle()
  const saved = JSON.parse(h.storage()['desktop:workspace-selection'])
  assert.equal(saved['chat-123'].label, 'test')
  assert.equal(saved['chat-other'].label, 'other')
  assert.equal(h.selectedTerminalId(), 'desktop-ws-other')
})

test('sending in an existing chat and navigating does not transfer or delete its selection', async () => {
  const h = run({ 'chat-123': workspace('test') })
  await send(h)
  h.navigate('/c/existing-without-workspace')
  await h.settle()
  const saved = JSON.parse(h.storage()['desktop:workspace-selection'])
  assert.equal(saved['chat-123'].label, 'test')
  assert.equal(saved['existing-without-workspace'], undefined)
})

const toolCatalog = [
  { id: 'server:desktop-garmin', name: 'Garmin' },
  { id: 'server:mcp:desktop-github-mcp', name: 'GitHub MCP' },
  { id: 'server:desktop-workspace-desktop-ws-old', name: 'Open Terminal · old' },
  { id: 'custom', name: 'My optional tool' }
]

test('chat tool catalog hides automatic connectors but keeps custom tools and actual access', async () => {
  const h = run(undefined, '/c/chat-123', undefined, {
    fetch: async () => Response.json(toolCatalog)
  })
  const response = await (h.window.fetch as typeof fetch)('/api/v1/tools/?')
  assert.deepEqual(await response.json(), [toolCatalog[3]])
  await send(h)
  assert.deepEqual(JSON.parse(String(h.calls.at(-1)?.body)).tool_ids, [
    'server:desktop-garmin',
    'server:mcp:desktop-github-mcp'
  ])
})

test('tool search is filtered too, without hiding a custom tool that happens to be named Garmin', async () => {
  const own = { id: 'custom-garmin', name: 'Garmin' }
  const h = run(undefined, '/', undefined, {
    fetch: async () => Response.json([...toolCatalog, own])
  })
  const response = await (h.window.fetch as typeof fetch)('/api/v1/tools/?query=Garmin')
  assert.deepEqual(await response.json(), [toolCatalog[3], own])
})

test('tool management and non-catalog requests remain untouched', async () => {
  const h = run(undefined, '/workspace/tools', undefined, {
    fetch: async () => Response.json(toolCatalog)
  })
  assert.deepEqual(
    await (await (h.window.fetch as typeof fetch)('/api/v1/tools/')).json(),
    toolCatalog
  )
  h.navigate('/c/chat-123')
  assert.deepEqual(
    await (await (h.window.fetch as typeof fetch)('/api/v1/tools/list')).json(),
    toolCatalog
  )
  assert.deepEqual(
    await (await (h.window.fetch as typeof fetch)('/api/v1/tools/', { method: 'POST' })).json(),
    toolCatalog
  )
})

test('a directly connected optional tool keeps its counter visible even with no catalog tools', async () => {
  const h = run(undefined, '/', undefined, {
    fetch: async () => Response.json([toolCatalog[0]]),
    counterCount: 1
  })
  await (h.window.fetch as typeof fetch)('/api/v1/tools/?')
  await h.settle()
  assert.equal(h.toolsCounterHidden(), false)
})

test('an empty optional catalog hides the counter for automatically active tools', async () => {
  const h = run(undefined, '/', undefined, {
    fetch: async () => Response.json([toolCatalog[0]]),
    counterCount: 0
  })
  await (h.window.fetch as typeof fetch)('/api/v1/tools/?')
  await h.settle()
  assert.equal(h.toolsCounterHidden(), true)
})
