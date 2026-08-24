import http from 'http'
import https from 'https'
import net from 'net'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs))

export const getPortFromService = (healthCheckUrl?: string, mcpoPort?: number): number | null => {
  if (mcpoPort) return mcpoPort
  if (!healthCheckUrl) return null
  try {
    const url = new URL(healthCheckUrl)
    if (url.port) return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

export const assertLocalHealthCheckUrl = (value: string): string => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('Health-check URLs must use HTTP(S) on localhost')
  }
  return url.toString()
}

export const assertRemoteEndpointUrl = (value: string): string => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Remote endpoints must use HTTP(S)')
  }
  if (url.username || url.password) {
    throw new Error('Store access tokens separately instead of embedding credentials in the URL')
  }
  return url.toString()
}

export const isPortInUse = (port: number, timeoutMs = 500): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })

export const isHealthCheckReady = (healthCheckUrl: string, timeoutMs = 2_000): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      const url = new URL(healthCheckUrl)
      const client = url.protocol === 'https:' ? https : http
      const request = client.get(url, (response) => {
        request.setTimeout(0)
        response.on('error', () => finish(false))
        response.resume()
        finish(response.statusCode !== undefined && response.statusCode < 500)
      })
      request.setTimeout(timeoutMs)
      request.once('error', () => finish(false))
      request.once('timeout', () => {
        request.destroy()
        finish(false)
      })
    } catch {
      finish(false)
    }
  })

export const waitForPortToClose = async (port: number, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true
    await delay(150)
  }
  return !(await isPortInUse(port))
}

/**
 * Decide whether the process already listening on an mcpo port is one of ours.
 *
 * mcpo protects its OpenAPI document with the bearer key we generated, so a
 * document that accepts that key can only be an mcpo started with it — an
 * instance orphaned by a crash or a forced restart. Adopting it is safe and
 * beats refusing to start because the port looks busy.
 */
export const isManagedMcpoOnPort = (
  healthCheckUrl: string,
  apiKey: string,
  timeoutMs = 2_000
): Promise<boolean> =>
  new Promise((resolve) => {
    if (!apiKey) {
      resolve(false)
      return
    }

    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      const url = new URL(healthCheckUrl)
      url.pathname = '/openapi.json'
      url.search = ''
      const client = url.protocol === 'https:' ? https : http
      const request = client.get(
        url,
        { headers: { Authorization: `Bearer ${apiKey}` } },
        (response) => {
          request.setTimeout(0)
          response.on('error', () => finish(false))
          response.resume()
          finish(response.statusCode === 200)
        }
      )
      request.setTimeout(timeoutMs)
      request.once('error', () => finish(false))
      request.once('timeout', () => {
        request.destroy()
        finish(false)
      })
    } catch {
      finish(false)
    }
  })
