import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DESKTOP_TOOL_PREFIX,
  mergeToolServers,
  type ToolServerConnection
} from '../src/shared/services/tool-servers.ts'
import type { ManagedServiceToolTarget } from '../src/shared/services/types.ts'

const target = (
  overrides: Partial<ManagedServiceToolTarget> & Pick<ManagedServiceToolTarget, 'id'>
): ManagedServiceToolTarget => ({
  name: overrides.id,
  kind: 'openapi',
  url: 'http://127.0.0.1:8000',
  path: 'openapi.json',
  key: 'key-1',
  enabled: true,
  ready: true,
  ...overrides
})

const handAdded: ToolServerConnection = {
  type: 'openapi',
  url: 'https://tools.example.com',
  path: 'openapi.json',
  auth_type: 'bearer',
  key: 'user-key',
  config: { enable: true, function_name_filter_list: '', access_grants: [] },
  info: { id: 'my-own-server', name: 'Hand added' }
}

test('a new connector is appended as an Open WebUI tool server', () => {
  const merged = mergeToolServers([], [target({ id: 'garmin' })])

  assert.equal(merged.length, 1)
  assert.equal(merged[0].info?.id, `${DESKTOP_TOOL_PREFIX}garmin`)
  assert.equal(merged[0].type, 'openapi')
  assert.equal(merged[0].path, 'openapi.json')
  assert.equal(merged[0].auth_type, 'bearer')
  assert.equal(merged[0].config?.enable, true)
})

test('connections added by hand in Open WebUI survive a sync', () => {
  const merged = mergeToolServers([handAdded], [target({ id: 'garmin' })])

  assert.deepEqual(merged[0], handAdded)
  assert.equal(merged[1].info?.id, `${DESKTOP_TOOL_PREFIX}garmin`)
})

test('a rotated bearer key replaces the stored one', () => {
  const existing = mergeToolServers([], [target({ id: 'garmin', key: 'old-key' })])
  const merged = mergeToolServers(existing, [target({ id: 'garmin', key: 'new-key' })])

  assert.equal(merged.length, 1)
  assert.equal(merged[0].key, 'new-key')
})

test('user-side filters and access grants are preserved across a sync', () => {
  const existing = mergeToolServers([], [target({ id: 'garmin' })])
  existing[0].config!.function_name_filter_list = 'get_sleep_data'
  existing[0].config!.access_grants = [{ id: 'group-1' }]
  existing[0].info!.description = 'Sleep only'

  const merged = mergeToolServers(existing, [target({ id: 'garmin', name: 'Garmin renamed' })])

  assert.equal(merged[0].config?.function_name_filter_list, 'get_sleep_data')
  assert.deepEqual(merged[0].config?.access_grants, [{ id: 'group-1' }])
  assert.equal(merged[0].info?.description, 'Sleep only')
  assert.equal(merged[0].info?.name, 'Garmin renamed')
})

test('a disabled connector keeps its entry but stops being enabled', () => {
  const existing = mergeToolServers([], [target({ id: 'garmin' })])
  const merged = mergeToolServers(existing, [target({ id: 'garmin', enabled: false })])

  assert.equal(merged.length, 1)
  assert.equal(merged[0].config?.enable, false)
})

test('a connector removed from the registry is removed from Open WebUI', () => {
  const existing = mergeToolServers([handAdded], [target({ id: 'garmin' })])
  const merged = mergeToolServers(existing, [])

  assert.deepEqual(merged, [handAdded])
})

test('a remote endpoint is registered as an MCP server without an OpenAPI path', () => {
  const merged = mergeToolServers(
    [],
    [
      target({
        id: 'github-mcp',
        kind: 'mcp',
        url: 'https://api.githubcopilot.com/mcp/',
        path: '',
        key: 'ghp_token'
      })
    ]
  )

  assert.equal(merged[0].type, 'mcp')
  assert.equal(merged[0].url, 'https://api.githubcopilot.com/mcp/')
  assert.equal(merged[0].path, '')
  assert.equal(merged[0].auth_type, 'bearer')
})

test('a remote endpoint without a token is registered without authentication', () => {
  const merged = mergeToolServers(
    [],
    [target({ id: 'open-tools', kind: 'mcp', path: '', key: '' })]
  )

  assert.equal(merged[0].auth_type, 'none')
  assert.equal(merged[0].key, '')
})

test('an unchanged registry produces a byte-identical list so no write happens', () => {
  const targets = [target({ id: 'garmin' }), target({ id: 'github-mcp', kind: 'mcp', path: '' })]
  const first = mergeToolServers([handAdded], targets)
  const second = mergeToolServers(first, targets)

  assert.equal(JSON.stringify(first), JSON.stringify(second))
})
