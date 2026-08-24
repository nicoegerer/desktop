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
