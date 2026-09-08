import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'

import type {
  WorkspacePreviewErrorCode,
  WorkspacePreviewInfo,
  WorkspacePreviewRequest
} from '../../shared/workspace-preview'

const HOST = '127.0.0.1'
const CAPABILITY_QUERY = '__desktop_preview'
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

// This is a static renderer, not a development server or a proxy. In particular,
// generated JavaScript cannot contact the authenticated app/terminal APIs.
export const WORKSPACE_PREVIEW_CSP = [
  "default-src 'self'",
  'sandbox allow-scripts',
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'"
].join('; ')

export class WorkspacePreviewError extends Error {
  readonly code: WorkspacePreviewErrorCode

  constructor(code: WorkspacePreviewErrorCode, message: string) {
    super(message)
    this.name = 'WorkspacePreviewError'
    this.code = code
  }
}

const unsafePath = (): WorkspacePreviewError =>
  new WorkspacePreviewError('UNSAFE_PATH', 'This file is outside the previewable workspace files.')

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

/** Reject ambiguous Windows paths, hidden files and traversal before URL/path normalization. */
const pathSegments = (value: string): string[] => {
  if (
    /[\\:]/.test(value) ||
    value.startsWith('//') ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw unsafePath()
  }
  const segments = value.split('/').filter(Boolean)
  if (
    segments.some(
      (part) =>
        part.startsWith('.') ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  ) {
    throw unsafePath()
  }
  return segments
}

interface ResolvedFile {
  filename: string
  relativePath: string
  mimeType: string
}

const resolveFile = async (root: string, relative: string): Promise<ResolvedFile> => {
  const segments = pathSegments(relative)
  let filename = root
  // Symlinks/junctions are deliberately not served, even when their present target
  // is inside the root. Recheck on every HTTP request, not only when opening a page.
  for (const segment of segments) {
    filename = path.join(filename, segment)
    const metadata = await lstat(filename)
    if (metadata.isSymbolicLink()) throw unsafePath()
  }
  if ((await stat(filename)).isDirectory()) {
    filename = path.join(filename, 'index.html')
    if ((await lstat(filename)).isSymbolicLink()) throw unsafePath()
  }
  const canonical = await realpath(filename)
  if (!isInside(root, canonical)) throw unsafePath()
  const mimeType = MIME_TYPES[path.extname(canonical).toLowerCase()]
  if (!mimeType) throw unsafePath()
  return {
    filename: canonical,
    relativePath: path.relative(root, canonical).split(path.sep).join('/'),
    mimeType
  }
}

const errorStatus = (error: unknown): number => {
  if (error instanceof WorkspacePreviewError) return 403
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 404
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ELOOP') return 403
  }
  return 500
}

const sendError = (response: ServerResponse, status: number): void => {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(
    status === 404
      ? 'Preview file not found. Check the selected workspace and HTML file.'
      : status === 403
        ? 'This preview request is not allowed.'
        : status === 405
          ? 'The preview is read-only.'
          : 'The preview file could not be loaded.'
  )
}

interface PreviewSession {
  info: WorkspacePreviewInfo
  port: number
  server: Server
  active: boolean
}

/**
 * One active static preview. Retired ports are never reused during this manager's
 * lifetime: an old document's same-origin Referer must not unlock a new workspace.
 * The caller must authorize workspacePath against its selected desktop workspace.
 */
export class WorkspacePreviewManager {
  private current: PreviewSession | null = null
  private revision = 0
  private readonly usedPorts = new Set<number>()

  getActive(): WorkspacePreviewInfo | null {
    return this.current ? { ...this.current.info } : null
  }

  /** Read-only availability probe. Does not start a server or retire an open preview. */
  async inspect(workspacePath: string): Promise<{ available: boolean; entryPath?: string }> {
    try {
      if (!path.isAbsolute(workspacePath)) return { available: false }
      const root = await realpath(workspacePath)
      if (path.parse(root).root === root || !(await stat(root)).isDirectory())
        return { available: false }
      const candidates = new Set(['index.html', 'index.htm'])
      let count = 0
      for await (const entry of await opendir(root)) {
        if (entry.isFile() && /\.html?$/i.test(entry.name)) candidates.add(entry.name)
        if (++count >= 512) break
      }
      for (const candidate of [...candidates].sort(
        (a, b) =>
          (a === 'index.html' ? -2 : a === 'index.htm' ? -1 : 0) -
            (b === 'index.html' ? -2 : b === 'index.htm' ? -1 : 0) || a.localeCompare(b)
      )) {
        try {
          const resolved = await resolveFile(root, candidate)
          const metadata = await stat(resolved.filename)
          if (metadata.isFile() && metadata.size <= MAX_FILE_BYTES) {
            return { available: true, entryPath: resolved.relativePath }
          }
        } catch {
          /* Try the next safe local HTML entry. */
        }
      }
    } catch {
      /* Missing, inaccessible and cloud workspaces have no preview. */
    }
    return { available: false }
  }

