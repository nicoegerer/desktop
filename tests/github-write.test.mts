import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  GithubWorkspaceWriter,
  githubFilePath,
  type GithubRequest
} from '../src/shared/services/github-write.ts'

const scope = { repoFullName: 'example/site', branch: 'feature/website' }
const oldSha = '1'.repeat(40)
const commitSha = '2'.repeat(40)
const json = (body: unknown, status = 200): Response => Response.json(body, { status })
const file = (content: string) => ({
  type: 'file',
  sha: oldSha,
  encoding: 'base64',
  content: Buffer.from(content).toString('base64')
})
const scripted = (responses: Response[]) => {
  const calls: { path: string; init?: RequestInit }[] = []
  const request: GithubRequest = async (path, init) => {
    calls.push({ path, init })
    assert.ok(responses.length, 'unexpected extra request')
    return responses.shift()!
  }
  return { writer: new GithubWorkspaceWriter(request), calls }
}

test('create a UTF-8 cloud file on exactly the selected branch and verify its commit', async () => {
  const content = '<h1>Grüße ☀</h1>'
  const h = scripted([
    json({}, 404),
    json({ commit: { sha: commitSha } }, 201),
    json(file(content))
  ])
  const result = await h.writer.write(scope, { path: '/web/site #1?.html', content })
  assert.equal(
    h.calls[0].path,
    '/repos/example/site/contents/web/site%20%231%3F.html?ref=feature%2Fwebsite'
  )
  assert.deepEqual(JSON.parse(String(h.calls[1].init?.body)), {
    message: 'Update web/site #1?.html via Open WebUI',
    content: Buffer.from(content).toString('base64'),
    branch: scope.branch
  })
  assert.equal(h.calls[1].init?.method, 'PUT')
  assert.equal(
    h.calls[2].path,
    '/repos/example/site/contents/web/site%20%231%3F.html?ref=' + commitSha
  )
  assert.deepEqual(result, {
    path: '/web/site #1?.html',
    size: Buffer.byteLength(content),
    repository: scope.repoFullName,
    branch: scope.branch,
    commit_sha: commitSha,
    verified: true
  })
  assert.equal(h.writer.isBusy(scope), false)
})

test('updates carry the freshly read blob SHA, and an empty file is valid', async () => {
  const h = scripted([json(file('old')), json({ commit: { sha: commitSha } }), json(file(''))])
  await h.writer.write(scope, { path: 'empty.txt', content: '', message: ' Clear text ' })
  const body = JSON.parse(String(h.calls[1].init?.body))
  assert.equal(body.sha, oldSha)
  assert.equal(body.message, 'Clear text')
  assert.equal(body.content, '')
})

test('invalid paths, scope, oversized content and non-string data never reach GitHub', async () => {
  const h = scripted([])
  for (const path of [
    '',
    '../secret',
    'dir/../secret',
    'dir//file',
    '.git/config',
    'C:\\secret.txt',
    'dir\u0000x',
    './x'
  ]) {
    await assert.rejects(h.writer.write(scope, { path, content: 'x' }), { status: 400 })
  }
  for (const repoFullName of ['../site', 'example/..', 'example/site/extra', 'example/site?x']) {
    await assert.rejects(h.writer.write({ ...scope, repoFullName }, { path: 'a', content: 'x' }), {
      status: 400
    })
  }
  await assert.rejects(h.writer.write({ ...scope, branch: '' }, { path: 'a', content: 'x' }), {
    status: 400
  })
  await assert.rejects(h.writer.write(scope, { path: 'a', content: null }), { status: 400 })
  await assert.rejects(h.writer.write(scope, { path: 'a', content: 'ü'.repeat(500_001) }), {
    status: 413
  })
  await assert.rejects(
    h.writer.write(scope, { path: 'a', content: 'x', message: 'm'.repeat(1001) }),
    { status: 400 }
  )
  assert.equal(h.calls.length, 0)
  assert.equal(githubFilePath('assets\\style.css'), 'assets/style.css')
})

test('directories, symlinks and submodules cannot be overwritten by a text write', async () => {
  for (const existing of [
    [],
    { ...file('x'), type: 'dir' },
    { ...file('x'), target: 'other' },
    { ...file('x'), submodule_git_url: 'https://example.invalid/submodule' }
  ]) {
    const h = scripted([json(existing)])
    await assert.rejects(h.writer.write(scope, { path: 'destination', content: 'x' }), {
      status: 409
    })
    assert.equal(h.calls.length, 1)
  }
})

test('missing GitHub permission and conflicts are reported without force overwrite or retries', async () => {
  for (const status of [401, 403, 409, 422]) {
    const h = scripted([json(file('old')), json({}, status)])
    await assert.rejects(h.writer.write(scope, { path: 'a', content: 'x' }), (error: any) => {
      assert.equal(error.status, status)
      assert.match(error.message, status < 409 ? /Contents: read and write/ : /no force overwrite/)
      return true
    })
    assert.equal(h.calls.length, 2)
    assert.equal(h.writer.isBusy(scope), false)
  }
})

test('an accepted commit with failed read-back is not reported as a successful write', async () => {
  for (const verify of [json(file('different')), json({}, 503)]) {
    const h = scripted([json({}, 404), json({ commit: { sha: commitSha } }), verify])
    await assert.rejects(
      h.writer.write(scope, { path: 'a', content: 'x' }),
      new RegExp('accepted commit ' + commitSha + '.*verification failed')
    )
    assert.equal(h.calls.length, 3)
  }
})

test('parallel writes are serialized per branch and a failed operation does not poison the queue', async () => {
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const paths: string[] = []
  const writer = new GithubWorkspaceWriter(async (path, init) => {
    paths.push(path)
    if (paths.length === 1) {
      started()
      await blocked
      return json({}, 403)
    }
    if (init?.method === 'PUT') return json({ commit: { sha: commitSha } })
    if (path.endsWith(commitSha)) return json(file('second'))
    return json({}, 404)
  })
  const first = writer.write(scope, { path: 'first', content: 'first' })
  const rejected = assert.rejects(first, { status: 403 })
  await firstStarted
  const second = writer.write(scope, { path: 'second', content: 'second' })
  assert.equal(writer.isBusy(scope), true)
  await Promise.resolve()
  assert.equal(paths.length, 1)
  release()
  await rejected
  assert.equal((await second).verified, true)
  assert.equal(paths.length, 4)
  assert.equal(writer.isBusy(scope), false)
})
