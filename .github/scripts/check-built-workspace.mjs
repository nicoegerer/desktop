import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'out/renderer/assets'
const bundle = readdirSync(dir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(join(dir, name), 'utf8'))
  .find((source) => source.includes('function applyWorkspaceToPayload('))
assert.ok(bundle, 'Workspace rewriter must be present in the shipped renderer')
const start = bundle.indexOf('function applyWorkspaceToPayload(')
const end = bundle.indexOf('\n}\n', start) + 2
assert.ok(end > start)
const apply = new Function(`return (${bundle.slice(start, end)})`)()
const result = apply(
  { messages: [], tool_ids: ['server:garmin'] },
  {
    selection: { mode: 'local', terminalId: 'desktop-ws-build-check' },
    alwaysOnToolIds: ['server:garmin']
  }
)
assert.equal(result.tool_ids[0], 'server:desktop-workspace-desktop-ws-build-check')
assert.equal(result.terminal_id, 'desktop-ws-build-check')
assert.ok(result.messages[0].content.includes('write_file'))
console.log('Shipped renderer verified: self-contained rewriter, selected filesystem first')
