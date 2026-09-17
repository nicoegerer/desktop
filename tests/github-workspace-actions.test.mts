import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
const compiled = await build({
  entryPoints: [
    fileURLToPath(new URL('../src/shared/services/github-workspace-actions.ts', import.meta.url))
  ],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs'
})
const module = { exports: {} as any }
new Function('require', 'module', 'exports', compiled.outputFiles![0].text)(
  createRequire(import.meta.url),
  module,
  module.exports
)
const { githubWorkspaceAction: action } = module.exports
const scope = { repoFullName: 'owner/site', branch: 'feature/site' }
const base = '/repos/owner/site'

test('Pages activation is idempotent and never claims deployment success', async () => {
  let exists = false
  const calls: any[] = []
  const request = async (path: string, init: RequestInit) => {
    calls.push({ path, ...init })
    if (path === base) return Response.json({ full_name: 'owner/site' })
    assert.equal(path, base + '/pages')
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(String(init.body)), { build_type: 'workflow' })
      exists = true
      return Response.json({}, { status: 201 })
    }
    return exists
      ? Response.json({ build_type: 'workflow', html_url: 'https://owner.github.io/site/' })
      : Response.json({}, { status: 404 })
  }
  const body = { action: 'pages_enable', user_requested: true }
  const created = await action(scope, body, request)
  assert.equal(created.changed, true)
  assert.equal(created.deployment_verified, false)
  assert.equal(created.repository, scope.repoFullName)
  assert.equal((await action(scope, body, request)).changed, false)
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
})

test('Pages preserves existing sources, API denial, identity mismatch and unsuccessful verification', async () => {
  for (const scenario of ['legacy', 'denied', 'wrong-repo', 'unverified', 'post-denied']) {
    let writes = 0
    const request = async (path: string, init: RequestInit) => {
      if (init.method === 'POST') {
        writes++
        return Response.json({}, { status: scenario === 'post-denied' ? 403 : 201 })
      }
      if (path === base)
        return Response.json({
          full_name: scenario === 'wrong-repo' ? 'elsewhere/repo' : scope.repoFullName
        })
      if (scenario === 'denied') return Response.json({}, { status: 403 })
      if (scenario === 'legacy' || writes) return Response.json({ build_type: 'legacy' })
      return Response.json({}, { status: 404 })
    }
    await assert.rejects(action(scope, { action: 'pages_enable', user_requested: true }, request))
    assert.equal(writes, ['unverified', 'post-denied'].includes(scenario) ? 1 : 0)
  }
})

test('dispatch pins repository and branch, validates workflow and inputs, returns acceptance only', async () => {
  const calls: any[] = []
  const dispatched = await action(
    scope,
    {
      action: 'workflow_dispatch',
      user_requested: true,
      workflow_id: 'deploy.yml',
      inputs_json: '{"environment":"preview"}'
    },
    async (path: string, init: RequestInit) => {
      calls.push({ path, ...init })
      return init.method === 'POST' ? new Response(null, { status: 204 }) : Response.json({})
    }
  )
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      base + '/actions/workflows/deploy.yml',
      base + '/branches/feature%2Fsite',
      base + '/actions/workflows/deploy.yml/dispatches'
    ]
  )
  assert.deepEqual(JSON.parse(calls[2].body), {
    ref: 'feature/site',
    inputs: { environment: 'preview' }
  })
  assert.equal(dispatched.accepted, true)
  assert.equal(dispatched.deployment_verified, false)
})

test('rerun is limited to a completed run from the selected branch, never a fork', async () => {
  for (const invalid of [null, 'branch', 'fork', 'id', 'running']) {
    let writes = 0
    const request = async (path: string, init: RequestInit) => {
      if (init.method === 'POST') {
        writes++
        assert.equal(path, base + '/actions/runs/123/rerun-failed-jobs')
        return new Response(null, { status: 201 })
      }
      return Response.json({
        id: invalid === 'id' ? 456 : 123,
        head_branch: invalid === 'branch' ? 'other' : scope.branch,
        head_repository: { full_name: invalid === 'fork' ? 'fork/site' : scope.repoFullName },
        status: invalid === 'running' ? 'in_progress' : 'completed',
        run_attempt: 1
      })
    }
    const work = action(
      scope,
      { action: 'workflow_rerun', user_requested: true, run_id: '123' },
      request
    )
    if (invalid) await assert.rejects(work)
    else {
      const result = await work
      assert.equal(result.accepted, true)
      assert.equal(result.deployment_verified, false)
      assert.equal(result.previous_attempt, 1)
    }
    assert.equal(writes, invalid ? 0 : 1)
  }
})

test('malformed inputs, absent user request, arbitrary operations and scope overrides never call GitHub', async () => {
  const invalid = [
    {},
    null,
    { action: 'pages_enable' },
    { action: 'pages_enable', user_requested: false },
    { action: 'DELETE', user_requested: true },
    { action: '__proto__', user_requested: true },
    { action: 'pages_enable', user_requested: true, repository: 'evil/repo' },
    { action: 'workflow_dispatch', user_requested: true, workflow_id: '../evil.yml' },
    { action: 'workflow_dispatch', user_requested: true, workflow_id: 'deploy.yml', ref: 'wrong' },
    {
      action: 'workflow_dispatch',
      user_requested: true,
      workflow_id: 'deploy.yml',
      inputs_json: 'null'
    },
    {
      action: 'workflow_dispatch',
      user_requested: true,
      workflow_id: 'deploy.yml',
      inputs_json: '{"a":{}}'
    },
    { action: 'workflow_rerun', user_requested: true, run_id: '--help' },
    { action: 'workflow_rerun', user_requested: true, run_id: '123', failed_only: 'false' }
  ]
  let calls = 0
  for (const body of invalid)
    await assert.rejects(
      action(scope, body, async () => {
        calls++
        throw new Error('must not call GitHub')
      })
    )
  assert.equal(calls, 0)
})

test('a workspace/account change during preflight prevents writes; uncertain writes are never retried', async () => {
  let active = true,
    writes = 0
  await assert.rejects(
    action(
      scope,
      { action: 'pages_enable', user_requested: true },
      async (path: string, init: RequestInit) => {
        if (init.method === 'POST') {
          writes++
          throw new Error('must not write')
        }
        if (path === base) {
          active = false
          return Response.json({ full_name: scope.repoFullName })
        }
        return Response.json({}, { status: 404 })
      },
      () => active
    ),
    /changed/
  )
  assert.equal(writes, 0)
  await assert.rejects(
    action(
      scope,
      { action: 'workflow_dispatch', user_requested: true, workflow_id: 'deploy.yml' },
      async (_path: string, init: RequestInit) => {
        if (init.method === 'POST') {
          writes++
          throw new Error('network timeout')
        }
        return Response.json({})
      }
    ),
    /network timeout/
  )
  assert.equal(writes, 1)
})
