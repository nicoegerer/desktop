import { app, BrowserWindow, ipcMain, session } from 'electron'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ManagedServiceDefinition,
  ManagedServiceSnapshot
} from '../../src/shared/services/types'
import {
  WorkspacePreviewError,
  WorkspacePreviewManager
} from '../../src/main/services/workspace-preview'
import { createWorkspacePreviewHandlers } from '../../src/main/services/workspace-preview-ipc'
import {
  getWorkspacePreviewRequestHeaders,
  isWorkspacePreviewNavigationAllowed
} from '../../src/shared/workspace-preview'

const directory = path.resolve(__dirname, '..')
const profile = mkdtempSync(path.join(os.tmpdir(), 'open-webui-ui-smoke-'))
app.setPath('userData', profile)
app.setPath('sessionData', path.join(profile, 'session'))
app.setName('Open WebUI – UI Test')
app.commandLine.appendSwitch('lang', 'de-DE')
app.commandLine.appendSwitch('disable-gpu')
let window: BrowserWindow | null = null
let selected = 'a'
const manager = new WorkspacePreviewManager()
const terminals = ['a', 'b'].map((key) => ({
  id: `smoke-${key}`,
  cwd: path.join(directory, 'fixtures', `workspace-${key}`)
}))
const trusted = (input: unknown): boolean => {
  const event = input as { sender?: unknown; senderFrame?: unknown } | null
  return Boolean(
    window &&
    event?.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame
  )
}
const preview = createWorkspacePreviewHandlers({
  manager,
  listTerminals: () => terminals.filter((entry) => entry.id === `smoke-${selected}`),
  isTrustedSender: trusted,
  describeError: (error) =>
    error instanceof WorkspacePreviewError
      ? { ok: false, code: error.code, error: error.message }
      : { ok: false, code: 'PREVIEW_START_FAILED', error: 'Test preview failed.' }
})
const defaults = {
  args: [],
  enabled: true,
  autoRestart: true,
  restartLimit: 3,
  startupTimeoutMs: 120000,
  restartCount: 0,
  env: {}
}
let services: ManagedServiceSnapshot[] = [
  {
    ...defaults,
    id: 'smoke-omniroute',
    name: 'OmniRoute',
    type: 'generic',
    command: 'demo-only',
    status: 'running'
  },
  {
    ...defaults,
    id: 'smoke-garmin',
    name: 'Garmin',
    type: 'mcpo',
    command: 'demo-only',
    status: 'running',
    mcpo: { serverCommand: 'demo-only', serverArgs: [], port: 43201 }
  },
  {
    ...defaults,
    id: 'smoke-github',
    name: 'GitHub MCP',
    type: 'remote',
    command: '',
    status: 'stopped',
    enabled: false,
    remote: { url: 'https://api.githubcopilot.com/mcp/' }
  }
]
const publish = (): void =>
  window?.webContents.send('ui-smoke:data', { type: 'managed-services:changed', data: services })
ipcMain.handle('ui-smoke:mock', (event, method: string, args: unknown[]) => {
  if (!trusted(event)) throw new Error('Untrusted test frame')
  const service = services.find((entry) => entry.id === args?.[0])
  switch (method) {
    case 'listManagedServices':
      return services
    case 'getManagedService':
      if (!service) throw new Error('Unknown test connector')
      return service
    case 'previewManagedService':
      return args[0]
    case 'saveManagedService': {
      if (!args[0] || typeof args[0] !== 'object') throw new Error('Invalid test connector')
      const draft = args[0] as ManagedServiceDefinition
      const saved: ManagedServiceSnapshot = {
        ...draft,
        id: draft.id || `smoke-added-${services.length}`,
        status: 'stopped',
        restartCount: 0
      }
      services = [...services.filter((entry) => entry.id !== saved.id), saved]
      publish()
      return saved
    }
    case 'startManagedService':
    case 'stopManagedService': {
      if (!service) throw new Error('Unknown test connector')
      Object.assign(service, {
        status: method === 'startManagedService' ? 'running' : 'stopped',
        enabled: method === 'startManagedService'
      })
      publish()
      return service
    }
    case 'removeManagedService':
      services = services.filter((entry) => entry.id !== args[0])
      publish()
      return true
    case 'getManagedServiceLogs':
      return ['[UI TEST] Synthetic connector. No process or account is connected.']
    case 'getManagedServiceIntegration':
      return {
        url: service?.remote?.url || 'http://127.0.0.1:43201',
        bearerKey: '',
        commandPreview: 'UI test only — no command executed'
      }
    case 'suggestManagedServicePort':
      return 43202
    case 'exportManagedServices':
      return { canceled: true }
    case 'previewManagedServicesImport':
      return null
    case 'confirmManagedServicesImport':
      return services
    case 'cancelManagedServicesImport':
      return true
    case 'openInBrowser':
      window?.webContents.send('ui-smoke:data', {
        type: 'ui-smoke:notice',
        data: `Externer Link im Test nicht geöffnet: ${args[0]}`
      })
      return true
    default:
      throw new Error('Unknown test-only operation')
  }
})
ipcMain.handle('workspace:preview:open', preview.open)
ipcMain.handle('workspace:preview:close', preview.close)
ipcMain.handle('workspace:preview:get-active', preview.getActive)
ipcMain.handle('ui-smoke:workspace', async (event, value) => {
  if (!trusted(event) || !['a', 'b'].includes(value)) throw new Error('Unknown test workspace')
  await preview.closeAll()
  selected = value
  return true
})

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders:
        window && details.webContentsId === window.webContents.id
          ? getWorkspacePreviewRequestHeaders(
              details.url,
              manager.getActive()?.url,
              details.requestHeaders
            )
          : details.requestHeaders
    })
  })
  window = new BrowserWindow({
    width: 1360,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    show: true,
    title: 'Open WebUI – UI Test',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-frame-navigate', (event) => {
    if (
      !event.isMainFrame &&
      !isWorkspacePreviewNavigationAllowed(event.url, manager.getActive()?.url)
    )
      event.preventDefault()
  })
  window.webContents.on('render-process-gone', (_event, details) =>
    console.error('UI test renderer exited:', details.reason)
  )
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) console.error('UI test load failed:', code, description)
  })
  window.webContents.on('did-finish-load', () => console.log('UI_TEST_DID_FINISH_LOAD'))
  window.once('ready-to-show', () => window?.show())
  await window.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  window.show()
  window.focus()
  console.log(
    `UI_TEST_READY: title=${window.getTitle()}; visible=${window.isVisible()}; minimized=${window.isMinimized()}; synthetic fixtures only.`
  )
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  void preview.closeAll()
})
