import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { GithubRequest } from '../../shared/services/github-write'

export const githubError = (message: string, status = 400): Error =>
  Object.assign(new Error(message), { status })

/** Never accept URLs, CLI options, placeholders, or path normalization tricks. */
export const githubApiPath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 4096 || !/^\/[A-Za-z]/.test(value))
    throw githubError('Use a GitHub REST API path such as /repos/owner/repo/actions/runs.')
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw githubError('Invalid API path encoding.')
  }
  if (
    [...value].some((character) => character.charCodeAt(0) <= 32) ||
    [...decoded].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    /[\\{}]/u.test(decoded) ||
    value.includes('#') ||
    decoded.includes('://') ||
    decoded
      .split('?')[0]
      .split('/')
      .some((part) => part === '.' || part === '..' || (!part && decoded.indexOf('//') >= 0))
  )
    throw githubError('Invalid GitHub API path.')
  return value
}

export type GhRunner = (args: string[], input?: string) => Promise<{ code: number; stdout: string }>

const findGh = async (): Promise<string> => {
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh'
  const candidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(isAbsolute)
    .map((dir) => join(dir, name))
  if (process.platform === 'win32' && process.env.ProgramFiles)
    candidates.unshift(join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe'))
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      /* next installation */
    }
  }
  throw githubError(
    'GitHub CLI is not installed. Install gh and sign in with gh auth login, or select a Personal Access Token in the connector.',
    503
  )
}

/** Only fixed gh built-ins, never a shell or user-supplied command. Credentials stay in gh. */
export const runGh: GhRunner = async (args, input) => {
  const executable = await findGh()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    GH_HOST: 'github.com'
  }
  delete env.GH_DEBUG
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      {
        cwd: tmpdir(),
        env,
        shell: false,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 12 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout) => {
        // Never return raw exec errors: they can contain request bodies or debug credentials.
        if (error && (error.killed || typeof error.code !== 'number')) {
          reject(
            githubError(
              'GitHub CLI request failed or exceeded its time/output limit. Check the CLI installation and connection.',
              502
            )
          )
        } else resolve({ code: error ? Number(error.code) : 0, stdout })
      }
    )
    child.stdin?.on('error', () => {
      /* an early CLI exit is handled by the callback */
    })
    child.stdin?.end(input)
  })
}

export const createGithubCliRequest =
  (run: GhRunner = runGh): GithubRequest =>
  async (path, init = {}) => {
    const endpoint = githubApiPath(path)
    const method = (init.method ?? 'GET').toUpperCase()
    // Writes are called only by the scoped Contents/action handlers, never the global read bridge.
    const scopedAction =
      /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pages|actions\/workflows\/(?:[1-9][0-9]{0,19}|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml)\/dispatches|actions\/runs\/[1-9][0-9]{0,19}\/rerun(?:-failed-jobs)?)$/.test(
        endpoint
      )
    if (
      method !== 'GET' &&
      !(method === 'PUT' && /^\/repos\/[^/]+\/[^/]+\/contents\/.+/.test(endpoint)) &&
      !(method === 'POST' && scopedAction)
    )
      throw githubError(
        'This connection supports reads and selected-workspace file/Pages/Actions operations, not account administration.'
      )
    if (init.body != null && typeof init.body !== 'string')
      throw githubError('Expected a JSON request body.')
    const args = [
      'api',
      '--hostname',
      'github.com',
      '--include',
      '--method',
      method,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28'
    ]
    if (init.body != null) args.push('--input', '-')
    args.push(endpoint)
    const result = await run(args, init.body == null ? undefined : String(init.body))
    const match = /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n/.exec(result.stdout)
    if (!match)
      throw githubError(
        'GitHub CLI could not access github.com. Check gh auth status and sign in if necessary. No fallback account was used.',
        503
      )
    const status = Number(match[1])
    // Only response metadata needed by our clients; never expose arbitrary headers.
    const headers = new Headers()
    for (const line of match[2].split(/\r?\n/)) {
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).toLowerCase()
      if (['content-type', 'x-oauth-scopes', 'x-ratelimit-remaining', 'retry-after'].includes(name))
        headers.set(name, line.slice(colon + 1).trim())
    }
    const body = result.stdout.slice(match[0].length)
    return new Response([204, 205, 304].includes(status) ? null : body, { status, headers })
  }

export const githubActionsLogs = async (
  value: Record<string, unknown>,
  run: GhRunner = runGh
): Promise<unknown> => {
  const repository = value.repository
  const runId = String(value.run_id ?? '')
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository) ||
    !/^[1-9][0-9]{0,19}$/.test(runId)
  )
    throw githubError('A repository owner/name and numeric run_id are required.')
  const result = await run([
    'run',
    'view',
    runId,
    '--repo',
    'github.com/' + repository,
    value.failed_only === false ? '--log' : '--log-failed'
  ])
  if (result.code !== 0)
    throw githubError(
      'Actions logs are unavailable. Check the run status and Actions read permission with github_api_read; running jobs may not have logs yet.',
      502
    )
  const offset = Number(value.offset ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw githubError('offset must be a non-negative integer.')
  const text = result.stdout.slice(offset, offset + 32_000)
  return {
    repository,
    run_id: runId,
    text,
    next_offset: offset + text.length < result.stdout.length ? offset + text.length : null
  }
}
