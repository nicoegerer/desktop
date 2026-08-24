import type { ManagedServiceToolTarget } from './types'

/**
 * Prefix that marks a `TOOL_SERVER_CONNECTIONS` entry as owned by the desktop
 * registry. Entries without it were added by hand in Open WebUI and are never
 * modified or removed by a sync.
 */
export const DESKTOP_TOOL_PREFIX = 'desktop-'

/** Open WebUI keeps extra keys on these entries, so unknown fields are preserved. */
export interface ToolServerConnection {
  type?: string
  url?: string
  spec_type?: string
  spec?: string
  path?: string
  auth_type?: string
  key?: string
  config?: {
    enable?: boolean
    function_name_filter_list?: unknown
    access_grants?: unknown[]
    [key: string]: unknown
  }
  info?: { id?: string; name?: string; description?: string; [key: string]: unknown }
  [key: string]: unknown
}

export const toolServerInfoId = (serviceId: string): string =>
  `${DESKTOP_TOOL_PREFIX}${serviceId}`

/** A workspace terminal as Open WebUI stores it under `terminal_server.connections`. */
export interface TerminalServerConnection {
  id?: string
  name?: string
  enabled?: boolean
  url?: string
  path?: string
  key?: string
  auth_type?: string
  config?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface WorkspaceTerminalTarget {
  id: string
  cwd: string
  url: string | null
  apiKey: string | null
}

const terminalEntry = (
  terminal: WorkspaceTerminalTarget,
  existing: TerminalServerConnection | null,
  name: string
): TerminalServerConnection => ({
  ...(existing ?? {}),
  id: terminal.id,
  name,
  enabled: true,
  url: terminal.url ?? '',
  path: '/openapi.json',
  key: terminal.apiKey ?? '',
  auth_type: 'bearer',
  config: existing?.config ?? null
})

export const workspaceDisplayName = (cwd: string): string =>
  cwd
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || cwd

/**
 * Replace desktop-owned terminals and keep everything else.
 *
 * Entries without an id that point at a loopback address are dropped: earlier
 * versions registered the workspace that way, and Open WebUI hides id-less
 * system terminals from the chat, so they are invisible clutter that can be
 * neither selected nor removed from the desktop app.
 */
export const mergeTerminalServers = (
  current: TerminalServerConnection[],
  terminals: WorkspaceTerminalTarget[]
): TerminalServerConnection[] => {
  const managed = new Map(terminals.map((terminal) => [terminal.id, terminal]))
  const merged: TerminalServerConnection[] = []
  const applied = new Set<string>()

  for (const entry of current) {
    const id = typeof entry?.id === 'string' ? entry.id : ''

    if (!id) {
      const url = typeof entry?.url === 'string' ? entry.url : ''
      if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(url)) continue
      merged.push(entry)
      continue
    }

    if (!id.startsWith(DESKTOP_TOOL_PREFIX)) {
      merged.push(entry)
      continue
    }

    const terminal = managed.get(id)
    if (!terminal) continue // workspace was closed in the desktop app
    merged.push(terminalEntry(terminal, entry, workspaceDisplayName(terminal.cwd)))
    applied.add(id)
  }

  for (const [id, terminal] of managed) {
    if (!applied.has(id)) {
      merged.push(terminalEntry(terminal, null, workspaceDisplayName(terminal.cwd)))
    }
  }

  return merged
}

/**
 * Build the Open WebUI entry for a connector. Mirrors the payload that
 * `AddToolServerModal` writes, so a synced entry is indistinguishable from a
 * hand-added one and stays editable in Admin Settings → Integrations.
 */
export const toolServerEntry = (
  target: ManagedServiceToolTarget,
  existing: ToolServerConnection | null
): ToolServerConnection => ({
  ...(existing ?? {}),
  type: target.kind,
  url: target.url,
  spec_type: 'url',
  spec: existing?.spec ?? '',
  path: target.kind === 'openapi' ? target.path || 'openapi.json' : (existing?.path ?? ''),
  auth_type: target.key ? 'bearer' : 'none',
  key: target.key,
  config: {
    enable: target.enabled,
    function_name_filter_list: existing?.config?.function_name_filter_list ?? '',
    access_grants: existing?.config?.access_grants ?? []
  },
  info: {
    ...(existing?.info ?? {}),
    id: toolServerInfoId(target.id),
    name: target.name,
    description: existing?.info?.description ?? ''
  }
})

/**
 * Replace every desktop-owned entry while leaving connections that were added
 * by hand in Open WebUI untouched. Entries are matched on `info.id`; a
 * connector missing from `targets` was removed in the desktop registry and is
 * dropped here too.
 */
export const mergeToolServers = (
  current: ToolServerConnection[],
  targets: ManagedServiceToolTarget[]
): ToolServerConnection[] => {
  const managed = new Map(targets.map((target) => [toolServerInfoId(target.id), target]))
  const merged: ToolServerConnection[] = []
  const applied = new Set<string>()

  for (const entry of current) {
    const infoId = typeof entry?.info?.id === 'string' ? entry.info.id : ''
    if (!infoId.startsWith(DESKTOP_TOOL_PREFIX)) {
      merged.push(entry)
      continue
    }
    const target = managed.get(infoId)
    if (!target) continue
    merged.push(toolServerEntry(target, entry))
    applied.add(infoId)
  }

  for (const [infoId, target] of managed) {
    if (!applied.has(infoId)) merged.push(toolServerEntry(target, null))
  }

  return merged
}
