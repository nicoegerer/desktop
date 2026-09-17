import { createHash } from 'node:crypto'
import type { GithubRequest, GithubWriteScope } from '../../shared/services/github-write'
import { validateGithubScope } from '../../shared/services/github-write'
import { hasUnbornDefaultBranch } from '../../shared/services/github-empty'
import type { WorkspacePreviewSource } from './workspace-preview-source'

const MAX_BYTES = 64 * 1024 * 1024
const shaPattern = /^[a-f0-9]{40}$/
const fail = (status = 502): Error =>
  Object.assign(new Error('The selected GitHub preview file is unavailable.'), { status })

export const githubPreviewRoot = (scope: GithubWriteScope): string =>
  `github://${scope.repoFullName}?ref=${encodeURIComponent(scope.branch)}`

/** Bounded, read-only GitHub snapshot. Ignore response URLs and never follow symlinks. */
export function createGithubPreviewSource(
  scope: GithubWriteScope,
  request: GithubRequest,
  isActive: () => boolean
): WorkspacePreviewSource {
  validateGithubScope(scope)
  const { repoFullName, branch } = scope
  const base = '/repos/' + repoFullName + '/git/'
  const assertActive = (): void => {
    if (!isActive()) throw fail(404)
  }
  const get = async (route: string, limit: number): Promise<any> => {
    assertActive()
    const response = await request(base + route, { redirect: 'error', cache: 'no-store' })
    if (!response.ok) {
      await response.body?.cancel()
      throw fail(response.status)
    }
    const reader = response.body?.getReader()
    if (!reader) throw fail()
    const chunks: Buffer[] = []
    let length = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > limit) throw fail(413)
        chunks.push(Buffer.from(next.value))
      }
      assertActive()
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  }
  type BlobEntry = { sha: string; size: number }
  let snapshot: Promise<Map<string, BlobEntry>> | undefined
  const files = (): Promise<Map<string, BlobEntry>> => {
    assertActive()
    // Resolve the branch once. Every resource in a page uses this same tree,
    // even if a subsequent model write moves the branch while the page loads.
    snapshot ??= get('trees/' + encodeURIComponent(branch) + '?recursive=1', 8 * 1024 * 1024)
      .then((tree) => {
        if (!shaPattern.test(tree.sha) || tree.truncated !== false || !Array.isArray(tree.tree))
          throw fail()
        const result = new Map<string, BlobEntry>()
        for (const entry of tree.tree) {
          if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) continue
          if (
            typeof entry.path !== 'string' ||
            !entry.path ||
            entry.path.startsWith('/') ||
            /[\\:\x00-\x1f\x7f]/.test(entry.path) ||
            entry.path.split('/').some((part: string) => !part || part.startsWith('.')) ||
            !shaPattern.test(entry.sha) ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0 ||
            entry.size > MAX_BYTES
          )
            continue
          if (result.has(entry.path)) throw fail()
          result.set(entry.path, { sha: entry.sha, size: entry.size })
        }
        return result
      })
      .catch(async (error) => {
        const status = (error as { status?: number }).status
        assertActive()
        if ((status === 404 || status === 409) && (await hasUnbornDefaultBranch(scope, request))) {
          assertActive()
          return new Map<string, BlobEntry>()
        }
        throw error
      })
    return snapshot
  }
  const bodies = new Map<string, Buffer>()
  let cachedBytes = 0
  return {
    root: githubPreviewRoot({ repoFullName, branch }),
    isActive,
    listFiles: async () => [...(await files()).keys()],
    readFile: async (relativePath) => {
      const entry = (await files()).get(relativePath)
      assertActive()
      if (!entry) throw fail(404)
      const cached = bodies.get(entry.sha)
      if (cached) return cached
      const blob = await get('blobs/' + entry.sha, Math.ceil(entry.size * 1.4) + 4096)
      if (
        blob.sha !== entry.sha ||
        blob.size !== entry.size ||
        blob.encoding !== 'base64' ||
        typeof blob.content !== 'string'
      )
        throw fail()
      const bytes = Buffer.from(blob.content, 'base64')
      const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      if (bytes.length !== entry.size || digest !== entry.sha) throw fail()
      if (cachedBytes + bytes.length <= MAX_BYTES) {
        bodies.set(entry.sha, bytes)
        cachedBytes += bytes.length
      }
      return bytes
    }
  }
}
