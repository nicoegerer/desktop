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

  // ── Connectors are always available ────────────────
  const existingToolIds = Array.isArray(next.tool_ids) ? (next.tool_ids as string[]) : []
  const alwaysOn = Array.isArray(patch?.alwaysOnToolIds) ? patch.alwaysOnToolIds : []
  const toolIds = existingToolIds.slice()
  for (const id of alwaysOn) {
    if (typeof id === 'string' && id && toolIds.indexOf(id) === -1) toolIds.push(id)
  }
  if (toolIds.length > 0) next.tool_ids = toolIds

  // ── Workspace ──────────────────────────────────────
  const selection = patch ? patch.selection : null

  // Drop an instruction left over from an earlier turn before adding the
  // current one, so switching workspaces mid-chat cannot stack them.
  const messages = Array.isArray(next.messages) ? (next.messages as Array<Record<string, unknown>>) : null
  const cleaned = messages
    ? messages.filter(
        (message) =>
          !(
            message &&
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.indexOf(marker) !== -1
          )
      )
    : null

  if (!selection) {
    if (cleaned) next.messages = cleaned
    return next
  }

  if (selection.mode === 'local') {
    if (selection.terminalId) next.terminal_id = selection.terminalId
    if (cleaned) next.messages = cleaned
    return next
  }

  // Cloud: no terminal at all, and the repository is named in a system message
  // so the instruction is scoped to this conversation instead of the account.
  delete next.terminal_id
  if (cleaned) {
    const instruction =
      marker +
      ' The active workspace is the GitHub repository `' +
      String(selection.repoFullName ?? '') +
      '` on branch `' +
      String(selection.branch ?? '') +
      '`. Work in it through the GitHub tools: read files with the repository content tools and' +
      ' commit changes to that branch. There is no local checkout of this repository, so do not' +
      ' look for its files on disk and do not run git against it in a terminal.'

    const systemIndex = cleaned.findIndex((message) => message && message.role === 'system')
    const entry = { role: 'system', content: instruction }
    next.messages =
      systemIndex === -1
        ? [entry, ...cleaned]
        : [...cleaned.slice(0, systemIndex + 1), entry, ...cleaned.slice(systemIndex + 1)]
  }
  return next
}
