import type { ManagedServiceSnapshot } from '../../../../../../../shared/services/types'

export type ConnectorSetup = 'github' | 'google' | 'remote' | 'mcpo'
export interface ConnectorCatalogEntry {
  id: string
  name: string
  description: [string, string]
  icon: 'code' | 'mail' | 'folder' | 'calendar' | 'plug' | 'terminal'
  setup: ConnectorSetup
  endpoint?: string
  documentation?: string
  preview?: boolean
}

// Only documented endpoints belong here. Catalog presence never means that an
// account has been authorized, nor does opening a guide create a connection.
export const connectorCatalog: readonly ConnectorCatalogEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    icon: 'code',
    setup: 'github',
    description: [
      'Repositories, Issues und Pull Requests im Chat verwenden.',
      'Use repositories, issues, and pull requests in chat.'
    ],
    endpoint: 'https://api.githubcopilot.com/mcp/',
    documentation: 'https://github.com/github/github-mcp-server'
  },
  {
    id: 'gmail',
    name: 'Gmail',
    icon: 'mail',
    setup: 'google',
    preview: true,
    description: [
      'E-Mails über Googles offiziellen MCP-Server einbinden.',
      'Connect email through Google’s official MCP server.'
    ],
    endpoint: 'https://gmailmcp.googleapis.com/mcp/v1',
    documentation: 'https://developers.google.com/workspace/guides/configure-mcp-servers'
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    icon: 'folder',
    setup: 'google',
    preview: true,
    description: [
      'Dateien suchen und als Kontext für deine Arbeit nutzen.',
      'Find files and use them as context for your work.'
    ],
    endpoint: 'https://drivemcp.googleapis.com/mcp/v1',
    documentation: 'https://developers.google.com/workspace/guides/configure-mcp-servers'
  },
  {
    id: 'google-calendar',
    name: 'Google Kalender',
    icon: 'calendar',
    setup: 'google',
    preview: true,
    description: [
      'Termine und Kalender mit deiner Freigabe einbinden.',
      'Connect events and calendars with your permission.'
    ],
    endpoint: 'https://calendarmcp.googleapis.com/mcp/v1',
    documentation: 'https://developers.google.com/workspace/guides/configure-mcp-servers'
  },
  {
    id: 'custom-remote',
    name: 'Eigene Verbindung',
    icon: 'plug',
    setup: 'remote',
    description: [
      'Einen vorhandenen MCP-Server per URL hinzufügen.',
      'Add an existing MCP server by URL.'
    ]
  },
  {
    id: 'local-mcp',
    name: 'Lokaler Konnektor',
    icon: 'terminal',
    setup: 'mcpo',
    description: [
      'Einen installierten MCP-Server auf diesem Rechner verbinden.',
      'Connect an installed MCP server on this computer.'
    ]
  }
]

export function connectorForService(
  service: Pick<ManagedServiceSnapshot, 'type' | 'remote'>
): ConnectorCatalogEntry | undefined {
  if (service.type !== 'remote' || !service.remote?.url) return undefined
  try {
    const actual = new URL(service.remote.url)
    return connectorCatalog.find((entry) => {
      if (!entry.endpoint) return false
      const expected = new URL(entry.endpoint)
      return (
        actual.protocol === expected.protocol &&
        actual.host === expected.host &&
        actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '')
      )
    })
  } catch {
    return undefined
  }
}

export function searchConnectors(query: string, german: boolean): readonly ConnectorCatalogEntry[] {
  const normalized = query.trim().toLocaleLowerCase()
  return connectorCatalog.filter(
    (entry) =>
      !normalized ||
      `${entry.name} ${entry.description[german ? 0 : 1]}`.toLocaleLowerCase().includes(normalized)
  )
}

export function connectorStatus(
  service: Pick<ManagedServiceSnapshot, 'status' | 'type'>,
  german: boolean
): string {
  const labels = {
    running: service.type === 'remote' ? ['Erreichbar', 'Reachable'] : ['Läuft', 'Running'],
    starting: ['Verbindet …', 'Connecting…'],
    stopped: ['Pausiert', 'Paused'],
    failed: ['Prüfung nötig', 'Needs attention']
  }
  return labels[service.status][german ? 0 : 1]
}
