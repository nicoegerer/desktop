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
assert.ok(result.messages[0].content.includes('CURRENT workspace for THIS turn'))
const cloud = apply(
  { messages: [] },
  {
    selection: {
      mode: 'cloud',
      terminalId: 'desktop-gh-check',
      repoFullName: 'example/site',
      branch: 'main'
    },
    alwaysOnToolIds: ['server:garmin']
  }
)
assert.equal(cloud.tool_ids[0], 'server:desktop-workspace-desktop-gh-check')
assert.ok(cloud.messages[0].content.includes('write_file'))
const lifecycleStart = bundle.indexOf('async function resolveWorkspaceKeepIds(')
assert.ok(lifecycleStart >= 0, 'Workspace cleanup resolver must be bundled')
const lifecycleEnd = bundle.indexOf('\n}\n', lifecycleStart) + 2
assert.ok(lifecycleEnd > lifecycleStart)
const keep = new Function('return (' + bundle.slice(lifecycleStart, lifecycleEnd) + ')')()
assert.deepEqual(
  await keep({
    selections: { current: { terminalId: 'selected' }, old: { terminalId: 'old' } },
    currentKey: 'current',
    registeredIds: ['selected', 'old'],
    hasRunningChat: async () => false
  }),
  ['selected']
)
const bridgeStart = bundle.indexOf('function createTerminalStoreBridge(')
assert.ok(bridgeStart >= 0, 'Terminal store bridge must be bundled')
const bridgeEnd = bundle.indexOf('\n}\n', bridgeStart) + 2
assert.ok(bridgeEnd > bridgeStart)
const factory = new Function(`return (${bundle.slice(bridgeStart, bridgeEnd)})`)()
const store = (initial) => ({
  value: initial,
  set(value) {
    this.value = value
  },
  subscribe(run) {
    run(this.value)
    return () => {}
  }
})
const stores = {
  terminalServers: store([]),
  selectedTerminalId: store('old'),
  showFileNavPath: store('old.html'),
  showFileNavDir: store('old.html')
}
const bridge = factory(
  stores,
  async () => ({ ok: true, json: async () => [{ id: 'new' }] }),
  () => ''
)
assert.equal(
  await bridge.select('new', () => true, { path: 'C:/fixture/new', chatId: 'fixture' }),
  true
)
assert.equal(stores.selectedTerminalId.value, 'new')
assert.equal(stores.showFileNavPath.value, null)
assert.equal(stores.showFileNavDir.value, null)
const previewStart = bundle.indexOf('function createWorkspacePreviewTab(')
assert.ok(previewStart >= 0, 'Conditional sidebar preview tab must be shipped')
const previewEnd = bundle.indexOf('\n}\n', previewStart) + 2
assert.ok(previewEnd > previewStart)
const previewFactory = bundle.slice(previewStart, previewEnd)
assert.doesNotThrow(() => new Function(`return (${previewFactory})`))
assert.ok(previewFactory.includes('workspacePreviewInspect'))
assert.ok(previewFactory.includes('workspacePreviewShow'))
assert.ok(previewFactory.includes('panel.files.after(button)'))
console.log(
  'Shipped renderer verified: self-contained rewriter and store bridge, selected filesystem first, stale preview cleared'
)
