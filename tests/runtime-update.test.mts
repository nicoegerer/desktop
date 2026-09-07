import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runtimeUpgradeVersion } from '../src/shared/services/runtime-update.ts'

test('a desktop update upgrades an older backend to its tested version', () => {
  assert.equal(runtimeUpgradeVersion('0.11.1', '0.11.3'), '0.11.3')
  assert.equal(runtimeUpgradeVersion('0.9.9', '0.11.3'), '0.11.3')
})
test('pins, disabled updates, newer and custom runtimes are preserved', () => {
  assert.equal(runtimeUpgradeVersion('0.11.1', '0.11.3', { autoUpdate: false }), undefined)
  assert.equal(runtimeUpgradeVersion('0.11.1', '0.11.3', { version: '0.11.1' }), undefined)
  for (const version of ['0.11.3', '0.11.4', '0.12.0', '1.0.0', '0.12.0.dev1']) {
    assert.equal(runtimeUpgradeVersion(version, '0.11.3'), undefined)
  }
})
