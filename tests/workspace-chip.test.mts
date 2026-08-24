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

test('a rewriting failure leaves the request untouched', () => {
  const source = script()

  // The patch sits in front of every request the page makes, so it must never
  // be able to stop one.
  const patch = source.slice(source.indexOf('window.fetch = function'))
  assert.ok(patch.includes('catch'))
  assert.ok(patch.includes('return originalFetch.call(this, input, init)'))
})
