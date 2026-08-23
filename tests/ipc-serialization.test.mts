import assert from 'node:assert/strict'
import test from 'node:test'

import { toIpcPlainValue } from '../src/preload/ipc-serialization.ts'

test('managed-service payloads with nested Svelte-like proxies become clone-safe', () => {
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

  assert.throws(() => structuredClone({ action: 'upsert', service }), /clone/i)

  const plain = toIpcPlainValue({ action: 'upsert', service })
  assert.doesNotThrow(() => structuredClone(plain))
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