  async open(request: WorkspacePreviewRequest): Promise<WorkspacePreviewInfo> {
    const revision = ++this.revision
    // Stop serving the old directory immediately, including if the new selection
    // fails validation. No stale page may keep reading a previous workspace.
    const previous = this.current
    this.current = null
    if (previous) await this.stop(previous)

    if (
      !request ||
      typeof request.workspacePath !== 'string' ||
      !path.isAbsolute(request.workspacePath)
    ) {
      throw new WorkspacePreviewError('INVALID_WORKSPACE', 'Select a local workspace folder first.')
    }
    let root: string
    try {
      root = await realpath(request.workspacePath)
      if (!(await stat(root)).isDirectory() || path.parse(root).root === root) throw new Error()
    } catch {
      throw new WorkspacePreviewError(
        'INVALID_WORKSPACE',
        'The selected project folder is not available.'
      )
    }
    const entryPath = request.entryPath ?? 'index.html'
    if (typeof entryPath !== 'string' || path.isAbsolute(entryPath)) throw unsafePath()
    let entry: ResolvedFile
    try {
      entry = await resolveFile(root, entryPath)
    } catch (error) {
      if (error instanceof WorkspacePreviewError) throw error
      throw new WorkspacePreviewError(
        'ENTRY_NOT_FOUND',
        'No HTML file was found in the selected workspace.'
      )
    }
    if (!entry.mimeType.startsWith('text/html')) {
      throw new WorkspacePreviewError(
        'UNSUPPORTED_ENTRY',
        'Choose an HTML file to preview this website.'
      )
    }
    const capability = randomBytes(32).toString('hex')
    const session = await this.start(root, entry.relativePath, capability)
    if (revision !== this.revision) {
      await this.stop(session)
      throw new WorkspacePreviewError('SUPERSEDED', 'A newer workspace preview has been selected.')
    }
    session.active = true
    this.current = session
    return { ...session.info }
  }

  async close(id: string): Promise<void> {
    if (!this.current || this.current.info.id !== id) return
    ++this.revision
    const session = this.current
    this.current = null
    await this.stop(session)
  }

  async closeAll(): Promise<void> {
    ++this.revision
    const session = this.current
    this.current = null
    if (session) await this.stop(session)
  }

  private async stop(session: PreviewSession): Promise<void> {
    session.active = false
    await new Promise<void>((resolve) => {
      session.server.close(() => resolve())
      session.server.closeAllConnections()
    })
  }

  private async start(
    root: string,
    entryPath: string,
    capability: string
  ): Promise<PreviewSession> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const live: { session?: PreviewSession } = {}
      const server = createServer((request, response) => {
        const session = live.session
        if (!session?.active) {
          response.writeHead(410)
          response.end('This workspace preview is closed.')
          return
        }
        void this.serve(session, root, capability, request, response)
      })
      server.requestTimeout = 10_000
      server.headersTimeout = 10_000
      server.keepAliveTimeout = 1_000
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, HOST, () => {
            server.removeListener('error', reject)
            resolve()
          })
        })
      } catch {
        throw new WorkspacePreviewError(
          'PREVIEW_START_FAILED',
          'The local preview could not start.'
        )
      }
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        continue
      }
      if (this.usedPorts.has(address.port)) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        continue
      }
      this.usedPorts.add(address.port)
      const url = new URL(
        `http://${HOST}:${address.port}/${entryPath.split('/').map(encodeURIComponent).join('/')}`
      )
      url.searchParams.set(CAPABILITY_QUERY, capability)
      const session: PreviewSession = {
        info: {
          id: randomBytes(16).toString('hex'),
          url: url.href,
          workspacePath: root,
          entryPath
        },
        port: address.port,
        server,
        active: false
      }
      live.session = session
      return session
    }
    throw new WorkspacePreviewError(
      'PREVIEW_START_FAILED',
      'No unused local preview port is available.'
    )
  }

  private async serve(
    session: PreviewSession,
    root: string,
    capability: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    response.setHeader('Content-Security-Policy', WORKSPACE_PREVIEW_CSP)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
    )
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      response.setHeader('Allow', 'GET, HEAD')
      sendError(response, 405)
      return
    }
    const origin = `http://${HOST}:${session.port}`
    if (request.headers.host !== `${HOST}:${session.port}` || !request.url?.startsWith('/')) {
      sendError(response, 403)
      return
    }
    try {
      const url = new URL(request.url, origin)
      let authorized =
        url.searchParams.get(CAPABILITY_QUERY) === capability ||
        request.headers['x-desktop-preview'] === capability
      if (!authorized && request.headers.referer) {
        try {
          authorized = new URL(request.headers.referer).origin === origin
        } catch {
          throw unsafePath()
        }
      }
      if (!authorized) throw unsafePath()
      // The opaque sandbox origin needs CORS for module scripts and fonts. This
      // grants no credentials and is sent only after the capability/Referer gate.
      if (request.headers.origin === 'null')
        response.setHeader('Access-Control-Allow-Origin', 'null')
      const rawPath = request.url.split(/[?#]/, 1)[0]
      const file = await resolveFile(root, decodeURIComponent(rawPath))
      const metadata = await stat(file.filename)
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw unsafePath()
      const handle = await open(file.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const opened = await handle.stat()
        const canonical = await realpath(file.filename)
        if (
          !session.active ||
          !opened.isFile() ||
          opened.size > MAX_FILE_BYTES ||
          opened.dev !== metadata.dev ||
          opened.ino !== metadata.ino ||
          !isInside(root, canonical)
        ) {
          throw unsafePath()
        }
        response.writeHead(200, { 'Content-Type': file.mimeType, 'Content-Length': opened.size })
        if (request.method === 'HEAD') {
          response.end()
          await handle.close()
        } else {
          const stream = handle.createReadStream({ autoClose: true })
          stream.on('error', () => response.destroy())
          response.on('close', () => stream.destroy())
          stream.pipe(response)
        }
      } catch (error) {
        await handle.close()
        throw error
      }
    } catch (error) {
      sendError(response, error instanceof URIError ? 403 : errorStatus(error))
    }
  }
}
