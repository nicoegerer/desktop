/** Scoped, verified GitHub Contents writes. No checkout and no credential handling here. */
export interface GithubWriteScope {
  repoFullName: string
  branch: string
}

export type GithubRequest = (path: string, init?: RequestInit) => Promise<Response>

export const validateGithubScope = (scope: GithubWriteScope): void => {
  if (
    typeof scope.repoFullName !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repoFullName) ||
    scope.repoFullName.split('/').some((part) => part === '.' || part === '..') ||
    typeof scope.branch !== 'string' ||
    !scope.branch ||
    /[\x00-\x1f\x7f]/.test(scope.branch)
  ) {
    throw Object.assign(new Error('Invalid GitHub workspace.'), { status: 400 })
  }
}

export const githubFilePath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f:]/.test(value)) {
    throw Object.assign(new Error('A repository-relative file path is required.'), { status: 400 })
  }
  const parts = value.replace(/\\/g, '/').replace(/^\/+/, '').split('/')
  if (
    parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) {
    throw Object.assign(new Error('Invalid repository file path; traversal is not allowed.'), {
      status: 400
    })
  }
  return parts.join('/')
}

export const githubContentsPath = (scope: GithubWriteScope, path: string): string =>
  '/repos/' + scope.repoFullName + '/contents/' + path.split('/').map(encodeURIComponent).join('/')

const fail = (message: string, status = 502): Error => Object.assign(new Error(message), { status })
const checkResponse = (response: Response): void => {
  if (response.ok) return
  if (response.status === 401 || response.status === 403) {
    throw fail(
      'GitHub denied this operation. The connector needs Contents: read and write for this repository; branch protections still apply.',
      response.status
    )
  }
  if (response.status === 409 || response.status === 422) {
    throw fail(
      'GitHub rejected the change or the branch changed concurrently. Read the current file and retry; no force overwrite was attempted.',
      response.status
    )
  }
  throw fail('GitHub request failed with status ' + response.status + '.', response.status)
}

export interface GithubWriteResult {
  path: string
  size: number
  repository: string
  branch: string
  commit_sha: string
  verified: true
}

/** Serialize writes on a branch; parallel Contents updates otherwise conflict. */
export class GithubWorkspaceWriter {
  private queues = new Map<string, Promise<unknown>>()
  private request: GithubRequest

  constructor(request: GithubRequest) {
    this.request = request
  }

  isBusy(scope: GithubWriteScope): boolean {
    return this.queues.has(scope.repoFullName.toLowerCase() + '@' + scope.branch)
  }

  async write(scope: GithubWriteScope, input: unknown): Promise<GithubWriteResult> {
    validateGithubScope(scope)
    const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const path = githubFilePath(body.path)
    if (typeof body.content !== 'string') throw fail('File content must be a string.', 400)
    const bytes = Buffer.from(body.content, 'utf8')
    if (bytes.length > 1_000_000) throw fail('Cloud text files are limited to 1 MB.', 413)
    const message =
      typeof body.message === 'string' && body.message.trim()
        ? body.message.trim()
        : 'Update ' + path + ' via Open WebUI'
    if (message.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(message)) {
      throw fail('Invalid commit message.', 400)
    }
    const key = scope.repoFullName.toLowerCase() + '@' + scope.branch
    const previous = this.queues.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => this.commit(scope, path, bytes, message))
    this.queues.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.queues.get(key) === pending) this.queues.delete(key)
    }
  }

  private async commit(
    scope: GithubWriteScope,
    path: string,
    bytes: Buffer,
    message: string
  ): Promise<GithubWriteResult> {
    const endpoint = githubContentsPath(scope, path)
    // Never use the file-browser cache when choosing the expected blob SHA.
    const current = await this.request(endpoint + '?ref=' + encodeURIComponent(scope.branch))
    let sha: string | undefined
    if (current.status !== 404) {
      checkResponse(current)
      const existing = await current.json()
      if (
        Array.isArray(existing) ||
        existing.type !== 'file' ||
        existing.submodule_git_url ||
        existing.target
      ) {
        throw fail('The destination is not an ordinary repository file.', 409)
      }
      if (typeof existing.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(existing.sha)) {
        throw fail('GitHub returned an invalid file revision.')
      }
      sha = existing.sha
    }
    const response = await this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content: bytes.toString('base64'),
        branch: scope.branch,
        ...(sha ? { sha } : {})
      })
    })
    checkResponse(response)
    const result = await response.json()
    const commit = result?.commit?.sha
    if (typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(commit)) {
      throw fail(
        'GitHub accepted the write but returned no verifiable commit. Inspect the repository before retrying.'
      )
    }
    try {
      // Verify the immutable committed revision, not a possibly stale branch cache.
      const verify = await this.request(endpoint + '?ref=' + encodeURIComponent(commit))
      checkResponse(verify)
      const file = await verify.json()
      if (
        file?.encoding !== 'base64' ||
        typeof file.content !== 'string' ||
        !Buffer.from(file.content, 'base64').equals(bytes)
      ) {
        throw new Error('Committed contents differ from the requested file.')
      }
    } catch {
      throw fail(
        'GitHub accepted commit ' +
          commit +
          ', but read-back verification failed. Inspect that commit before retrying.'
      )
    }
    return {
      path: '/' + path,
      size: bytes.length,
      repository: scope.repoFullName,
      branch: scope.branch,
      commit_sha: commit,
      verified: true
    }
  }
}
