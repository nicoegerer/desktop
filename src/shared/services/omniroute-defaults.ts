export const OMNIROUTE_HEALTH_CHECK_URL = 'http://127.0.0.1:20128/api/health/ping'
export const OMNIROUTE_STARTUP_TIMEOUT_MS = 300_000

const LEGACY_OMNIROUTE_HEALTH_CHECK_URLS = new Set([
  'http://127.0.0.1:20128/v1/models',
  'http://localhost:20128/v1/models',
  'http://127.0.0.1:20128/api/monitoring/health',
  'http://localhost:20128/api/monitoring/health'
])

interface OmniRouteDefaults {
  id: string
  healthCheckUrl?: string
  startupTimeoutMs: number
}

export const migrateOmniRouteDefaults = <T extends OmniRouteDefaults>(service: T): T => {
  if (service.id !== 'omniroute') return service

  const shouldMigrateHealthCheck =
    !service.healthCheckUrl || LEGACY_OMNIROUTE_HEALTH_CHECK_URLS.has(service.healthCheckUrl)
  const healthCheckUrl = shouldMigrateHealthCheck
    ? OMNIROUTE_HEALTH_CHECK_URL
    : service.healthCheckUrl
  const startupTimeoutMs = Math.max(service.startupTimeoutMs, OMNIROUTE_STARTUP_TIMEOUT_MS)

  if (healthCheckUrl === service.healthCheckUrl && startupTimeoutMs === service.startupTimeoutMs) {
    return service
  }

  return { ...service, healthCheckUrl, startupTimeoutMs }
}
