import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import type { GithubRequest, GithubWriteScope } from '../../src/shared/services/github-write.ts'
import type { WorkspacePreviewSource } from '../../src/main/services/workspace-preview-source.ts'

const built = await build({
  entryPoints: [
    fileURLToPath(new URL('../../src/main/services/github-preview.ts', import.meta.url))
  ],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
export const { createGithubPreviewSource } = (await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
)) as {
  createGithubPreviewSource(
    scope: GithubWriteScope,
    request: GithubRequest,
    active: () => boolean
  ): WorkspacePreviewSource
}

export const blobSha = (value: Buffer): string =>
  createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex')

export function cloudFixture(
  initial: Record<string, string | Buffer>,
  scope = { repoFullName: 'example/cloud-site', branch: 'feature/website' }
) {
  const files = new Map(Object.entries(initial).map(([name, body]) => [name, Buffer.from(body)]))
  const blobs = new Map<string, Buffer>()
  const calls: string[] = []
  let active = true
  const request: GithubRequest = async (route, init) => {
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.cache, 'no-store')
    calls.push(route)
    const base = '/repos/' + scope.repoFullName + '/git/'
    assert.ok(route.startsWith(base), 'No cross-repository requests')
    if (route === base + 'trees/' + encodeURIComponent(scope.branch) + '?recursive=1') {
      return Response.json({
        sha: 'a'.repeat(40),
        truncated: false,
        tree: [...files].map(([name, bytes]) => {
          const sha = blobSha(bytes)
          blobs.set(sha, bytes)
          return { path: name, type: 'blob', mode: '100644', sha, size: bytes.length }
        })
      })
    }
    const bytes = blobs.get(route.slice((base + 'blobs/').length))
    return bytes
      ? Response.json({
          sha: blobSha(bytes),
          size: bytes.length,
          encoding: 'base64',
          content: bytes.toString('base64')
        })
      : Response.json({}, { status: 404 })
  }
  return {
    files,
    calls,
    request,
    source: () => createGithubPreviewSource(scope, request, () => active),
    retire: () => {
      active = false
    }
  }
}
