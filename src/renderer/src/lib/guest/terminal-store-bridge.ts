interface WritableStore<T> {
  set(value: T): void
  subscribe(run: (value: T) => void): () => void
}

interface TerminalEntry {
  id?: string
  [key: string]: unknown
}
interface TerminalStores {
  terminalServers: WritableStore<TerminalEntry[] | null>
  selectedTerminalId: WritableStore<string | null>
  showControls?: { set(value: boolean): void }
  showFileNavPath?: { set(value: null): void }
  showFileNavDir?: { set(value: null): void }
}

interface TerminalStoreBridge {
  select(
    terminalId: string | null,
    isCurrent?: () => boolean,
    workspace?: { path?: string; chatId?: string; context?: string }
  ): Promise<boolean>
}

/** Injected with toString(): keep this factory self-contained. */
export function createTerminalStoreBridge(
  stores: TerminalStores,
  fetcher: typeof fetch,
  getToken: () => string
): TerminalStoreBridge {
  const read = <T>(store: WritableStore<T>): T => {
    let value!: T
    const unsubscribe = store.subscribe((next) => {
      value = next
    })
    unsubscribe()
    return value
  }
  let queue: Promise<unknown> = Promise.resolve()
  let appliedContext: string | null = null

  return {
    select(
      terminalId: string | null,
      isCurrent: () => boolean = () => true,
      workspace: { path?: string; chatId?: string; context?: string } = {}
    ): Promise<boolean> {
      // Store writes must be ordered as well as guarded: a slow discovery from
      // the previous conversation must not remount its FileNav in the new one.
      const task = queue.then(async () => {
        if (!isCurrent()) return false
        let terminals: TerminalEntry[] | null = null
        const token = getToken()
        const headers: Record<string, string> = token ? { Authorization: 'Bearer ' + token } : {}
        if (terminalId) {
          const response = await fetcher('/api/v1/terminals/', { headers })
          if (!response.ok || !isCurrent()) return false
          terminals = await response.json()
          if (!Array.isArray(terminals) || !terminals.some((t) => t.id === terminalId)) return false
          if (!isCurrent()) return false
          if (workspace.path) {
            // FileNav browsing also changes the session cwd. The chip, not an
            // old preview or a previous turn, defines the next task's root.
            const cwdHeaders: Record<string, string> = {
              ...headers,
              'Content-Type': 'application/json'
            }
            if (workspace.chatId) cwdHeaders['X-Session-Id'] = workspace.chatId
            const cwd = await fetcher(
              '/api/v1/terminals/' + encodeURIComponent(terminalId) + '/files/cwd',
              {
                method: 'POST',
                headers: cwdHeaders,
                body: JSON.stringify({ path: workspace.path })
              }
            )
            if (!cwd.ok || !isCurrent()) return false
          }
        }

        if (!isCurrent()) return false
        const changed =
          read(stores.selectedTerminalId) !== terminalId ||
          appliedContext === null ||
          appliedContext !== (workspace.context ?? '')
        if (changed) {
          stores.showFileNavPath?.set(null)
          stores.showFileNavDir?.set(null)
          stores.selectedTerminalId.set(null)
          // Let Svelte unmount FileNav, discarding its preview and back stack,
          // before mounting the new terminal. Do not reload or reset the chat.
          await Promise.resolve()
          if (!isCurrent()) return false
        }
        if (terminals) {
          const current = read(stores.terminalServers)
          const direct = Array.isArray(current) ? current.filter((t) => !t || !t.id) : []
          const proxiedSystemTerminals = terminals.map((terminal) =>
            terminal?.id
              ? { ...terminal, url: '/api/v1/terminals/' + encodeURIComponent(terminal.id) }
              : terminal
          )
          stores.terminalServers.set(direct.concat(proxiedSystemTerminals))
        }
        stores.selectedTerminalId.set(terminalId)
        if (terminalId) stores.showControls?.set(true)
        appliedContext = workspace.context ?? ''
        return read(stores.selectedTerminalId) === terminalId
      })
      queue = task.catch(() => false)
      return task
    }
  }
}
