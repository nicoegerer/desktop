/** Only trusted desktop IPC selects the workspace; generated pages receive no IPC bridge. */
export interface WorkspacePreviewRequest {
  workspacePath: string
  /** Workspace-relative HTML file (or directory with index.html). Defaults to index.html. */
  entryPath?: string
}

export interface WorkspacePreviewInfo {
  id: string
  /** Contains a preview-only capability. Do not log or persist this URL. */
  url: string
  workspacePath: string
  entryPath: string
}

export type WorkspacePreviewErrorCode =
  | 'INVALID_WORKSPACE'
  | 'UNSAFE_PATH'
  | 'ENTRY_NOT_FOUND'
  | 'UNSUPPORTED_ENTRY'
  | 'PREVIEW_START_FAILED'
  | 'SUPERSEDED'

export type WorkspacePreviewResult =
  | { ok: true; preview: WorkspacePreviewInfo }
  | { ok: false; code: WorkspacePreviewErrorCode; error: string }

/** Keep the embedding iframe sandboxed even if a page navigates away from its initial URL. */
export const WORKSPACE_PREVIEW_SANDBOX = 'allow-scripts'

/** Used for every subframe navigation in the trusted desktop renderer, not guest webviews. */
export const isWorkspacePreviewNavigationAllowed = (
  targetUrl: string,
  activePreviewUrl: string | undefined | null
): boolean => {
  if (!activePreviewUrl) return false
  try {
    const target = new URL(targetUrl)
    const active = new URL(activePreviewUrl)
    return (
      active.protocol === 'http:' &&
      target.protocol === 'http:' &&
      active.hostname === '127.0.0.1' &&
      active.port !== '' &&
      !active.username &&
      !active.password &&
      !target.username &&
      !target.password &&
      target.origin === active.origin
    )
  } catch {
    return false
  }
}

/**
 * The opaque iframe deliberately sends no Referer. The trusted desktop renderer's
 * network hook supplies its preview-only capability to its own active origin.
 * Call only after validating the request's webContentsId; never attach this to a
 * guest webview or a general browser session. Strip the reserved header on stale
 * or external requests so a redirect cannot carry it to a different origin.
 */
export const getWorkspacePreviewRequestHeaders = (
  targetUrl: string,
  activePreviewUrl: string | undefined | null,
  requestHeaders: Record<string, string>
): Record<string, string> => {
  const headers = { ...requestHeaders }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'x-desktop-preview') delete headers[key]
  }
  if (!isWorkspacePreviewNavigationAllowed(targetUrl, activePreviewUrl)) return headers
  const capability = new URL(activePreviewUrl!).searchParams.get('__desktop_preview')
  if (capability && /^[a-f0-9]{64}$/.test(capability)) headers['X-Desktop-Preview'] = capability
  return headers
}

export const WORKSPACE_PREVIEW_LIMITATION =
  'Local HTML, CSS, JavaScript, images, fonts and media only. External connections, forms and server-side applications are blocked.'
