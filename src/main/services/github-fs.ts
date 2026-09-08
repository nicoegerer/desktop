import crypto from 'crypto'
import http from 'http'

import { net as electronNet } from 'electron'
import log from 'electron-log'

import {
  isBinary,
  listingDir,
  repoPath,
  sliceFile,
  toFileEntries
} from '../../shared/services/github-contents'
import { githubWorkspaceOpenApi } from '../../shared/services/github-workspace-openapi'
import {
  GithubWorkspaceWriter,
  githubContentsPath,
  validateGithubScope
} from '../../shared/services/github-write'

/**
 * A scoped filesystem view of a GitHub repository, served in the shape Open
 * WebUI's file browser expects.
 *
 * A cloud workspace has no checkout, so the file panel — which only ever talks
 * to a terminal server — had nothing to show. This serves the subset of Open
 * Terminal's file API that browsing needs, backed by the GitHub contents API.
 *
 * Text writes use the Contents API, preserve the expected blob revision, and
 * verify the immutable commit before reporting success. No local checkout is made.
 *
 * One server hosts every repository. Open WebUI keeps the path of a terminal
 * URL, so each repository is reachable under its own `/r/<slug>` prefix and
 * needs no port of its own.
 */

const GITHUB_API = 'https://api.github.com'
const HOST = '127.0.0.1'
const BASE_PORT = 39484
const CACHE_TTL_MS = 20_000

export interface GithubRepoRef {
  repoFullName: string
  branch: string
}

interface Mount extends GithubRepoRef {
  slug: string
}

interface CacheEntry {
  at: number
  payload: unknown
}

let server: http.Server | null = null
let listeningPort = 0
let apiKey = ''
let tokenResolver: () => string | null = () => null
const mounts = new Map<string, Mount>()
const cache = new Map<string, CacheEntry>()
const githubRequest = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const token = tokenResolver()
  if (!token)
    throw Object.assign(new Error('No GitHub connector token is configured'), { status: 401 })
  return electronNet.fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'OpenWebUI-Desktop'
    },
    signal: AbortSignal.timeout(20_000)
  })
}
const writer = new GithubWorkspaceWriter(githubRequest)

export const githubMountSlug = (repo: GithubRepoRef): string =>
  crypto
    .createHash('sha256')
    .update(`${repo.repoFullName}@${repo.branch}`)
    .digest('hex')
    .slice(0, 12)

/** Terminal id under which a repository is registered in Open WebUI. */
export const githubTerminalId = (repo: GithubRepoRef): string =>
  `desktop-gh-${githubMountSlug(repo)}`

export const configureGithubFs = (resolver: () => string | null): void => {
  tokenResolver = resolver
}

// ─── GitHub ─────────────────────────────────────────────

const githubGet = async (path: string): Promise<unknown> => {
  const cached = cache.get(path)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload

  const response = await githubRequest(path)
  if (response.status === 404) throw Object.assign(new Error('Not found'), { status: 404 })
  if (!response.ok) throw new Error(`GitHub request failed with status ${response.status}`)

  const payload = await response.json()
  cache.set(path, { at: Date.now(), payload })
  return payload
}

const contentsUrl = (mount: Mount, path: string): string =>
  githubContentsPath(mount, path) + `?ref=${encodeURIComponent(mount.branch)}`

const listDirectory = async (mount: Mount, path: string): Promise<unknown> => {
  const payload = await githubGet(contentsUrl(mount, path))
  if (!Array.isArray(payload)) throw Object.assign(new Error('Not a directory'), { status: 404 })
  return { dir: listingDir(path), entries: toFileEntries(payload) }
}

const readFile = async (
  mount: Mount,
  path: string,
  startLine?: number,
  endLine?: number
): Promise<unknown> => {
  const payload = (await githubGet(contentsUrl(mount, path))) as Record<string, unknown>
  if (Array.isArray(payload) || payload.type !== 'file') {
    throw Object.assign(new Error('File not found'), { status: 404 })
  }
  if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw Object.assign(new Error('Unsupported file'), { status: 415 })
  }

  const buffer = Buffer.from(payload.content, 'base64')
  // Files the panel cannot display are rejected the same way Open Terminal
  // rejects them, so the panel shows its own message instead of mojibake.
  if (isBinary(buffer)) {
    throw Object.assign(new Error('Unsupported binary file type'), { status: 415 })
  }
  return sliceFile(path, buffer.toString('utf8'), startLine, endLine)
}

// ─── HTTP ───────────────────────────────────────────────

const send = (response: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  response.end(payload)
}

