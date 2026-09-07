/**
 * Rewriting of Open WebUI's chat request so a conversation uses the workspace
 * picked in the desktop chip, and so the desktop's connectors are always
 * available.
 *
 * This runs inside the Open WebUI page, patched over `fetch`. The request body
 * is a far more stable contract than the page's markup, which is why the
 * workspace selection is applied here instead of by driving Open WebUI's own
 * menus.
 *
 * IMPORTANT: `applyWorkspaceToPayload` is injected into the guest page via
 * `Function.prototype.toString()`. It must stay self-contained — no imports, no
 * references to anything outside its own body.
 */

export interface ChatWorkspaceSelection {
  mode: 'local' | 'cloud'
  /** Open WebUI terminal id of the local workspace, when mode is 'local'. */
  terminalId?: string
  /** Authoritative root for this turn; earlier chat paths are historical. */
  path?: string
  /** Repository worked on without a checkout, when mode is 'cloud'. */
  repoFullName?: string
  branch?: string
}

export interface ChatPayloadPatch {
  selection: ChatWorkspaceSelection | null
  /** Tool ids of desktop connectors that must be active in every chat. */
  alwaysOnToolIds: string[]
}

export const CLOUD_INSTRUCTION_MARKER = '[desktop-cloud-workspace]'

export function applyWorkspaceToPayload(
  body: Record<string, unknown>,
  patch: ChatPayloadPatch
): Record<string, unknown> {
  if (!body || typeof body !== 'object') return body

  const next: Record<string, unknown> = { ...body }
  const marker = '[desktop-cloud-workspace]'
  const localMarker = '[desktop-local-workspace]'
  const selection = patch ? patch.selection : null

  if (selection && next.model_item && typeof next.model_item === 'object') {
    const modelItem = next.model_item as Record<string, unknown>
    const info =
      modelItem.info && typeof modelItem.info === 'object'
        ? (modelItem.info as Record<string, unknown>)
        : {}
    const meta =
      info.meta && typeof info.meta === 'object' ? (info.meta as Record<string, unknown>) : {}
    const capabilities =
      meta.capabilities && typeof meta.capabilities === 'object'
        ? (meta.capabilities as Record<string, unknown>)
        : {}
    next.model_item = {
      ...modelItem,
      info: { ...info, meta: { ...meta, capabilities: { ...capabilities, terminal: true } } }
    }
  }

  // ── Connectors are always available ────────────────
  const existingToolIds = Array.isArray(next.tool_ids) ? (next.tool_ids as string[]) : []
  const alwaysOn = Array.isArray(patch?.alwaysOnToolIds) ? patch.alwaysOnToolIds : []
  // Open WebUI resolves OpenAPI servers in this order. Routers/providers may
  // truncate the resulting function list (OmniRoute defaults to 128). A large
  // connector such as Garmin must never push the selected filesystem out.
  // Remove old workspace ids first: switching/detaching must not retain access
  // to a previously selected folder through the fallback OpenAPI server.
  const toolIds: string[] = []
  if (selection?.mode === 'local' && selection.terminalId) {
    toolIds.push(`server:desktop-workspace-${selection.terminalId}`)
  }
  for (const id of [...existingToolIds, ...alwaysOn]) {
    if (typeof id !== 'string' || !id || id.startsWith('server:desktop-workspace-')) continue
    if (toolIds.indexOf(id) === -1) toolIds.push(id)
  }
  if (toolIds.length > 0 || Array.isArray(next.tool_ids)) next.tool_ids = toolIds

  // ── Workspace ──────────────────────────────────────
  // Drop an instruction left over from an earlier turn before adding the
  // current one, so switching workspaces mid-chat cannot stack them.
  const messages = Array.isArray(next.messages)
    ? (next.messages as Array<Record<string, unknown>>)
    : null
  const cleaned = messages
    ? messages.filter(
        (message) =>
          !(
            message &&
            message.role === 'system' &&
            typeof message.content === 'string' &&
            (message.content.indexOf(marker) !== -1 || message.content.indexOf(localMarker) !== -1)
          )
      )
    : null

  if (!selection) {
    if (typeof next.terminal_id === 'string' && /^desktop-(ws|gh)-/.test(next.terminal_id)) {
      delete next.terminal_id
    }
    if (cleaned) next.messages = cleaned
    return next
  }

  if (selection.mode === 'local') {
    if (selection.terminalId) next.terminal_id = selection.terminalId
    if (cleaned) {
      const instruction =
        localMarker +
        ' A local workspace is active through Open Terminal' +
        (selection.path ? ' at ' + JSON.stringify(selection.path) : '') +
        '. This is the CURRENT workspace for THIS turn, even if earlier messages or tool results name another folder.' +
        ' A workspace switch does not require a new chat. Treat earlier output paths as history, not as the current destination.' +
        ' Create new files and variants under this current workspace; do not reuse an absolute output path from an earlier turn.' +
        ' Use paths relative to this workspace or absolute paths inside it. Read earlier source files only when needed;' +
        ' file mutations outside it are rejected. To modify another folder, ask the user to select that workspace first' +
        '. Use the file tools to inspect, create and modify files directly in this workspace.' +
        ' Prefer write_file/replace_file_content over shell quoting, and verify the result with read_file.' +
        ' When asked to build or edit something, save the files, not just a code block for copying.' +
        ' Report the actual paths and tool errors honestly; never claim a write succeeded without verification.'
      const systemIndex = cleaned.findIndex((message) => message && message.role === 'system')
      const entry = { role: 'system', content: instruction }
      next.messages =
        systemIndex === -1
          ? [entry, ...cleaned]
          : [...cleaned.slice(0, systemIndex + 1), entry, ...cleaned.slice(systemIndex + 1)]
    }
    return next
  }

  if (selection.terminalId) next.terminal_id = selection.terminalId
  else delete next.terminal_id
  if (cleaned) {
    const instruction =
      marker +
      ' The active workspace is the GitHub repository `' +
      String(selection.repoFullName ?? '') +
      '` on branch `' +
      String(selection.branch ?? '') +
      '`. Use the active Open Terminal tools to inspect files in the mounted repository. Use the GitHub tools to' +
      ' modify files, commit, and push changes to that branch when requested. This mount is managed by the' +
      ' desktop; do not switch to another local folder.'

    const systemIndex = cleaned.findIndex((message) => message && message.role === 'system')
    const entry = { role: 'system', content: instruction }
    next.messages =
      systemIndex === -1
        ? [entry, ...cleaned]
        : [...cleaned.slice(0, systemIndex + 1), entry, ...cleaned.slice(systemIndex + 1)]
  }
  return next
}
