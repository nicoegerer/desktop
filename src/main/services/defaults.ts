import { join } from 'path'

import {
  MCPO_API_KEY_PLACEHOLDER,
  type ManagedServiceDefinition
} from '../../shared/services/types'
import {
  OMNIROUTE_HEALTH_CHECK_URL,
  OMNIROUTE_STARTUP_TIMEOUT_MS
} from '../../shared/services/omniroute-defaults'

const DEFAULT_RESTART_LIMIT = 3

const createMcpoArgs = (
  host: string,
  port: number,
  serverCommand: string,
  serverArgs: string[]
): string[] => [
  '--refresh',
  '--with',
  'mcp==1.9.4',
  'mcpo',
  '--host',
  host,
  '--port',
  String(port),
  '--api-key',
  MCPO_API_KEY_PLACEHOLDER,
  '--',
  serverCommand,
  ...serverArgs
]

export const materializeMcpoService = (
  service: ManagedServiceDefinition
): ManagedServiceDefinition => {
  if (service.type !== 'mcpo' || !service.mcpo) return service

  const host = '127.0.0.1'
  return {
    ...service,
    command: service.mcpo.runnerCommand?.trim() || 'uvx',
    args: createMcpoArgs(
      host,
      service.mcpo.port,
      service.mcpo.serverCommand,
      service.mcpo.serverArgs
    ),
    healthCheckUrl: `http://${host}:${service.mcpo.port}/docs`
  }
}

const createOmniRouteDefault = (enabled: boolean): ManagedServiceDefinition => {
  const programFilesPath = process.env.ProgramFiles ?? ''
  const appDataPath = process.env.APPDATA ?? ''

  return {
    id: 'omniroute',
    name: 'OmniRoute',
    type: 'generic',
    command:
      process.platform === 'win32' && programFilesPath
        ? join(programFilesPath, 'nodejs', 'node.exe')
        : 'node',
    args: [
      appDataPath
        ? join(appDataPath, 'npm', 'node_modules', 'omniroute', 'bin', 'omniroute.mjs')
        : 'omniroute',
      'serve',
      '--no-open',
      '--max-restarts',
      '0'
    ],
    enabled: process.platform === 'win32' ? enabled : false,
    healthCheckUrl: OMNIROUTE_HEALTH_CHECK_URL,
    autoRestart: true,
    restartLimit: DEFAULT_RESTART_LIMIT,
    startupTimeoutMs: OMNIROUTE_STARTUP_TIMEOUT_MS
  }
}

export const readLegacyAutostartEnabled = (config: unknown): boolean => {
  if (!config || typeof config !== 'object') return false
  const value = config as Record<string, unknown>
  if (typeof value.startOmniRouteAutomatically === 'boolean') {
    return value.startOmniRouteAutomatically
  }

  const omniRoute = value.omniRoute
  return !!(
    omniRoute &&
    typeof omniRoute === 'object' &&
    (omniRoute as Record<string, unknown>).enabled === true
  )
}

export const createDefaultServices = (legacyEnabled: boolean): ManagedServiceDefinition[] =>
  legacyEnabled ? [createOmniRouteDefault(true)] : []
