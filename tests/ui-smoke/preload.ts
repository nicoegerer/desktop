import { contextBridge, ipcRenderer } from 'electron'

const methods = [
  'listManagedServices',
  'getManagedService',
  'previewManagedService',
  'saveManagedService',
  'removeManagedService',
  'startManagedService',
  'stopManagedService',
  'getManagedServiceLogs',
  'getManagedServiceIntegration',
  'suggestManagedServicePort',
  'exportManagedServices',
  'previewManagedServicesImport',
  'confirmManagedServicesImport',
  'cancelManagedServicesImport',
  'openInBrowser'
]
const api: Record<string, unknown> = Object.fromEntries(
  methods.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke('ui-smoke:mock', method, args)
  ])
)
api.onData = (callback: (event: unknown) => void): (() => void) => {
  const handler = (_event: unknown, data: unknown): void => callback(data)
  ipcRenderer.on('ui-smoke:data', handler)
  return () => ipcRenderer.removeListener('ui-smoke:data', handler)
}
api.workspacePreviewOpen = (request: unknown) =>
  ipcRenderer.invoke('workspace:preview:open', request)
api.workspacePreviewClose = (request: unknown) =>
  ipcRenderer.invoke('workspace:preview:close', request)
api.workspacePreviewGetActive = () => ipcRenderer.invoke('workspace:preview:get-active')
api.uiSmokeSwitchWorkspace = (value: string) => ipcRenderer.invoke('ui-smoke:workspace', value)
contextBridge.exposeInMainWorld('electronAPI', api)
