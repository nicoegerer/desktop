import assert from 'node:assert/strict'
import test from 'node:test'
import { connectorPayload } from '../src/renderer/src/lib/components/Main/Settings/Services/connector-payload.ts'
import type { ManagedServiceDefinition } from '../src/shared/services/types.ts'
import {
  connectorCatalog,
  connectorForService,
  connectorStatus,
  searchConnectors
} from '../src/renderer/src/lib/components/Main/Settings/Services/connector-catalog.ts'

test('Google discovery is explicitly preview setup, not an automatically authorized connection', () => {
  const google = connectorCatalog.filter((entry) => entry.setup === 'google')
  assert.equal(google.length, 3)
  for (const entry of google) {
    assert.equal(entry.preview, true)
    assert.equal(new URL(entry.endpoint!).protocol, 'https:')
    assert.equal(new URL(entry.documentation!).hostname, 'developers.google.com')
  }
})

test('provider association requires an exact trusted host and path, not a substring', () => {
  assert.equal(
    connectorForService({ type: 'remote', remote: { url: 'https://api.githubcopilot.com/mcp' } })
      ?.id,
    'github'
  )
  for (const url of [
    'https://api.githubcopilot.com.evil.test/mcp/',
    'https://evil.test/?x=api.githubcopilot.com/mcp',
    'http://api.githubcopilot.com/mcp/',
    'not a url'
  ]) {
    assert.equal(connectorForService({ type: 'remote', remote: { url } }), undefined)
  }
  assert.equal(connectorForService({ type: 'mcpo' }), undefined)
})

test('discovery search is case insensitive, localized, and has a true empty state', () => {
  assert.equal(searchConnectors(' GMAIL ', true)[0]?.id, 'gmail')
  assert.ok(searchConnectors('installiert', true).some((entry) => entry.id === 'local-mcp'))
  assert.ok(searchConnectors('installed', false).some((entry) => entry.id === 'local-mcp'))
  assert.equal(searchConnectors('no-such-provider', true).length, 0)
  assert.equal(searchConnectors('', true).length, connectorCatalog.length)
})

test('reachability does not falsely claim remote account authorization', () => {
  assert.equal(connectorStatus({ type: 'remote', status: 'running' }, true), 'Erreichbar')
  assert.equal(connectorStatus({ type: 'mcpo', status: 'failed' }, true), 'Prüfung nötig')
  assert.equal(connectorStatus({ type: 'generic', status: 'stopped' }, false), 'Paused')
})

test('editing an existing MCP connector preserves identity, secrets and hidden settings', () => {
  const original: ManagedServiceDefinition = {
    id: 'garmin-existing',
    name: ' Garmin ',
    type: 'mcpo',
    command: 'uvx',
    args: ['mcpo'],
    enabled: true,
    autoRestart: false,
    restartLimit: 7,
    startupTimeoutMs: 180000,
    cwd: 'C:\\Users\\Nico\\tools',
    healthCheckUrl: 'http://127.0.0.1:8000/health',
    apiKey: 'test-secret',
    env: { ACCOUNT: 'kept' },
    mcpo: {
      serverCommand: 'garmin.exe',
      serverArgs: ['--stdio'],
      port: 8000,
      runnerCommand: 'C:\\tools\\uvx.exe'
    }
  }
  const before = structuredClone(original)
  const payload = connectorPayload(original, '--stdio\r\n--safe\n', [
    { key: ' ACCOUNT ', value: 'kept' }
  ])
  assert.equal(payload.id, original.id)
  assert.equal(payload.name, 'Garmin')
  assert.equal(payload.apiKey, original.apiKey)
  assert.equal(payload.cwd, original.cwd)
  assert.equal(payload.healthCheckUrl, original.healthCheckUrl)
  assert.equal(payload.autoRestart, false)
  assert.equal(payload.restartLimit, 7)
  assert.equal(payload.mcpo?.runnerCommand, original.mcpo?.runnerCommand)
  assert.deepEqual(payload.mcpo?.serverArgs, ['--stdio', '--safe'])
  assert.deepEqual(payload.env, { ACCOUNT: 'kept' })
  assert.deepEqual(original, before)
})

test('editing GitHub preserves the access token and disabled state without manufacturing authorization', () => {
  const original: ManagedServiceDefinition = {
    id: 'github-existing',
    name: 'GitHub',
    type: 'remote',
    command: '',
    args: [],
    enabled: false,
    autoRestart: true,
    restartLimit: 3,
    startupTimeoutMs: 120000,
    accessToken: 'test-token',
    remote: { url: ' https://api.githubcopilot.com/mcp/ ' }
  }
  const payload = connectorPayload(original, '', [])
  assert.equal(payload.id, original.id)
  assert.equal(payload.accessToken, 'test-token')
  assert.equal(payload.enabled, false)
  assert.equal(payload.remote?.url, 'https://api.githubcopilot.com/mcp/')
  assert.equal(original.remote?.url, ' https://api.githubcopilot.com/mcp/ ')
})

test('a new MCP connector requests a fresh server-generated key, not a copied key', () => {
  const original: ManagedServiceDefinition = {
    id: '',
    name: 'New',
    type: 'mcpo',
    command: '',
    args: [],
    enabled: true,
    autoRestart: true,
    restartLimit: 3,
    startupTimeoutMs: 120000,
    apiKey: 'must-not-reuse',
    mcpo: { serverCommand: 'server', serverArgs: [], port: 8001 }
  }
  const payload = connectorPayload(original, '', [])
  assert.equal(payload.id, undefined)
  assert.equal(payload.apiKey, '')
  assert.equal(original.apiKey, 'must-not-reuse')
})
