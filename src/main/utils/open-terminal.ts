// @ts-nocheck

import crypto from 'crypto'
import os from 'os'
import log from 'electron-log'
import { safeStorage } from 'electron'
import * as pty from 'node-pty'
import {
  getPythonPath,
  getConfig,
  setConfig,
  installPackage,
  isPackageInstalled,
  isPythonInstalled,
  installPython,
  portInUse
} from './index'
import { isProcessAlive } from './service-lock'
import type { WorkspaceTerminal } from '../../shared/services/types'

// ─── State ──────────────────────────────────────────────
//
// Open Terminal is started once per workspace so a chat can pick which folder
// it works in. Open WebUI selects a terminal per conversation, so a single
// shared instance would force every chat into the same working directory.

const HOST = '127.0.0.1'
const BASE_PORT = 39284
const READY_POLL_MS = 500
const READY_TIMEOUT_MS = 60_000

interface TerminalInstance {
  id: string
  cwd: string
  port: number
  url: string | null
  apiKey: string | null
  pid: number | null
  status: string | null // starting | started | stopped | failed
  pty: pty.IPty | null
  logBuffer: string[]
}

const instances = new Map<string, TerminalInstance>()
const startsInFlight = new Map<string, Promise<TerminalInstance>>()
let activeKey: string | null = null

const comparableCwd = (value: string): string => {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Stable id for a workspace folder; used as the Open WebUI terminal id. */
export const workspaceTerminalId = (cwd: string): string =>
  `desktop-ws-${crypto.createHash('sha256').update(comparableCwd(cwd)).digest('hex').slice(0, 12)}`

const publicView = (instance: TerminalInstance): WorkspaceTerminal => ({
  id: instance.id,
  cwd: instance.cwd,
  workingDirectory: instance.cwd,
  port: instance.port,
  url: instance.url,
  apiKey: instance.apiKey,
  pid: instance.pid,
  status: instance.status
})

// ─── Shared API key ─────────────────────────────────────
//
// Every workspace instance shares one loopback key. The key is supplied through
// the environment so it never appears in logs or process arguments.

const resolveApiKey = async (): Promise<string> => {
  const config = await getConfig()
  const encryptedKey = config.openTerminal?.apiKeyEncrypted
  let generatedKey = config.openTerminal?.apiKey || ''

  if (encryptedKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('The saved Open Terminal key cannot be decrypted on this system.')
    }
    try {
      generatedKey = safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
    } catch (error) {
      throw new Error(`The saved Open Terminal key is invalid: ${error?.message ?? error}`)
    }
  }
  if (!generatedKey) generatedKey = crypto.randomBytes(24).toString('base64url')

  if (safeStorage.isEncryptionAvailable()) {
    const { apiKey: _legacyApiKey, ...openTerminalConfig } = config.openTerminal ?? {}
    if (!encryptedKey || config.openTerminal?.apiKey) {
      await setConfig({
        openTerminal: {
          ...openTerminalConfig,
          apiKeyEncrypted: safeStorage.encryptString(generatedKey).toString('base64')
        }
      })
    }
  } else if (!config.openTerminal?.apiKey) {
    await setConfig({ openTerminal: { ...config.openTerminal, apiKey: generatedKey } })
  }

  return generatedKey
}

const findFreePort = async (preferred: number): Promise<number> => {
  const taken = new Set(
    [...instances.values()]
      .filter((entry) => entry.status === 'started' || entry.status === 'starting')
      .map((entry) => entry.port)
  )
  let candidate = preferred
  while (taken.has(candidate) || (await portInUse(candidate, HOST))) {
    candidate++
    if (candidate > preferred + 200) throw new Error('No available port found for Open Terminal')
  }
  return candidate
}

