/**
 * Electron IPC cannot structured-clone Svelte 5's deeply nested state proxies.
 * Managed-service requests only contain JSON data, so serializing once at the
 * preload boundary both removes proxies and gives every caller a clone-safe
 * payload.
 */
export const toIpcPlainValue = <T>(value: T): T => {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('Managed service IPC payload is not JSON serializable.')
  }
  return JSON.parse(serialized) as T
}
