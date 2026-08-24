import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { net as electronNet } from 'electron'
import log from 'electron-log'

import { getConfig, setConfig, type AppConfig } from './index'

// ─── Types ──────────────────────────────────────────────

export interface WorkspaceEntry {
  path: string
  name: string
  repoFullName?: string
  lastUsedAt: number
}

export interface GithubRepoEntry {
  fullName: string
  name: string
  owner: string
  isPrivate: boolean
  defaultBranch: string
  updatedAt: string
  localPath: string | null
}

const MAX_RECENT_WORKSPACES = 12
const GITHUB_API = 'https://api.github.com'
const CLONE_TIMEOUT_MS = 10 * 60 * 1000

// ─── Paths ──────────────────────────────────────────────

export const getWorkspacesRoot = async (): Promise<string> => {
  const config = await getConfig()
  const configured = config.workspaces?.root?.trim()
  return configured || path.join(os.homedir(), 'OpenWebUI Workspaces')
}

const comparablePath = (value: string): string => {
  const normalized = path.normalize(value.trim()).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

// ─── Recent workspaces ──────────────────────────────────

const readRecent = (config: AppConfig): WorkspaceEntry[] =>
  Array.isArray(config.workspaces?.recent) ? config.workspaces.recent : []

/**
 * Recently used workspaces, newest first. Folders that were deleted or moved
 * outside the app are dropped instead of being offered as dead entries.
 */
export const listWorkspaces = async (): Promise<WorkspaceEntry[]> => {
  const config = await getConfig()
  const alive = readRecent(config).filter((entry) => {
    try {
      return fs.statSync(entry.path).isDirectory()
    } catch {
      return false
    }
  })
  return alive.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_RECENT_WORKSPACES)
}

export const rememberWorkspace = async (
  workspacePath: string,
  repoFullName?: string
): Promise<WorkspaceEntry[]> => {
  const config = await getConfig()
  const key = comparablePath(workspacePath)
  const previous = readRecent(config).find((entry) => comparablePath(entry.path) === key)

  const entry: WorkspaceEntry = {
    path: path.normalize(workspacePath),
    name: path.basename(path.normalize(workspacePath)) || workspacePath,
    ...(repoFullName || previous?.repoFullName
      ? { repoFullName: repoFullName ?? previous?.repoFullName }
      : {}),
    lastUsedAt: Date.now()
  }

  const recent = [entry, ...readRecent(config).filter((item) => comparablePath(item.path) !== key)]
    .slice(0, MAX_RECENT_WORKSPACES)

  await setConfig({ workspaces: { ...(config.workspaces ?? {}), recent } } as Partial<AppConfig>)
  return recent
}

export const forgetWorkspace = async (workspacePath: string): Promise<WorkspaceEntry[]> => {
  const config = await getConfig()
  const key = comparablePath(workspacePath)
  const recent = readRecent(config).filter((entry) => comparablePath(entry.path) !== key)
  await setConfig({ workspaces: { ...(config.workspaces ?? {}), recent } } as Partial<AppConfig>)
  return recent
}

// ─── GitHub ─────────────────────────────────────────────

