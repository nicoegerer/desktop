import fs from 'fs'
import path from 'path'

import { net as electronNet } from 'electron'

import { getConfig, setConfig, type AppConfig } from './index'

// ─── Types ──────────────────────────────────────────────

export interface WorkspaceEntry {
  path: string
  name: string
  lastUsedAt: number
}

export interface GithubRepoEntry {
  fullName: string
  name: string
  owner: string
  isPrivate: boolean
  defaultBranch: string
  updatedAt: string
}

const MAX_RECENT_WORKSPACES = 12
const GITHUB_API = 'https://api.github.com'

const comparablePath = (value: string): string => {
  const normalized = path.normalize(value.trim()).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

// ─── Recent workspaces ──────────────────────────────────

const readRecent = (config: AppConfig): WorkspaceEntry[] =>
  Array.isArray(config.workspaces?.recent)
    ? config.workspaces.recent.map((entry) => ({
        path: entry.path,
        name: entry.name,
        lastUsedAt: entry.lastUsedAt
      }))
    : []

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

export const rememberWorkspace = async (workspacePath: string): Promise<WorkspaceEntry[]> => {
  const config = await getConfig()
  const key = comparablePath(workspacePath)

  const entry: WorkspaceEntry = {
    path: path.normalize(workspacePath),
    name: path.basename(path.normalize(workspacePath)) || workspacePath,
    lastUsedAt: Date.now()
  }

  const recent = [entry, ...readRecent(config).filter((item) => comparablePath(item.path) !== key)]
    .slice(0, MAX_RECENT_WORKSPACES)

  await setConfig({ workspaces: { ...(config.workspaces ?? {}), recent } } as Partial<AppConfig>)
  return recent
}

// ─── Active workspaces ──────────────────────────────────
//
// Which workspaces have a running terminal. Persisted so a restart restores the
// same set instead of silently dropping every chat's working folder.

const readActive = (config: AppConfig): string[] =>
  Array.isArray(config.workspaces?.active) ? config.workspaces.active : []

export const setWorkspaceActive = async (
  workspacePath: string,
  active: boolean
): Promise<string[]> => {
  const config = await getConfig()
  const key = comparablePath(workspacePath)
  const remaining = readActive(config).filter((entry) => comparablePath(entry) !== key)
  const next = active ? [...remaining, path.normalize(workspacePath)] : remaining
  await setConfig({
    workspaces: { ...(config.workspaces ?? {}), active: next }
  } as Partial<AppConfig>)
  return next
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
 * Repositories the connector token can reach, newest activity first. Cloud
 * entries deliberately contain no local path: browsing uses the read-only
 * GitHub terminal mount and writes go through GitHub MCP.
 */
export const listGithubRepositories = async (token: string): Promise<GithubRepoEntry[]> => {
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

      repositories.push({
        fullName,
        name: String(repo.name ?? ''),
        owner: fullName.split('/')[0],
        isPrivate: Boolean(repo.private),
        defaultBranch: String(repo.default_branch ?? 'main'),
        updatedAt: String(repo.updated_at ?? '')
      })
    }

    if (batch.length < 100) break
  }

  return repositories
}