const handle = async (
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> => {
  const url = new URL(request.url ?? '/', `http://${HOST}`)

  // Open WebUI probes health without credentials, exactly as it does for a
  // local Open Terminal.
  if (url.pathname === '/health' || url.pathname.endsWith('/health')) {
    send(response, 200, { status: 'ok' })
    return
  }

  const match = /^\/r\/([a-f0-9]{12})(\/.*)?$/.exec(url.pathname)
  if (!match) {
    send(response, 404, { detail: 'Unknown mount' })
    return
  }
  const mount = mounts.get(match[1])
  if (!mount) {
    send(response, 404, { detail: 'Unknown repository' })
    return
  }
  const route = match[2] || '/'

  if (route === '/api/config') {
    // No shell, no notebooks: this mount is a file view, not a machine.
    send(response, 200, { features: { terminal: false, notebooks: false, system: false } })
    return
  }

  const header = request.headers.authorization ?? ''
  if (!apiKey || header !== `Bearer ${apiKey}`) {
    send(response, 401, { detail: 'Invalid API key' })
    return
  }

  try {
    if (route === '/files/write' && request.method === 'POST') {
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        size += chunk.length
        if (size > 6_100_000) {
          send(response, 413, { detail: 'Cloud text files are limited to 1 MB.' })
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        send(response, 400, { detail: 'Expected a JSON file path and content.' })
        return
      }
      try {
        send(response, 200, await writer.write(mount, body))
      } finally {
        // Also invalidate after an uncertain write; never show stale files as proof.
        for (const key of cache.keys()) {
          if (key.startsWith('/repos/' + mount.repoFullName + '/contents/')) cache.delete(key)
        }
      }
      return
    }
    if (request.method !== 'GET') {
      send(response, 405, {
        detail: 'Unsupported cloud operation. Use write_file to save text files.'
      })
      return
    }
    if (route === '/openapi.json') {
      send(response, 200, githubWorkspaceOpenApi(mount.repoFullName))
      return
    }
    if (route === '/info') {
      send(response, 200, {
        info:
          `GitHub repository ${mount.repoFullName} on branch ${mount.branch}. ` +
          'Use write_file to create or replace files directly on this branch; each write ' +
          'creates a verified commit. There is no local checkout and no shell.'
      })
      return
    }
    if (route === '/files/cwd') {
      send(response, 200, { cwd: '/' })
      return
    }
    if (route === '/files/list') {
      send(
        response,
        200,
        await listDirectory(mount, repoPath(url.searchParams.get('directory') ?? ''))
      )
      return
    }
    if (route === '/files/read') {
      const path = repoPath(url.searchParams.get('path') ?? '')
      if (!path) {
        send(response, 404, { detail: 'File not found' })
        return
      }
      const toLine = (value: string | null): number | undefined => {
        const parsed = Number(value)
        return Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined
      }
      send(
        response,
        200,
        await readFile(
          mount,
          path,
          toLine(url.searchParams.get('start_line')),
          toLine(url.searchParams.get('end_line'))
        )
      )
      return
    }

    send(response, 404, { detail: 'Unknown workspace operation.' })
  } catch (error) {
    const status = (error as { status?: number }).status ?? 502
    send(response, status, {
      detail: error instanceof Error ? error.message : 'GitHub request failed'
    })
  }
}

const portInUse = (candidate: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = http.createServer()
    probe.once('error', () => resolve(true))
    probe.once('listening', () => probe.close(() => resolve(false)))
    probe.listen(candidate, HOST)
  })

const ensureServer = async (): Promise<void> => {
  if (server) return
  if (!apiKey) apiKey = crypto.randomBytes(24).toString('base64url')

  let candidate = BASE_PORT
  while (await portInUse(candidate)) {
    candidate++
    if (candidate > BASE_PORT + 100) throw new Error('No free port for the GitHub workspace server')
  }

  await new Promise<void>((resolve, reject) => {
    const next = http.createServer((request, response) => {
      void handle(request, response).catch((error) => {
        log.warn('GitHub workspace server error:', error)
        if (!response.headersSent) send(response, 500, { detail: 'Internal error' })
      })
    })
    next.once('error', reject)
    next.listen(candidate, HOST, () => {
      server = next
      listeningPort = candidate
      log.info(`GitHub workspace server listening on http://${HOST}:${candidate}`)
      resolve()
    })
  })
}

export interface GithubMountResult {
  id: string
  name: string
  url: string
  apiKey: string
}

/** Make a repository browsable and return how to register it in Open WebUI. */
export const mountGithubRepo = async (repo: GithubRepoRef): Promise<GithubMountResult> => {
  validateGithubScope(repo)
  await ensureServer()
  const slug = githubMountSlug(repo)
  mounts.set(slug, { ...repo, slug })
  return {
    id: githubTerminalId(repo),
    name: repo.repoFullName,
    url: `http://${HOST}:${listeningPort}/r/${slug}`,
    apiKey
  }
}

export const listGithubMounts = (): GithubMountResult[] =>
  [...mounts.values()].map((mount) => ({
    id: githubTerminalId(mount),
    name: mount.repoFullName,
    url: `http://${HOST}:${listeningPort}/r/${mount.slug}`,
    apiKey
  }))

export const unmountGithubRepos = (keep: Set<string>): number => {
  let removed = 0
  for (const [slug, mount] of [...mounts.entries()]) {
    if (keep.has(githubTerminalId(mount)) || writer.isBusy(mount)) continue
    mounts.delete(slug)
    removed++
  }
  return removed
}

export const stopGithubFs = async (): Promise<void> => {
  mounts.clear()
  cache.clear()
  if (!server) return
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = null
  listeningPort = 0
}
