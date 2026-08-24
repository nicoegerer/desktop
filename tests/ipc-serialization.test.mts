import assert from 'node:assert/strict'
import test from 'node:test'

import { toIpcPlainValue } from '../src/shared/services/ipc-serialization.ts'

test('managed-service payloads become clone-safe before crossing contextBridge', () => {
  const restartPolicy = new Proxy({ limit: 3, timeoutMs: 120_000 }, {})
  const service = new Proxy(
    {
      name: 'Garmin MCP',
      type: 'mcpo',
      mcpo: new Proxy({ runnerCommand: 'uvx', port: 8000 }, {}),
      restartPolicy
    },
    {}
  )

  const crossContextBridge = (value: unknown): unknown => structuredClone(value)

  assert.throws(() => crossContextBridge({ action: 'upsert', service }), /clone/i)

  const plain = toIpcPlainValue({ action: 'upsert', service })
  assert.doesNotThrow(() => crossContextBridge(plain))
  assert.deepEqual(plain, {
    action: 'upsert',
    service: {
      name: 'Garmin MCP',
      type: 'mcpo',
      mcpo: { runnerCommand: 'uvx', port: 8000 },
      restartPolicy: { limit: 3, timeoutMs: 120_000 }
    }
  })
})
