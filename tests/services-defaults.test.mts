import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  migrateOmniRouteDefaults,
  OMNIROUTE_HEALTH_CHECK_URL,
  OMNIROUTE_STARTUP_TIMEOUT_MS
} from '../src/shared/services/omniroute-defaults.ts'

test('OmniRoute uses a lightweight readiness endpoint and a cold-start-safe timeout', () => {
  assert.equal(OMNIROUTE_HEALTH_CHECK_URL, 'http://127.0.0.1:20128/api/health/ping')
  assert.equal(OMNIROUTE_STARTUP_TIMEOUT_MS, 300_000)
})

test('persisted OmniRoute defaults are upgraded without changing other settings', () => {
  const persisted = {
    id: 'omniroute',
    enabled: false,
    healthCheckUrl: 'http://127.0.0.1:20128/api/monitoring/health',
    startupTimeoutMs: 120_000
  }

  const migrated = migrateOmniRouteDefaults(persisted)

  assert.equal(migrated.enabled, false)
  assert.equal(migrated.healthCheckUrl, OMNIROUTE_HEALTH_CHECK_URL)
  assert.equal(migrated.startupTimeoutMs, OMNIROUTE_STARTUP_TIMEOUT_MS)
})

test('a custom OmniRoute health URL is preserved while unsafe timeouts are raised', () => {
  const migrated = migrateOmniRouteDefaults({
    id: 'omniroute',
    healthCheckUrl: 'http://127.0.0.1:30128/ready',
    startupTimeoutMs: 45_000
  })

  assert.equal(migrated.healthCheckUrl, 'http://127.0.0.1:30128/ready')
  assert.equal(migrated.startupTimeoutMs, OMNIROUTE_STARTUP_TIMEOUT_MS)
})

test('non-OmniRoute services are not modified', () => {
  const service = {
    id: 'custom',
    healthCheckUrl: 'http://127.0.0.1:9000/health',
    startupTimeoutMs: 30_000
  }

  assert.equal(migrateOmniRouteDefaults(service), service)
})
