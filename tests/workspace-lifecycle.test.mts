import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveWorkspaceKeepIds,
  canReleaseWorkspaceTerminal
} from '../src/shared/services/workspace-lifecycle.ts'

test('retain the selection, pending switch and request leases, release only idle historic workspaces', async () => {
  const selections = {
    current: { terminalId: 'current' },
    old: { terminalId: 'old' },
    running: { terminalId: 'running' },
    unknown: { terminalId: 'unknown' },
    draft: { terminalId: 'stale-draft' },
    unregistered: { terminalId: 'not-running' }
  }
  const before = structuredClone(selections)
  const queried: string[] = []
  const keep = await resolveWorkspaceKeepIds({
    selections,
    currentKey: 'current',
    extraId: 'pending',
    leasedIds: ['leased'],
    registeredIds: ['current', 'old', 'running', 'unknown', 'stale-draft'],
    hasRunningChat: async (chat) => {
      queried.push(chat)
      return chat === 'unknown' ? null : chat === 'running'
    }
  })
  assert.deepEqual(new Set(keep), new Set(['current', 'pending', 'leased', 'running', 'unknown']))
  assert.deepEqual(queried, ['old', 'running', 'unknown'])
  assert.deepEqual(selections, before, 'selection persists for reopening an old chat')
})

test('one active chat keeps a shared workspace; failed status inspection is conservative', async () => {
  const keep = await resolveWorkspaceKeepIds({
    selections: {
      idle: { terminalId: 'shared' },
      active: { terminalId: 'shared' },
      failed: { terminalId: 'failed' }
    },
    currentKey: 'draft',
    registeredIds: ['shared', 'failed'],
    hasRunningChat: async (id) => {
      if (id === 'failed') throw Error('offline')
      return id === 'active'
    }
  })
  assert.deepEqual(new Set(keep), new Set(['shared', 'failed']))
})

test('switching a chat during a long answer preserves that answer original workspace until it finishes', async () => {
  const options = {
    selections: { chat: { terminalId: 'new-folder' } },
    currentKey: 'chat',
    registeredIds: ['new-folder', 'old-folder'],
    requests: [{ chatId: 'chat', terminalId: 'old-folder' }]
  }
  assert.deepEqual(
    new Set(await resolveWorkspaceKeepIds({ ...options, hasRunningChat: async () => true })),
    new Set(['old-folder', 'new-folder'])
  )
  assert.deepEqual(
    await resolveWorkspaceKeepIds({ ...options, hasRunningChat: async () => false }),
    ['new-folder']
  )
  assert.deepEqual(
    new Set(
      await resolveWorkspaceKeepIds({
        ...options,
        requests: [{ chatId: 'draft', terminalId: 'old-folder' }],
        hasRunningChat: async () => false
      })
    ),
    new Set(['old-folder', 'new-folder'])
  )
})

test('large chat histories have a bounded status lookup and retain uninspected workspaces', async () => {
  let calls = 0
  const selections = Object.fromEntries(
    Array.from({ length: 50 }, (_, n) => ['chat' + n, { terminalId: 'ws' + n }])
  )
  const keep = await resolveWorkspaceKeepIds({
    selections,
    currentKey: 'draft',
    registeredIds: Object.values(selections).map((x) => x.terminalId),
    hasRunningChat: async () => {
      calls++
      return false
    }
  })
  assert.equal(calls, 40)
  assert.equal(keep.length, 10)
})

test('keep resolver survives injection without module bindings', async () => {
  const injected = new Function('return (' + resolveWorkspaceKeepIds.toString() + ')')()
  assert.deepEqual(
    await injected({
      selections: {},
      currentKey: 'draft',
      registeredIds: [],
      hasRunningChat: async () => false
    }),
    []
  )
})

test('only proven idle terminals can be released; live PTYs, commands and unknown responses remain', async () => {
  for (const [commands, terminals, expected] of [
    [[], [], true],
    [[{ status: 'done' }, { status: 'killed' }], [], true],
    [[{ status: 'running' }], [], false],
    [[], [{ id: 'live-pty', pid: 123 }], false],
    [[{ status: 'unknown' }], [], false],
    [{ processes: [] }, [], false],
    [[], null, false]
  ] as const) {
    assert.equal(
      await canReleaseWorkspaceTerminal(async (path) =>
        Response.json(path === '/execute' ? commands : terminals)
      ),
      expected
    )
  }
  assert.equal(
    await canReleaseWorkspaceTerminal(async () => Response.json({}, { status: 503 })),
    false
  )
  assert.equal(
    await canReleaseWorkspaceTerminal(async () => {
      throw Error('offline')
    }),
    false
  )
})
