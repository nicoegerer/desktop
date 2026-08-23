/**
 * Electron contextBridge and IPC cannot structured-clone Svelte 5 state proxies.
 * Managed-service requests only contain JSON data, so callers convert them before
 * crossing either Electron boundary.
 */
export const toIpcPlainValue = <T>(value: T): T => {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('Managed service IPC payload is not JSON serializable.')
  }
  return JSON.parse(serialized) as T
}
