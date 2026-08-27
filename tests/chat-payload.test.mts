import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyWorkspaceToPayload,
  CLOUD_INSTRUCTION_MARKER,
  type ChatPayloadPatch
} from '../src/shared/services/chat-payload.ts'

const CONNECTORS = ['server:desktop-garmin', 'server:mcp:desktop-github']

const patch = (overrides: Partial<ChatPayloadPatch> = {}): ChatPayloadPatch => ({
  selection: null,
  alwaysOnToolIds: CONNECTORS,
  ...overrides
})

const userTurn = (): Array<Record<string, string>> => [
  { role: 'user', content: 'was war mein letztes training' }
]

// ─── Connectors are always available ────────────────────

test('connectors are added to a request that selected no tools', () => {
  const out = applyWorkspaceToPayload({ messages: userTurn() }, patch())

  assert.deepEqual(out.tool_ids, CONNECTORS)
})

test('tools the user picked in the chat are kept alongside the connectors', () => {
  const out = applyWorkspaceToPayload(
    { messages: userTurn(), tool_ids: ['my_python_tool'] },
    patch()
  )

  assert.deepEqual(out.tool_ids, ['my_python_tool', ...CONNECTORS])
})

test('a connector already selected is not added twice', () => {
  const out = applyWorkspaceToPayload(
    { messages: userTurn(), tool_ids: ['server:desktop-garmin'] },
    patch()
  )

  assert.deepEqual(out.tool_ids, ['server:desktop-garmin', 'server:mcp:desktop-github'])
})

test('no tool_ids key is invented when there is nothing to add', () => {
  const out = applyWorkspaceToPayload({ messages: userTurn() }, patch({ alwaysOnToolIds: [] }))

  assert.ok(!('tool_ids' in out))
})

// ─── Local workspace ────────────────────────────────────

test('a local workspace sets the terminal for this request', () => {
  const out = applyWorkspaceToPayload(
    { messages: userTurn() },
    patch({ selection: { mode: 'local', terminalId: 'desktop-ws-abc123' } })
  )

  assert.equal(out.terminal_id, 'desktop-ws-abc123')
  assert.ok(
    (out.messages as Array<Record<string, string>>).some((message) =>
      message.content.includes('[desktop-local-workspace]')
    )
  )
})

test('a selected workspace enables terminal capability on the model item', () => {
  const out = applyWorkspaceToPayload(
    {
      messages: userTurn(),
      model_item: { info: { meta: { capabilities: { terminal: false, vision: true } } } }
    },
    patch({ selection: { mode: 'local', terminalId: 'desktop-ws-abc123' } })
  )

  const modelItem = out.model_item as {
    info: { meta: { capabilities: Record<string, boolean> } }
  }
  assert.equal(modelItem.info.meta.capabilities.terminal, true)
  assert.equal(modelItem.info.meta.capabilities.vision, true)
})

test('a local workspace overrides a terminal Open WebUI had selected', () => {
  const out = applyWorkspaceToPayload(
    { messages: userTurn(), terminal_id: 'desktop-ws-other' },
    patch({ selection: { mode: 'local', terminalId: 'desktop-ws-abc123' } })
  )

  assert.equal(out.terminal_id, 'desktop-ws-abc123')
})

// ─── Cloud workspace ────────────────────────────────────

test('a cloud workspace names the repository and keeps its mounted terminal', () => {
  const out = applyWorkspaceToPayload(
    { messages: userTurn(), terminal_id: 'desktop-ws-abc123' },
    patch({
      selection: {
        mode: 'cloud',
        repoFullName: 'nicoegerer/test1',
        branch: 'main',
        terminalId: 'desktop-gh-test1'
      }
    })
  )

  assert.equal(out.terminal_id, 'desktop-gh-test1')
  const messages = out.messages as Array<Record<string, string>>
  assert.equal(messages[0].role, 'system')
  assert.ok(messages[0].content.includes('nicoegerer/test1'))
  assert.ok(messages[0].content.includes('`main`'))
  assert.ok(messages[0].content.includes('mounted repository'))
  assert.equal(messages[1].role, 'user')
})

