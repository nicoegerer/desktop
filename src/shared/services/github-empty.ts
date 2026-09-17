import type { GithubRequest, GithubWriteScope } from './github-write'

/** A missing Contents/tree response is not sufficient evidence of an empty repo. */
export const hasUnbornDefaultBranch = async (
  scope: GithubWriteScope,
  request: GithubRequest
): Promise<boolean> => {
  const base = '/repos/' + scope.repoFullName
  const get = async (path: string): Promise<unknown> => {
    const response = await request(path, { redirect: 'error', cache: 'no-store' })
    if (!response.ok) {
      await response.body?.cancel()
      throw Object.assign(new Error('GitHub request failed with status ' + response.status), {
        status: response.status
      })
    }
    return response.json()
  }
  const repo = (await get(base)) as Record<string, unknown> | null
  if (
    typeof repo?.full_name !== 'string' ||
    repo.full_name.toLowerCase() !== scope.repoFullName.toLowerCase() ||
    repo.default_branch !== scope.branch
  )
    return false
  // size=0 alone is unsafe: GitHub's size statistics can lag after a push.
  const branches = await get(base + '/branches?per_page=1')
  return Array.isArray(branches) && branches.length === 0
}
