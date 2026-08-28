import { net as electronNet, webContents } from 'electron'
import log from 'electron-log'

import {
  applyCloudWorkspacePrompt,
  mergeTerminalServers,
  mergeToolServers,
  shouldWriteTerminalServers,
  stripDesktopDefaultTools,
  type TerminalServerConnection,
  type ToolServerConnection
} from '../../shared/services/tool-servers'
import type { ManagedServiceToolTarget, OpenWebUISyncResult } from '../../shared/services/types'
import { listWorkspaceTerminals } from '../utils/open-terminal'
import { listGithubMounts } from './github-fs'

/**
 * The desktop registry owns part of Open WebUI's configuration: connectors
 * become tool servers and workspaces become terminal servers. Open WebUI has no
 * page-level handler for either, so the main process writes them through the
 * admin API of the bundled instance.
 *
 * This runs in the main process on purpose. An earlier version pushed the data
 * into the webview, which silently did nothing whenever the sync fired before
 * the webview existed — which is the normal case on startup.
 */

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]

interface SyncContext {
  /** Base URL of the bundled Open WebUI, or null while it is not running. */
  resolveBaseUrl: () => string | null
  /** Admin token relayed from the Open WebUI page, if one was seen. */
  resolveToken: () => string | null
  listToolTargets: () => ManagedServiceToolTarget[]
  onResult?: (result: OpenWebUISyncResult) => void
}

let context: SyncContext | null = null
let pending: NodeJS.Timeout | null = null
let attempt = 0
let running = false

export const configureOpenWebUISync = (next: SyncContext): void => {
  context = next
}

/**
 * Read the session token from the embedded Open WebUI page when the relay has
 * not delivered one yet. Mirrors the lookup used for voice transcription.
 */
const readTokenFromWebviews = async (): Promise<string> => {
  try {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.getType() !== 'webview' || contents.isDestroyed()) continue
      try {
        const token = await contents.executeJavaScript(`localStorage.getItem('token') || ''`)
        if (token) return token
      } catch {
        // Page not ready or not same-origin — try the next one.
      }
    }
  } catch (error) {
    log.warn('Open WebUI sync — could not read a token from the webviews:', error)
  }
  return ''
}

const readConfig = async (
  baseUrl: string,
  token: string,
  path: string,
  key: string
): Promise<unknown[] | 'forbidden' | 'unauthenticated' | null> => {
  const response = await electronNet.fetch(`${baseUrl}/api/v1/configs/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  })
  // A stale token is worth retrying; a signed-in non-admin is not.
  if (response.status === 401) return 'unauthenticated'
  if (response.status === 403) return 'forbidden'
  if (!response.ok) return null
  const payload = await response.json()
  return Array.isArray(payload?.[key]) ? payload[key] : []
}

const writeConfig = async (
  baseUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>
): Promise<boolean> => {
  const response = await electronNet.fetch(`${baseUrl}/api/v1/configs/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) log.warn(`Open WebUI sync — ${path} write returned ${response.status}`)
  return response.ok
}

/**
 * Remove legacy visible connector defaults and the legacy account-wide cloud
 * workspace declaration from the signed-in user's settings.
 *
 * Open WebUI replaces the whole settings object on write, so the current one is
 * read and merged rather than patched.
 */