test('the instruction is placed after the existing system prompt, not before it', () => {
  const out = applyWorkspaceToPayload(
    { messages: [{ role: 'system', content: 'Antworte auf Deutsch.' }, ...userTurn()] },
    patch({
      selection: { mode: 'cloud', repoFullName: 'nicoegerer/test1', branch: 'main' }
    })
  )

  const messages = out.messages as Array<Record<string, string>>
  assert.equal(messages[0].content, 'Antworte auf Deutsch.')
  assert.ok(messages[1].content.includes(CLOUD_INSTRUCTION_MARKER))
  assert.equal(messages[2].role, 'user')
})

test('switching workspace mid-chat does not stack instructions', () => {
  const first = applyWorkspaceToPayload(
    { messages: userTurn() },
    patch({ selection: { mode: 'cloud', repoFullName: 'nicoegerer/test1', branch: 'main' } })
  )
  const second = applyWorkspaceToPayload(
    first,
    patch({ selection: { mode: 'cloud', repoFullName: 'nicoegerer/desktop', branch: 'release' } })
  )

  const messages = second.messages as Array<Record<string, string>>
  const instructions = messages.filter((m) => m.content?.includes(CLOUD_INSTRUCTION_MARKER))
  assert.equal(instructions.length, 1)
  assert.ok(instructions[0].content.includes('nicoegerer/desktop'))
  assert.ok(!instructions[0].content.includes('test1'))
})

test('switching from cloud back to local removes the instruction', () => {
  const cloud = applyWorkspaceToPayload(
    { messages: userTurn() },
    patch({ selection: { mode: 'cloud', repoFullName: 'nicoegerer/test1', branch: 'main' } })
  )
  const local = applyWorkspaceToPayload(
    cloud,
    patch({ selection: { mode: 'local', terminalId: 'desktop-ws-abc123' } })
  )

  const messages = local.messages as Array<Record<string, string>>
  assert.ok(!messages.some((m) => m.content?.includes(CLOUD_INSTRUCTION_MARKER)))
  assert.equal(local.terminal_id, 'desktop-ws-abc123')
})

test('clearing the workspace removes the instruction and leaves the chat intact', () => {
  const cloud = applyWorkspaceToPayload(
    { messages: userTurn() },
    patch({ selection: { mode: 'cloud', repoFullName: 'nicoegerer/test1', branch: 'main' } })
  )
  const cleared = applyWorkspaceToPayload(cloud, patch({ selection: null }))

  assert.deepEqual(cleared.messages, userTurn())
})

// ─── Safety ─────────────────────────────────────────────

test('a request without a workspace is left alone apart from the connectors', () => {
  const body = { messages: userTurn(), model: 'code', stream: true }
  const out = applyWorkspaceToPayload(body, patch())

  assert.equal(out.model, 'code')
  assert.equal(out.stream, true)
  assert.deepEqual(out.messages, userTurn())
})

test('the original body is not mutated', () => {
  const body: Record<string, unknown> = { messages: userTurn(), tool_ids: ['mine'] }
  applyWorkspaceToPayload(body, patch({ selection: { mode: 'local', terminalId: 'x' } }))

  assert.deepEqual(body.tool_ids, ['mine'])
  assert.ok(!('terminal_id' in body))
})

test('a malformed body is returned untouched instead of throwing', () => {
  assert.equal(applyWorkspaceToPayload(null as never, patch()), null)
})

test('the injected source is self-contained so it survives toString injection', () => {
  const source = applyWorkspaceToPayload.toString()

  // The function is shipped into the Open WebUI page as text; a reference to an
  // import or module-scope constant would throw there but not here.
  assert.ok(!/CLOUD_INSTRUCTION_MARKER/.test(source))
  assert.ok(!/\brequire\(/.test(source))
  assert.ok(source.startsWith('function applyWorkspaceToPayload'))
})
