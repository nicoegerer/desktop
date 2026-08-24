import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isBinary,
  listingDir,
  repoPath,
  sliceFile,
  toFileEntries
} from '../src/shared/services/github-contents.ts'

// ─── Paths ──────────────────────────────────────────────

test('the panel’s own listing path is accepted back', () => {
  // The panel echoes the `dir` it was given, which always starts with a slash.
  assert.equal(repoPath('/src/lib'), 'src/lib')
  assert.equal(repoPath('src/lib'), 'src/lib')
})

test('the initial listing of a repository root is empty, not a dot', () => {
  assert.equal(repoPath('.'), '')
  assert.equal(repoPath('/'), '')
  assert.equal(repoPath(''), '')
})

test('a path cannot climb out of the repository', () => {
  assert.equal(repoPath('../../etc/passwd'), 'etc/passwd')
  assert.equal(repoPath('/src/../../../secrets'), 'src/secrets')
})

test('windows separators from the panel are accepted', () => {
  assert.equal(repoPath('src\\lib\\index.ts'), 'src/lib/index.ts')
})

test('the listing path is reported the way the panel will send it back', () => {
  assert.equal(listingDir(''), '/')
  assert.equal(listingDir('src/lib'), '/src/lib')
})

// ─── Entries ────────────────────────────────────────────

const contents = [
  { name: 'README.md', type: 'file', size: 120 },
  { name: 'src', type: 'dir', size: 0 },
  { name: '.gitignore', type: 'file', size: 40 },
  { name: 'docs', type: 'dir', size: 0 }
]

test('directories are listed before files, each alphabetically', () => {
  assert.deepEqual(
    toFileEntries(contents).map((entry) => entry.name),
    ['docs', 'src', '.gitignore', 'README.md']
  )
})

test('a GitHub directory is reported in the panel’s vocabulary', () => {
  const entries = toFileEntries(contents)

  // Open Terminal says "directory"; GitHub says "dir".
  assert.equal(entries[0].type, 'directory')
  assert.equal(entries.find((e) => e.name === 'README.md')?.type, 'file')
  assert.equal(entries.find((e) => e.name === 'README.md')?.size, 120)
})

test('entries carry a modified time even though GitHub sends none', () => {
  // The panel reads the field unconditionally; leaving it out renders "Invalid
  // Date" for every row.
  assert.ok(toFileEntries(contents).every((entry) => entry.modified === 0))
})

test('a file response instead of a listing yields nothing rather than throwing', () => {
  assert.deepEqual(toFileEntries({ name: 'README.md', type: 'file' }), [])
  assert.deepEqual(toFileEntries(null), [])
})

// ─── File contents ──────────────────────────────────────

const file = 'one\ntwo\nthree\n'

test('a whole file is returned unchanged', () => {
  const slice = sliceFile('src/a.txt', file)

  assert.equal(slice.content, file)
  assert.equal(slice.total_lines, 3)
  assert.equal(slice.path, '/src/a.txt')
})

test('a line range keeps its line endings so the text stays intact', () => {
  assert.equal(sliceFile('a.txt', file, 2, 3).content, 'two\nthree\n')
  assert.equal(sliceFile('a.txt', file, 1, 1).content, 'one\n')
})

test('a range beyond the file end simply stops at the end', () => {
  assert.equal(sliceFile('a.txt', file, 3, 99).content, 'three\n')
})

test('a file without a trailing newline is not padded', () => {
  const slice = sliceFile('a.txt', 'only')

  assert.equal(slice.content, 'only')
  assert.equal(slice.total_lines, 1)
})

test('a binary file is recognised so it can be refused', () => {
  assert.equal(isBinary(Buffer.from('plain text')), false)
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])), true)
})