const githubRequest = async (token: string, urlPath: string): Promise<unknown> => {
  const response = await electronNet.fetch(`${GITHUB_API}${urlPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'OpenWebUI-Desktop'
    },
    signal: AbortSignal.timeout(20_000)
  })

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'GitHub rejected the connector token. Check that the fine-grained token still grants repository access.'
    )
  }
  if (!response.ok) {
    throw new Error(`GitHub request failed with status ${response.status}`)
  }
  return response.json()
}

/**
 * Repositories the connector token can reach, newest activity first. Each entry
 * reports whether a local clone already exists so the picker can offer "open"
 * instead of "clone".
 */
export const listGithubRepositories = async (token: string): Promise<GithubRepoEntry[]> => {
  const root = await getWorkspacesRoot()
  const repositories: GithubRepoEntry[] = []

  for (let page = 1; page <= 4; page++) {
    const batch = (await githubRequest(
      token,
      `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
    )) as Array<Record<string, unknown>>
    if (!Array.isArray(batch) || batch.length === 0) break

    for (const repo of batch) {
      const fullName = String(repo.full_name ?? '')
      if (!fullName.includes('/')) continue
      const candidate = path.join(root, String(repo.name ?? ''))
      let localPath: string | null = null
      try {
        localPath = fs.statSync(path.join(candidate, '.git')).isDirectory() ? candidate : null
      } catch {
        localPath = null
      }

      repositories.push({
        fullName,
        name: String(repo.name ?? ''),
        owner: fullName.split('/')[0],
        isPrivate: Boolean(repo.private),
        defaultBranch: String(repo.default_branch ?? 'main'),
        updatedAt: String(repo.updated_at ?? ''),
        localPath
      })
    }

    if (batch.length < 100) break
  }

  return repositories
}

// ─── git ────────────────────────────────────────────────

const runGit = (
  args: string[],
  options: { cwd?: string; token?: string } = {}
): Promise<{ code: number; output: string }> =>
  new Promise((resolve, reject) => {
    // The token travels in the environment, never in argv, so it stays out of
    // the process list and out of git's own logging.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    if (options.token) {
      const basic = Buffer.from(`x-access-token:${options.token}`).toString('base64')
      env.GIT_CONFIG_COUNT = '1'
      env.GIT_CONFIG_KEY_0 = 'http.extraheader'
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`
    }

    const child = spawn('git', args, { cwd: options.cwd, env, shell: false })
    let output = ''
    const capture = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.length > 64_000) output = output.slice(-64_000)
    }

    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('git timed out'))
    }, CLONE_TIMEOUT_MS)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(
        error.message.includes('ENOENT')
          ? new Error('git was not found. Install Git and make sure it is on PATH.')
          : error
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })

const assertRepoFullName = (fullName: string): string => {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fullName)) {
    throw new Error(`Invalid repository name: ${fullName}`)
  }
  return fullName
}

/**
 * Clone a repository into the workspaces root, or fast-forward an existing
 * clone. Returns the local path that the workspace should switch to.
 */
export const prepareGithubWorkspace = async (
  token: string,
  fullName: string,
  onStatus?: (status: string) => void
): Promise<{ path: string; action: 'cloned' | 'updated' | 'unchanged' }> => {
  assertRepoFullName(fullName)
  const root = await getWorkspacesRoot()
  await fs.promises.mkdir(root, { recursive: true })

  const repoName = fullName.split('/')[1]
  const target = path.join(root, repoName)
  const alreadyCloned = fs.existsSync(path.join(target, '.git'))

  if (!alreadyCloned) {
    if (fs.existsSync(target) && (await fs.promises.readdir(target)).length > 0) {
      throw new Error(`${target} already exists and is not a git checkout.`)
    }
    onStatus?.(`Cloning ${fullName}…`)
    const result = await runGit(
      ['clone', '--progress', `https://github.com/${fullName}.git`, target],
      { token }
    )
    if (result.code !== 0) {
      throw new Error(`git clone failed: ${result.output.trim().split('\n').pop() ?? ''}`)
    }
    await rememberWorkspace(target, fullName)
    return { path: target, action: 'cloned' }
  }

  onStatus?.(`Updating ${fullName}…`)
  const status = await runGit(['status', '--porcelain'], { cwd: target })
  if (status.code === 0 && status.output.trim()) {
    // Uncommitted work would be at risk in a pull, so open the checkout as-is.
    log.info(`Workspace ${target} has local changes; skipping fetch`)
    await rememberWorkspace(target, fullName)
    return { path: target, action: 'unchanged' }
  }

  const pull = await runGit(['pull', '--ff-only'], { cwd: target, token })
  await rememberWorkspace(target, fullName)
  return { path: target, action: pull.code === 0 ? 'updated' : 'unchanged' }
}
