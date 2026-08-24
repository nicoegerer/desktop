import { ipcRenderer, contextBridge } from 'electron'

import type {
  ManagedServiceToolTarget,
  ToolServerSyncResult
} from '../shared/services/types'
import { mergeToolServers, type ToolServerConnection } from '../shared/services/tool-servers'

// ─── Desktop ↔ Open WebUI Generic Protocol ──────────────
// This preload is a relay. It passes typed {type, data}
// messages between the embedder (desktop renderer) and the
// Open WebUI page. Business logic lives elsewhere, except for
// events Open WebUI itself has no handler for — see the
// connector sync below.

type EventCallback = (data: any) => void
const eventCallbacks: EventCallback[] = []
const pendingEvents: any[] = []
const MAX_PENDING_EVENTS = 50

// ─── Connector → Tool-server sync ───────────────────────
// Exception to the relay rule above: Open WebUI has no page-level handler for
// desktop connectors, so the registry writes TOOL_SERVER_CONNECTIONS itself.
// The preload shares the guest origin, so it reaches the admin API with the
// session token already present in the page.

// The desktop pushes connectors as soon as a connection opens, which is often
// before the user signed in. Wait out a normal sign-in rather than dropping the
// registration and leaving the chat without tools.
const TOKEN_POLL_INTERVAL_MS = 1500
const TOKEN_POLL_ATTEMPTS = 120

// Only the newest push matters; an older one still waiting for sign-in would
// otherwise write a stale connector list.
let syncGeneration = 0

const readToken = (): string => {
  try {
    return window.localStorage.getItem('token') ?? ''
  } catch {
    return ''
  }
}

const awaitToken = async (generation: number): Promise<string> => {
  for (let attempt = 0; attempt < TOKEN_POLL_ATTEMPTS; attempt++) {
    if (generation !== syncGeneration) return '' // superseded by a newer push
    const token = readToken()
    if (token) return token
    await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_INTERVAL_MS))
  }
  return ''
}

const syncToolServers = async (targets: ManagedServiceToolTarget[], generation: number): Promise<ToolServerSyncResult> => {
  const base = window.location.origin
  const token = await awaitToken(generation)
  if (generation !== syncGeneration) return { status: 'skipped', reason: 'superseded', count: 0 }
  if (!token) return { status: 'skipped', reason: 'not-signed-in', count: 0 }

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  const currentResponse = await fetch(`${base}/api/v1/configs/tool_servers`, { headers })
  if (currentResponse.status === 401 || currentResponse.status === 403) {
    return { status: 'skipped', reason: 'not-admin', count: 0 }
  }
  if (!currentResponse.ok) {
    return { status: 'failed', reason: `read-${currentResponse.status}`, count: 0 }
  }

  const payload = await currentResponse.json()
  const current: ToolServerConnection[] = Array.isArray(payload?.TOOL_SERVER_CONNECTIONS)
    ? payload.TOOL_SERVER_CONNECTIONS
    : []
  const next = mergeToolServers(current, targets)

  // Every POST makes the backend refetch each OpenAPI document, so only write
  // when something actually changed.
  if (JSON.stringify(current) === JSON.stringify(next)) {
    return { status: 'unchanged', count: targets.length }
  }

  const writeResponse = await fetch(`${base}/api/v1/configs/tool_servers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ TOOL_SERVER_CONNECTIONS: next })
  })
  if (!writeResponse.ok) {
    return { status: 'failed', reason: `write-${writeResponse.status}`, count: 0 }
  }

  return { status: 'synced', count: targets.length }
}

const handleToolServerEvent = async (data: { targets?: ManagedServiceToolTarget[] }): Promise<void> => {
  const targets: ManagedServiceToolTarget[] = Array.isArray(data?.targets) ? data.targets : []
  const generation = ++syncGeneration

  let result: ToolServerSyncResult
  try {
    result = await syncToolServers(targets, generation)
  } catch (error) {
    result = {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      count: 0
    }
  }
  if (generation !== syncGeneration) return
  ipcRenderer.sendToHost('webview:event', { type: 'connections:tools:result', data: result })
}

// Embedder → Guest (push events from desktop)
ipcRenderer.on('desktop:event', (_event, data) => {
  if (data?.type === 'connections:tools') {
    void handleToolServerEvent(data.data)
    return
  }

  if (eventCallbacks.length === 0) {
    pendingEvents.push(data)
    if (pendingEvents.length > MAX_PENDING_EVENTS) pendingEvents.shift()
    return
  }
  eventCallbacks.forEach((cb) => cb(data))
})

// ─── Theme Sync: Open WebUI → Desktop ───────────────────
// Open WebUI calls window.applyTheme() after every theme change.
// We inject this hook so the desktop shell can mirror the theme.
contextBridge.exposeInMainWorld('applyTheme', () => {
  const theme = localStorage.getItem('theme') ?? 'system'
  ipcRenderer.sendToHost('webview:event', { type: 'theme:update', data: { theme } })
})

// Expose to the Open WebUI page via contextBridge (secure, unforgeable)
contextBridge.exposeInMainWorld('electronAPI', {
  // Push events: desktop → Open WebUI
  onEvent: (callback: EventCallback): void => {
    eventCallbacks.push(callback)
    const queued = pendingEvents.splice(0)
    queued.forEach((event) => callback(event))
  },

  // Request/Response: Open WebUI → desktop
  send: (data: any): Promise<any> => {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2)
      const handler = (_event: any, response: any) => {
        if (response?._responseId === id) {
          ipcRenderer.removeListener('desktop:response', handler)
          resolve(response.data)
        }
      }
      ipcRenderer.on('desktop:response', handler)
      ipcRenderer.sendToHost('webview:send', { ...data, _requestId: id })
    })
  },

  // Navigation: Open WebUI → desktop
  load: (page: string): void => {
    ipcRenderer.sendToHost('webview:load', page)
  }
})
