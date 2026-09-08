import assert from 'node:assert/strict'
import test from 'node:test'
import { patchWorkspaceFileNav } from '../src/main/services/workspace-frontend.ts'

const sourceMap = {
  sources: ['../../src/lib/components/chat/FileNav.svelte'],
  sourcesContent: ["const useServerPath = !!chatId || savedPath === '/';"],
  names: ['useServerPath'],
  mappings: 'AAAAA'
}

test('new and existing chats always initialize FileNav from the selected terminal cwd', () => {
  const original = 'us=!!D()||Un==="/",next=1;'
  const patched = patchWorkspaceFileNav(original, sourceMap)!
  assert.equal(patched.length, original.length, 'Source-map columns must not shift')
  const useServerPath = new Function('D', 'Un', 'let us,next; ' + patched + ' return us;')
  assert.equal(
    useServerPath(() => null, 'C:/first-workspace'),
    true
  )
  assert.equal(
    useServerPath(() => 'existing-chat', 'C:/first-workspace'),
    true
  )
  assert.equal(patchWorkspaceFileNav(patched, sourceMap), patched, 'Idempotent across app starts')
})

test('unrelated assets remain untouched and changed upstream contracts fail explicitly', () => {
  assert.equal(patchWorkspaceFileNav('anything', { ...sourceMap, sources: ['unrelated.ts'] }), null)
  assert.throws(() => patchWorkspaceFileNav('us=someNewLogic;', sourceMap), /not found/)
  assert.throws(() => patchWorkspaceFileNav('us=!!secret,done=1;', sourceMap), /changed/)
  assert.throws(
    () => patchWorkspaceFileNav('us=true;', { ...sourceMap, sourcesContent: ['new source'] }),
    /changed/
  )
})