const ensureRuntime = async (onStatus?: (status: string) => void): Promise<void> => {
  if (!isPythonInstalled()) {
    log.info('Python not installed — installing automatically for Open Terminal…')
    onStatus?.('Installing Python…')
    try {
      const ok = await installPython(undefined, onStatus)
      if (!ok) throw new Error('Python installation returned false')
    } catch (err) {
      throw new Error(
        `Python is required for Open Terminal but installation failed: ${err?.message ?? err}`
      )
    }
    if (!isPythonInstalled()) {
      throw new Error(
        'Python was installed but could not be verified. Please restart the app and try again.'
      )
    }
  }

  if (!isPackageInstalled('open-terminal')) {
    log.info('open-terminal not installed, attempting install...')
    onStatus?.('Installing Open Terminal package…')
    try {
      await installPackage('open-terminal')
    } catch (err) {
      throw new Error(
        `Open Terminal is not installed and auto-install failed. ` +
          `Please connect to the internet and try again. (${err?.message ?? err})`
      )
    }
  }
}

// ─── Workspace instances ────────────────────────────────

export const listWorkspaceTerminals = (): WorkspaceTerminal[] =>
  [...instances.values()].map(publicView)

export const getWorkspaceTerminal = (cwd: string): WorkspaceTerminal | null => {
  const instance = instances.get(comparableCwd(cwd))
  return instance ? publicView(instance) : null
}

export const getActiveWorkspaceTerminal = (): WorkspaceTerminal | null => {
  const instance = activeKey ? instances.get(activeKey) : null
  return instance ? publicView(instance) : null
}

export const setActiveWorkspaceTerminal = (cwd: string): boolean => {
  const key = comparableCwd(cwd)
  if (!instances.has(key)) return false
  activeKey = key
  return true
}

/**
 * Start Open Terminal for a workspace folder, or return the running instance.
 * Concurrent calls for the same folder share one start.
 */
export const startWorkspaceTerminal = async (
  cwd: string,
  onStatus?: (status: string) => void
): Promise<WorkspaceTerminal> => {
  const workspacePath = String(cwd ?? '').trim()
  if (!workspacePath) throw new Error('A workspace folder is required')
  const key = comparableCwd(workspacePath)

  const running = instances.get(key)
  if (running && running.status === 'started' && isProcessAlive(running.pid)) {
    activeKey = key
    return publicView(running)
  }

  const inFlight = startsInFlight.get(key)
  if (inFlight) return publicView(await inFlight)

  const start = (async (): Promise<TerminalInstance> => {
    await ensureRuntime(onStatus)

    const apiKey = await resolveApiKey()
    const config = await getConfig()
    const configEnvVars = config.envVars ?? {}
    const port = await findFreePort(config.openTerminal?.port || BASE_PORT)
    const pythonPath = getPythonPath()

    const commandArgs = [
      '-m',
      'uv',
      'run',
      'open-terminal',
      'run',
      '--host',
      HOST,
      '--port',
      port.toString(),
      '--cwd',
      workspacePath
    ]

    log.info(`Starting Open Terminal for ${workspacePath}`, pythonPath, commandArgs.join(' '))

    let spawned: pty.IPty
    try {
      spawned = pty.spawn(pythonPath, commandArgs, {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        env: {
          ...process.env,
          ...(configEnvVars ?? {}),
          OPEN_TERMINAL_API_KEY: apiKey,
          OPEN_TERMINAL_FILE_BROWSER_ROOT: workspacePath,
          PYTHONUNBUFFERED: '1',
          ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'utf-8' } : {})
        }
      })
    } catch (error) {
      throw new Error(`Failed to spawn Open Terminal: ${error?.message ?? error}`)
    }

    const instance: TerminalInstance = {
      id: workspaceTerminalId(workspacePath),
      cwd: workspacePath,
      port,
      url: `http://${HOST}:${port}`,
      apiKey,
      pid: spawned.pid,
      status: 'starting',
      pty: spawned,
      logBuffer: []
    }
    instances.set(key, instance)
    activeKey = key

    spawned.onData((data: string) => {
      instance.logBuffer.push(data)
      if (instance.logBuffer.length > 2000) instance.logBuffer.shift()
      log.info(`[OpenTerminal:${instance.pid}] ${data.replace(/[\r\n]+/g, ' ').trim()}`)
    })

    spawned.onExit(({ exitCode, signal }) => {
      log.info(`[OpenTerminal:${instance.pid}] Exited code=${exitCode} signal=${signal}`)
      instance.pty = null
      instance.pid = null
      instance.url = null
      instance.status = 'stopped'
    })

    // Report "started" only once the port answers. The workspace is registered
    // in Open WebUI right after this, and an endpoint that is not listening yet
    // would be registered as a dead terminal.
    onStatus?.('Waiting for Open Terminal…')
    for (let waited = 0; waited < READY_TIMEOUT_MS; waited += READY_POLL_MS) {
      if (instance.status === 'stopped') throw new Error('Open Terminal exited during startup')
      if (await portInUse(port, HOST)) {
        instance.status = 'started'
        log.info(`Open Terminal started — PID: ${instance.pid}, URL: ${instance.url}`)
        return instance
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }

    throw new Error(`Open Terminal did not answer on port ${port} in time`)
  })()

  startsInFlight.set(key, start)
  try {
    return publicView(await start)
  } catch (error) {
    // A half-started instance would keep its port reserved and be registered as
    // a dead terminal, so drop it before rethrowing.
    await stopWorkspaceTerminal(workspacePath)
    throw error
  } finally {
    startsInFlight.delete(key)
  }
}

