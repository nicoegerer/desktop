import log from 'electron-log'

import { registerManagedServicesIpc } from './ipc'
import { ManagedServicesManager } from './manager'
import { ManagedServicesRegistry } from './registry'

let manager: ManagedServicesManager | null = null
let initialization: Promise<void> | null = null

export const initializeManagedServices = (): Promise<void> => {
  if (initialization) return initialization

  const registry = new ManagedServicesRegistry()
  manager = new ManagedServicesManager(registry)
  initialization = manager.initialize().catch((error) => {
    log.error('Failed to initialize managed services:', error)
    throw error
  })
  registerManagedServicesIpc(manager, initialization)
  return initialization
}

/**
 * The initialized manager, or null before {@link initializeManagedServices}
 * ran. Used by features that need connector credentials, such as cloning a
 * GitHub repository with the token of the GitHub MCP connector.
 */
export const getManagedServicesManager = (): ManagedServicesManager | null => manager