const syncUserSettings = async (
  baseUrl: string,
  token: string
): Promise<boolean | 'failed'> => {
  const response = await electronNet.fetch(`${baseUrl}/api/v1/users/user/settings`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    log.warn(`Open WebUI sync — reading user settings returned ${response.status}`)
    return 'failed'
  }

  const settings = ((await response.json()) as Record<string, unknown> | null) ?? {}
  const ui = (settings.ui ?? {}) as Record<string, unknown>

  const currentTools = Array.isArray(ui.tools) ? (ui.tools as string[]) : []
  const nextTools = stripDesktopDefaultTools(currentTools)
  // The cloud workspace is chosen per conversation and travels in the chat
  // request, so an account-wide declaration written by an earlier version is
  // cleaned up here rather than kept in sync.
  const currentSystem = typeof ui.system === 'string' ? ui.system : ''
  const nextSystem = applyCloudWorkspacePrompt(currentSystem, null)

  if (JSON.stringify(currentTools) === JSON.stringify(nextTools) && currentSystem === nextSystem) {
    return false
  }

  const body = {
    ...settings,
    ui: { ...ui, tools: nextTools, system: nextSystem || undefined }
  }
  const write = await electronNet.fetch(`${baseUrl}/api/v1/users/user/settings/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  })
  if (!write.ok) {
    log.warn(`Open WebUI sync — writing user settings returned ${write.status}`)
    return 'failed'
  }
  return true
}

export const syncOpenWebUI = async (
  options: { refreshTerminals?: boolean } = {}
): Promise<OpenWebUISyncResult> => {
  if (!context) return { status: 'skipped', reason: 'not-configured', toolServers: 0, terminals: 0 }

  const baseUrl = context.resolveBaseUrl()
  if (!baseUrl) {
    return { status: 'skipped', reason: 'server-not-running', toolServers: 0, terminals: 0 }
  }

  const token = context.resolveToken() || (await readTokenFromWebviews())
  if (!token) {
    return { status: 'skipped', reason: 'not-signed-in', toolServers: 0, terminals: 0 }
  }

  const toolTargets = context.listToolTargets()
  // A local folder and a mounted GitHub repository are both terminal servers as
  // far as Open WebUI is concerned; only what backs them differs.
  const terminals = [
    ...listWorkspaceTerminals()
      .filter((terminal) => terminal.status === 'started' && terminal.url)
      .map((terminal) => ({
        id: terminal.id,
        cwd: terminal.cwd,
        url: terminal.url,
        apiKey: terminal.apiKey
      })),
    ...listGithubMounts().map((mount) => ({
      id: mount.id,
      cwd: mount.name,
      url: mount.url,
      apiKey: mount.apiKey
    }))
  ]

  const currentTools = await readConfig(baseUrl, token, 'tool_servers', 'TOOL_SERVER_CONNECTIONS')
  if (currentTools === 'forbidden') {
    return { status: 'skipped', reason: 'not-admin', toolServers: 0, terminals: 0 }
  }
  if (currentTools === 'unauthenticated') {
    return { status: 'skipped', reason: 'not-signed-in', toolServers: 0, terminals: 0 }
  }
  if (currentTools === null) {
    return { status: 'failed', reason: 'tool-servers-unreadable', toolServers: 0, terminals: 0 }
  }

  const currentTerminals = await readConfig(
    baseUrl,
    token,
    'terminal_servers',
    'TERMINAL_SERVER_CONNECTIONS'
  )
  if (currentTerminals === 'forbidden') {
    return { status: 'skipped', reason: 'not-admin', toolServers: 0, terminals: 0 }
  }
  if (currentTerminals === 'unauthenticated') {
    return { status: 'skipped', reason: 'not-signed-in', toolServers: 0, terminals: 0 }
  }
  if (currentTerminals === null) {
    return { status: 'failed', reason: 'terminals-unreadable', toolServers: 0, terminals: 0 }
  }

  const nextTools = mergeToolServers(currentTools as ToolServerConnection[], toolTargets)
  const nextTerminals = mergeTerminalServers(
    currentTerminals as TerminalServerConnection[],
    terminals
  )

  // Each write makes the backend refetch every OpenAPI document, so only write
  // when something actually changed.
  let wrote = false
  if (JSON.stringify(currentTools) !== JSON.stringify(nextTools)) {
    if (
      !(await writeConfig(baseUrl, token, 'tool_servers', { TOOL_SERVER_CONNECTIONS: nextTools }))
    )
      return { status: 'failed', reason: 'tool-servers-write', toolServers: 0, terminals: 0 }
    wrote = true
  }
  if (
    shouldWriteTerminalServers(
      currentTerminals as TerminalServerConnection[],
      nextTerminals,
      options.refreshTerminals
    )
  ) {
    if (
      !(await writeConfig(baseUrl, token, 'terminal_servers', {
        TERMINAL_SERVER_CONNECTIONS: nextTerminals
      }))
    )
      return { status: 'failed', reason: 'terminals-write', toolServers: 0, terminals: 0 }
    wrote = true
  }

  // Earlier desktop versions put the always-on connectors into Open WebUI's
  // visible user defaults. Request rewriting now enables them invisibly, so
  // clean those legacy ids out without touching tools chosen by the user.
  const settingsWritten = await syncUserSettings(baseUrl, token)
  if (settingsWritten === 'failed') {
    return { status: 'failed', reason: 'user-settings-write', toolServers: 0, terminals: 0 }
  }
  wrote = wrote || settingsWritten

  return {
    status: wrote ? 'synced' : 'unchanged',
    toolServers: toolTargets.length,
    terminals: terminals.length
  }
}

/**
 * Request a sync. Transient conditions — server still booting, nobody signed in
 * yet — schedule a retry with backoff instead of giving up, because the desktop
 * usually knows about connectors long before Open WebUI is usable.
 */
export const scheduleOpenWebUISync = (reset = true): void => {
  if (reset) attempt = 0
  if (pending) {
    clearTimeout(pending)
    pending = null
  }

  const delay = attempt === 0 ? 500 : RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
  pending = setTimeout(async () => {
    pending = null
    if (running) {
      scheduleOpenWebUISync(false)
      return
    }
    running = true
    let result: OpenWebUISyncResult
    try {
      result = await syncOpenWebUI()
    } catch (error) {
      result = {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        toolServers: 0,
        terminals: 0
      }
    } finally {
      running = false
    }

    const transient =
      result.status === 'failed' ||
      (result.status === 'skipped' &&
        (result.reason === 'server-not-running' || result.reason === 'not-signed-in'))

    if (transient && attempt < RETRY_DELAYS_MS.length) {
      attempt++
      log.info(`Open WebUI sync deferred (${result.reason ?? result.status}); retry ${attempt}`)
      scheduleOpenWebUISync(false)
      return
    }

    attempt = 0
    log.info(
      `Open WebUI sync ${result.status}` +
        (result.reason ? ` (${result.reason})` : '') +
        ` — ${result.toolServers} tool server(s), ${result.terminals} terminal(s)`
    )
    context?.onResult?.(result)
  }, delay)
}

export const cancelOpenWebUISync = (): void => {
  if (pending) clearTimeout(pending)
  pending = null
}