export const stopWorkspaceTerminal = async (cwd: string): Promise<boolean> => {
  const key = comparableCwd(cwd)
  const instance = instances.get(key)
  if (!instance) return false

  if (instance.pty) {
    try {
      instance.pty.kill()
    } catch (e) {
      log.warn('Failed to kill Open Terminal PTY:', e)
    }
    await new Promise((r) => setTimeout(r, 1000))
    if (instance.pid) {
      try {
        process.kill(instance.pid, 0)
        process.kill(instance.pid, 'SIGKILL')
      } catch {
        // already dead
      }
    }
  }

  instances.delete(key)
  if (activeKey === key) {
    const next = [...instances.values()].find((entry) => entry.status === 'started')
    activeKey = next ? comparableCwd(next.cwd) : null
  }
  return true
}

export const stopAllWorkspaceTerminals = async (): Promise<void> => {
  for (const instance of [...instances.values()]) {
    await stopWorkspaceTerminal(instance.cwd)
  }
  activeKey = null
}

/** Drop instances whose process died outside the app. */
export const validateWorkspaceTerminals = (): boolean => {
  let anyAlive = false
  for (const [key, instance] of [...instances.entries()]) {
    if (instance.pid && isProcessAlive(instance.pid)) {
      anyAlive = true
      continue
    }
    instance.pty = null
    instance.pid = null
    instance.url = null
    instance.status = 'stopped'
    instances.delete(key)
    if (activeKey === key) activeKey = null
  }
  return anyAlive
}

// ─── Active-instance API ────────────────────────────────
//
// The status bar, log panel, and embedded terminal act on one instance at a
// time. They keep their existing shape and follow the active workspace.

export const getOpenTerminalInfo = (): WorkspaceTerminal => {
  const active = getActiveWorkspaceTerminal()
  return (
    active ?? {
      id: null,
      cwd: null,
      workingDirectory: null,
      port: null,
      url: null,
      apiKey: null,
      pid: null,
      status: null
    }
  )
}

export const getOpenTerminalPty = (): pty.IPty | null =>
  (activeKey ? instances.get(activeKey)?.pty : null) ?? null

export const getOpenTerminalLog = (): string[] =>
  (activeKey ? instances.get(activeKey)?.logBuffer : null) ?? []

export const startOpenTerminal = async (
  onStatus?: (status: string) => void
): Promise<WorkspaceTerminal> => {
  const config = await getConfig()
  const cwd = config.openTerminal?.cwd || os.homedir()
  return startWorkspaceTerminal(cwd, onStatus)
}

export const stopOpenTerminal = async (): Promise<void> => {
  const active = activeKey ? instances.get(activeKey) : null
  if (active) await stopWorkspaceTerminal(active.cwd)
}

export const validateOpenTerminalProcess = (): boolean => validateWorkspaceTerminals()
