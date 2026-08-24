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

// ─── Default tool selection ─────────────────────────────
//
// Open WebUI selects tools per chat. Without a default, a connector is running
// and registered but stays switched off in every new conversation, which reads
// as "the model has no access". `settings.ui.tools` is the per-user default the
// chat falls back to when a model carries no tool list of its own.

/**
 * The id Open WebUI uses for a registered connector. OpenAPI servers and native
 * MCP servers are addressed differently — see `routers/tools.py`.
 */
export const connectorToolId = (target: Pick<ManagedServiceToolTarget, 'id' | 'kind'>): string => {
  const infoId = toolServerInfoId(target.id)
  return target.kind === 'mcp' ? `server:mcp:${infoId}` : `server:${infoId}`
}

const isDesktopToolId = (id: string): boolean =>
  id.startsWith(`server:${DESKTOP_TOOL_PREFIX}`) || id.startsWith(`server:mcp:${DESKTOP_TOOL_PREFIX}`)

/**
 * Keep every tool the user chose and make the desktop's own connectors default
 * to on. Connectors that are disabled or gone are dropped rather than left
 * behind as ids that resolve to nothing.
 */
export const mergeDefaultTools = (
  current: string[],
  targets: ManagedServiceToolTarget[]
): string[] => {
  const wanted = targets.filter((target) => target.enabled).map(connectorToolId)
  const kept = current.filter((id) => typeof id === 'string' && !isDesktopToolId(id))
  const missing = wanted.filter((id) => !current.includes(id))

  // Preserve the user's ordering; only genuinely new connectors are appended.
  const preserved = current.filter((id) => isDesktopToolId(id) && wanted.includes(id))
  return [...kept, ...preserved, ...missing].filter(
    (id, index, all) => all.indexOf(id) === index
  )
}

// ─── Cloud workspace prompt ─────────────────────────────

export const CLOUD_WORKSPACE_MARKER_START = '<!-- open-webui-desktop:cloud-workspace -->'
export const CLOUD_WORKSPACE_MARKER_END = '<!-- /open-webui-desktop:cloud-workspace -->'

export interface CloudWorkspace {
  repoFullName: string
  branch: string
}

const cloudWorkspaceBlock = (workspace: CloudWorkspace): string =>
  [
    CLOUD_WORKSPACE_MARKER_START,
    `The active workspace is the GitHub repository \`${workspace.repoFullName}\` on branch \`${workspace.branch}\`.`,
    'Work in it through the GitHub tools: read files with the repository content tools and write',
    'changes by committing to that branch. There is no local checkout of this repository, so do',
    'not look for its files on disk and do not run git against it in a terminal.',
    CLOUD_WORKSPACE_MARKER_END
  ].join('\n')

/**
 * Declare the cloud workspace in the user's system prompt without disturbing
 * anything they wrote themselves; the block is delimited so it can be replaced
 * or removed on the next change.
 */
export const applyCloudWorkspacePrompt = (
  system: string,
  workspace: CloudWorkspace | null
): string => {
  const source = typeof system === 'string' ? system : ''
  const start = source.indexOf(CLOUD_WORKSPACE_MARKER_START)
  const endMarker = source.indexOf(CLOUD_WORKSPACE_MARKER_END)
  const end = endMarker === -1 ? -1 : endMarker + CLOUD_WORKSPACE_MARKER_END.length

  const before = start === -1 ? source : source.slice(0, start)
  const after = start === -1 || end === -1 ? '' : source.slice(end)
  const userText = start === -1 ? source : `${before.trimEnd()}\n${after.trimStart()}`.trim()

  if (!workspace) return userText
  return userText ? `${userText}\n\n${cloudWorkspaceBlock(workspace)}` : cloudWorkspaceBlock(workspace)
}

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
  /** Shown in the chat's terminal menu; defaults to the folder name. */
  name?: string
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
    merged.push(terminalEntry(terminal, entry, terminal.name || workspaceDisplayName(terminal.cwd)))
    applied.add(id)
  }

  for (const [id, terminal] of managed) {
    if (!applied.has(id)) {
      merged.push(terminalEntry(terminal, null, terminal.name || workspaceDisplayName(terminal.cwd)))
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
