import { ipcRenderer } from 'electron'

import type {
  ManagedServiceDefinition,
  ManagedServiceImportPreview,
  ManagedServiceIntegration,
  ManagedServiceSnapshot,
  ManagedServiceToolTarget
} from '../shared/services/types'
import { toIpcPlainValue } from './ipc-serialization'

const request = <T>(action: string, payload: Record<string, unknown> = {}): Promise<T> =>
  ipcRenderer.invoke('managed-services:request', toIpcPlainValue({ action, ...payload }))

export const managedServicesApi = {
  listManagedServices: (): Promise<ManagedServiceSnapshot[]> => request('list'),
  getManagedService: (id: string): Promise<ManagedServiceDefinition> => request('get', { id }),
  previewManagedService: (service: unknown): Promise<ManagedServiceDefinition> =>
    request('preview', { service }),
  saveManagedService: (service: ManagedServiceDefinition): Promise<ManagedServiceSnapshot> =>
    request('upsert', { service }),
  removeManagedService: (id: string): Promise<boolean> => request('remove', { id }),
  startManagedService: (id: string): Promise<ManagedServiceSnapshot> => request('start', { id }),
  stopManagedService: (id: string): Promise<ManagedServiceSnapshot> => request('stop', { id }),
  getManagedServiceLogs: (id: string): Promise<string[]> => request('logs', { id }),
  getManagedServiceIntegration: (id: string): Promise<ManagedServiceIntegration> =>
    request('integration', { id }),
  getManagedServiceToolTargets: (): Promise<ManagedServiceToolTarget[]> => request('tool-targets'),
  suggestManagedServicePort: (): Promise<number> => request('suggest-port'),
  exportManagedServices: (): Promise<{ canceled: boolean; filePath?: string }> => request('export'),
  previewManagedServicesImport: (): Promise<ManagedServiceImportPreview | null> =>
    request('import-preview'),
  confirmManagedServicesImport: (token: string): Promise<ManagedServiceSnapshot[]> =>
    request('import-confirm', { token }),
  cancelManagedServicesImport: (token: string): Promise<boolean> =>
    request('import-cancel', { token })
}
