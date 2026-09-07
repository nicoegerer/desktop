import type {
  WorkspacePreviewInfo,
  WorkspacePreviewRequest,
  WorkspacePreviewResult
} from '../../shared/workspace-preview'

type PreviewFailure = Extract<WorkspacePreviewResult, { ok: false }>
type PreviewTerminal = { id: string; cwd: string }

interface PreviewManager {
  open(request: WorkspacePreviewRequest): Promise<WorkspacePreviewInfo>
  close(id: string): Promise<void>
  closeAll(): Promise<void>
  getActive(): WorkspacePreviewInfo | null
}

interface PreviewIpcOptions {
  manager: PreviewManager
  listTerminals: () => readonly PreviewTerminal[]
  isTrustedSender: (event: unknown) => boolean
  describeError: (cause: unknown) => PreviewFailure
}

export interface WorkspacePreviewHandlers {
  open(event: unknown, request: unknown): Promise<WorkspacePreviewResult>
  close(event: unknown, request: unknown): Promise<{ ok: true } | PreviewFailure>
  getActive(event: unknown): { ok: true; preview: WorkspacePreviewInfo | null } | PreviewFailure
  releaseTerminal(id: string): Promise<void>
  closeAll(): Promise<void>
}

const invalidWorkspace = (): PreviewFailure => ({
  ok: false,
  code: 'INVALID_WORKSPACE',
  error: 'Select an available local workspace folder first.'
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Keep renderer paths outside the trusted manager API, even for a forged IPC payload. */
export const createWorkspacePreviewHandlers = (
  options: PreviewIpcOptions
): WorkspacePreviewHandlers => {
  let terminalId: string | null = null

  const closeAll = async (): Promise<void> => {
    terminalId = null
    await options.manager.closeAll()
  }

  return {
    open: async (event: unknown, request: unknown): Promise<WorkspacePreviewResult> => {
      if (!options.isTrustedSender(event) || !isRecord(request)) return invalidWorkspace()
      const requestedId = request.terminalId
      if (typeof requestedId !== 'string' || !requestedId) return invalidWorkspace()
      const terminal = options.listTerminals().find((entry) => entry.id === requestedId)
      if (!terminal) return invalidWorkspace()
      if (request.entryPath !== undefined && typeof request.entryPath !== 'string') {
        return { ok: false, code: 'UNSAFE_PATH', error: 'Choose a workspace-relative HTML file.' }
      }
      terminalId = terminal.id
      try {
        const preview = await options.manager.open({
          workspacePath: terminal.cwd,
          ...(request.entryPath !== undefined ? { entryPath: request.entryPath } : {})
        })
        // The folder may have been released while the server was starting.
        const registered = options
          .listTerminals()
          .some((entry) => entry.id === terminal.id && entry.cwd === terminal.cwd)
        if (!registered || terminalId !== terminal.id) {
          await options.manager.close(preview.id)
          return { ok: false, code: 'SUPERSEDED', error: 'The selected workspace has changed.' }
        }
        return { ok: true, preview }
      } catch (cause) {
        return options.describeError(cause)
      }
    },
    close: async (event: unknown, request: unknown): Promise<{ ok: true } | PreviewFailure> => {
      if (
        !options.isTrustedSender(event) ||
        !isRecord(request) ||
        typeof request.id !== 'string' ||
        !request.id
      )
        return invalidWorkspace()
      try {
        // An old iframe's close event must never close a newer preview.
        await options.manager.close(request.id)
        return { ok: true }
      } catch (cause) {
        return options.describeError(cause)
      }
    },
    getActive: (
      event: unknown
    ): { ok: true; preview: WorkspacePreviewInfo | null } | PreviewFailure =>
      options.isTrustedSender(event)
        ? { ok: true, preview: options.manager.getActive() }
        : invalidWorkspace(),
    releaseTerminal: async (id: string): Promise<void> => {
      if (terminalId === id) await closeAll()
    },
    closeAll
  }
}
