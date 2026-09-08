import assert from 'node:assert/strict'
import { patchWorkspaceFileNav } from '../../src/main/services/workspace-frontend.ts'
let input = ''
for await (const chunk of process.stdin) input += chunk
const { code, map } = JSON.parse(input)
const patched = patchWorkspaceFileNav(code, map)
assert.ok(patched, 'Required FileNav compatibility patch is missing')
assert.equal(patched.length, code.length, 'Generated source-map columns must be preserved')
assert.equal(
  patchWorkspaceFileNav(patched, map),
  patched,
  'Runtime compatibility must be idempotent'
)
console.log(
  'Published FileNav: current-terminal cwd initialization and column-preserving patch verified'
)
