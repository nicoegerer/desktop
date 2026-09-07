import { ElectronAPI } from '@electron-toolkit/preload'
import type { DesktopApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    electronAPI: DesktopApi
    api: unknown
  }
}
