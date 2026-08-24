<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { fade } from 'svelte/transition'
  import { connections, config, serverInfo, appState } from '../../stores'
  import i18n from '../../i18n'

  import Sidebar from './Connections/Sidebar.svelte'
  import Content from './Connections/Content.svelte'
  import StatusBar from './Connections/StatusBar.svelte'
  import LogPanel from './Connections/LogPanel.svelte'
  import ManagedServiceLogPanel from '../../services/ManagedServiceLogPanel.svelte'
  import WorkspacePicker from './Connections/WorkspacePicker.svelte'
  import type {
    ManagedServiceSnapshot,
    ToolServerSyncResult
  } from '../../../../../shared/services/types'

  interface Props {
    onOpenSettings: () => void
    sidebarOpen: boolean
    activeConnectionName?: string
  }

  let { onOpenSettings, sidebarOpen, activeConnectionName = $bindable('') }: Props = $props()

  let isLocalConnection = $state(false)
  let showingLogs = $state(false)

  let url = $state('')
  let connecting = $state(false)
  let error = $state('')
  let view = $state('welcome') // welcome | install | connected
  let autoInstall = $state(false)
  let installPhase = $state('idle') // idle | working | error
  let installError = $state('')
  let toastVisible = $state(false)
  let toastTimeout: ReturnType<typeof setTimeout> | null = null
  let installStatus = $state('')
  let settingsOpen = $state(false)
  let connectedUrl = $state('')
  let activeConnectionId = $state('')
  let connectingId = $state('')
  let openConnections: Map<string, string> = $state(new Map())
  let localInstalled = $state(false)
  let openTerminalInstalled = $state(false)
  let showAddConnectionModal = $state(false)

  // Active log panel
  let activeLog = $state<'server' | 'open-terminal' | 'llama-server' | null>(null)
  let activeManagedService = $state<ManagedServiceSnapshot | null>(null)

  const serverStatus = $derived($serverInfo?.status)
  const serverReachable = $derived($serverInfo?.reachable)

  const isInitializing = $derived($appState === 'initializing')
  const localConn = $derived(
    localInstalled
      ? {
          id: 'local',
          name: 'Open WebUI',
          type: 'local' as const,
          url: `http://127.0.0.1:${$config?.localServer?.port ?? 8080}`
        }
      : null
  )
  const remoteConnections = $derived($connections ?? [])

  // Open Terminal state
  let openTerminalStatus = $state<string | null>(null)
  let openTerminalInfo = $state<{
    url?: string
    apiKey?: string
    workingDirectory?: string
  } | null>(null)

  // Llama Server state
  let llamaCppStatus = $state<string | null>(null)
  let llamaCppInfo = $state<{ url?: string; pid?: number } | null>(null)
  let llamaCppSetupStatus = $state('')
  let openTerminalSetupStatus = $state('')
  let workspaceBusy = $state(false)
  let workspaceFeedback = $state<{ kind: 'success' | 'error'; message: string } | null>(null)
  let workspaceFeedbackTimer: ReturnType<typeof setTimeout> | null = null
  let workspacePickerOpen = $state(false)
  let workspaceStatus = $state('')

  // Connector registration in Open WebUI
  const TOOL_SERVER_SYNC_DEBOUNCE_MS = 600
  let toolServerSyncTimer: ReturnType<typeof setTimeout> | null = null

  const isGerman =
    typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('de')
  const l = (german: string, english: string): string => (isGerman ? german : english)

  const startInstall = async (options?: {
    installOpenTerminal?: boolean
    installLlamaCpp?: boolean
    installDir?: string
  }) => {
    installPhase = 'working'
    installError = ''
    installStatus = ''
    toastVisible = false
    try {
      // Save custom install directory before anything else
      if (options?.installDir) {
        const currentDir = await window.electronAPI.getInstallDir()
        if (options.installDir !== currentDir) {
          await window.electronAPI.setConfig({ installDir: options.installDir })
        }
      }

      // Check disk space before installing (minimum 5 GB)
      const MINIMUM_DISK_BYTES = 5 * 1024 * 1024 * 1024
      const disk = await window.electronAPI.getDiskSpace()
      if (disk?.free >= 0 && disk.free < MINIMUM_DISK_BYTES) {
        const availableGB = (disk.free / (1024 * 1024 * 1024)).toFixed(1)
        throw new Error(
          `Not enough disk space. At least 5 GB is required (${availableGB} GB available).`
        )
      }

      // Ensure Python and uv are installed before attempting package install
      const pythonReady = await window.electronAPI.getPythonStatus()
      if (!pythonReady) {
        const pythonOk = await window.electronAPI.installPython()
        if (!pythonOk) throw new Error('Failed to install Python. Please try again.')
      }

      const ok = await window.electronAPI.installPackage()
      if (!ok) throw new Error($i18n.t('error.installFailedGeneric'))

      // Start optional services after packages are installed to avoid
      // concurrent uv installs fighting over the lockfile
      if (options?.installOpenTerminal) {
        toggleOpenTerminal()
      }
      if (options?.installLlamaCpp) {
        toggleLlamaCpp()
      }

      installStatus = $i18n.t('main.install.startingServer')
      await window.electronAPI.startServer()
      const info = await window.electronAPI.getServerInfo()

      installStatus = $i18n.t('main.install.settingUpConnection')
      await window.electronAPI.setDefaultConnection('local')
      config.set(await window.electronAPI.getConfig())

      // Wait for server to actually be reachable before showing connected view
      installStatus = $i18n.t('main.install.launchingOpenWebUI')
      const maxWait = 120000
      const pollInterval = 2000
      const startTime = Date.now()
      let reachable = false
      while (Date.now() - startTime < maxWait) {
        const si = await window.electronAPI.getServerInfo()
        if (si?.reachable) {
          reachable = true
          break
        }
        await new Promise((r) => setTimeout(r, pollInterval))
      }

      if (!reachable) {
        throw new Error('Server did not become reachable. Please try again.')
      }

      // Now connect — the server is ready
      installStatus = ''
      connect('local')
      installPhase = 'idle'
    } catch (e: any) {
      installPhase = 'error'
      installError = e?.message || $i18n.t('error.somethingWentWrong')
      toastVisible = true
      if (toastTimeout) clearTimeout(toastTimeout)
      toastTimeout = setTimeout(() => {
        toastVisible = false
      }, 5000)
    }
  }

  const addConnection = async () => {
    if (!url.trim()) return
    let u = url.trim()
    if (!u.startsWith('http')) u = 'https://' + u
    error = ''
    try {
      new URL(u)
    } catch {
      error = $i18n.t('setup.invalidUrl')
      return
    }
    connecting = true
    try {
      const valid = await window.electronAPI.validateUrl(u)
      if (!valid) {
        error = $i18n.t('setup.couldNotReachServer')
        connecting = false
        return
      }
      await window.electronAPI.addConnection({
        id: crypto.randomUUID(),
        name: new URL(u).hostname,
        type: 'remote',
        url: u
      })
      config.set(await window.electronAPI.getConfig())
      url = ''
      error = ''
      showAddConnectionModal = false
      view = 'welcome'
    } catch {
      error = $i18n.t('setup.connectionFailed')
    } finally {
      connecting = false
    }
  }

  const connect = (id: string) => {
    showingLogs = false
    // Toggle: clicking the active connection unselects it
    if (activeConnectionId === id && view === 'connected') {
      connectingId = ''
      activeConnectionId = ''
      connectedUrl = ''
      view = 'welcome'
      return
    }
    // Persist as default so spotlight/startup always use the last-selected connection
    window.electronAPI.setDefaultConnection(id)
    // Already-open connection — just switch to it
    if (openConnections.has(id)) {
      connectingId = ''
      activeConnectionId = id
      connectedUrl = openConnections.get(id)!
      view = 'connected'
      syncOpenTerminalToWebview(id)
      return
    }

    activeConnectionId = id

    if (id === 'local') {
      // Local needs server start — use IPC (no renderer-side conn needed)
      connectingId = id
      view = 'welcome'
      window.electronAPI.connectTo(id).then((result: any) => {
        if (!result?.url) {
          if (connectingId === id) connectingId = ''
          return
        }
        if (!openConnections.has(result.connectionId)) {
          openConnections.set(result.connectionId, result.url)
          openConnections = new Map(openConnections)
        }
        if (connectingId === id) {
          connectedUrl = result.url
          activeConnectionId = result.connectionId
          connectingId = ''
          if (installPhase !== 'working') {
            view = 'connected'
          }
          syncOpenTerminalToWebview(result.connectionId)
        }
      })
    } else {
      const conn = ($connections ?? []).find((c) => c.id === id)
      if (!conn) return
      // Remote — open immediately, no IPC needed
      connectingId = ''
      openConnections.set(id, conn.url)
      openConnections = new Map(openConnections)
      connectedUrl = conn.url
      view = 'connected'
      syncOpenTerminalToWebview(id)
    }
  }

  const disconnect = () => {
    activeConnectionId = ''
    connectedUrl = ''
    view = 'welcome'
  }

  const remove = async (id: string) => {
    await window.electronAPI.removeConnection(id)
    config.set(await window.electronAPI.getConfig())
    if (activeConnectionId === id) {
      disconnect()
    }
    openConnections.delete(id)
    openConnections = new Map(openConnections)
  }

  $effect(() => {
    if (activeConnectionId === 'local') {
      activeConnectionName = localConn?.name ?? 'Open WebUI'
      isLocalConnection = true
    } else {
      const conn = ($connections ?? []).find((c) => c.id === activeConnectionId)
      activeConnectionName = conn?.name ?? ''
      isLocalConnection = false
    }
  })

  // React to showingLogs from parent — open the server log panel
  // Only react when parent sets showingLogs to true; don't close on false
  // (the status bar manages its own open/close via activeLog)
  $effect(() => {
    if (showingLogs) {
      activeLog = 'server'
    }
  })

  // Sync back: when panel closes, tell parent
  $effect(() => {
    if (activeLog === null) {
      showingLogs = false
    }
  })

  const openGithub = () => {
    settingsOpen = false
    window.electronAPI?.openInBrowser?.('https://github.com/open-webui/desktop')
  }

  // ── Log panel PTY helpers ─────────────────────────────
  const getConnectPty = (log: string) => {
    return (callback: (data: string) => void) => {
      if (log === 'server') {
        window.electronAPI.connectPty(callback)
      } else if (log === 'open-terminal') {
        window.electronAPI.connectOpenTerminalPty(callback)
      } else if (log === 'llama-server') {
        window.electronAPI.connectLlamaCppPty(callback)
      }
    }
  }

  const getDisconnectPty = (log: string) => {
    return () => {
      if (log === 'server') {
        window.electronAPI.disconnectPty()
      } else if (log === 'open-terminal') {
        window.electronAPI?.disconnectOpenTerminalPty?.()
      } else if (log === 'llama-server') {
        window.electronAPI?.disconnectLlamaCppPty?.()
      }
    }
  }

  const getOnWrite = (log: string) => {
    if (log === 'server') {
      return (data: string) => window.electronAPI.writePty(data)
    }
    return undefined
  }

  const getOnResize = (log: string) => {
    if (log === 'server') {
      return (cols: number, rows: number) => window.electronAPI.resizePty(cols, rows)
    }
    return undefined
  }

  // ── Status bar log selection ──────────────────────────
  const selectLog = (log: string) => {
    activeManagedService = null
    activeLog = activeLog === log ? null : (log as typeof activeLog)
  }

  const selectManagedService = (service: ManagedServiceSnapshot) => {
    activeLog = null
    activeManagedService = activeManagedService?.id === service.id ? null : service
  }

  // ── Webview event delivery ─────────────────────────────
  // Single path: all events from the main process flow through here.
  // Query events target a specific webview; everything else broadcasts.
  const sendToWebview = (event: any, connId?: string) => {
    const container = document.querySelector('.content-webview-container')
    if (!container) return

    const webviews = connId
      ? [
          container.querySelector(`webview[partition="persist:connection-${connId}"]`) as any
        ].filter(Boolean)
      : Array.from(container.querySelectorAll('webview'))

    for (const wv of webviews) {
      try {
        // Attempt to send — throws if webview hasn't fired dom-ready yet
        wv.send('desktop:event', event)
      } catch {
        // Webview not ready — queue delivery until dom-ready
        const onReady = () => {
          wv.removeEventListener('dom-ready', onReady)
          try {
            wv.send('desktop:event', event)
          } catch (_) {}
        }
        wv.addEventListener('dom-ready', onReady)
      }
    }
  }

  const syncOpenTerminalToWebview = (connId = 'local') => {
    // A loopback Open Terminal belongs to the bundled local Open WebUI.
    // Broadcasting it to remote servers would point their backend at itself.
    if (connId !== 'local') return
    if (!openTerminalInfo?.url || !openTerminalInfo?.apiKey || openTerminalStatus !== 'started') {
      return
    }
    requestAnimationFrame(() => {
      sendToWebview(
        {
          type: 'connections:terminal',
          data: {
            action: 'add',
            url: openTerminalInfo?.url,
            key: openTerminalInfo?.apiKey
          }
        },
        connId
      )
    })
  }

  // ── Connector → Open WebUI tool servers ────────────────
  // Starting a connector only launches the process; the chat still has to be
  // told the endpoint exists. Push the registry into the bundled Open WebUI
  // whenever it changes, the same way Open Terminal is registered.
  const syncToolServersToWebview = (connId = 'local'): void => {
    if (connId !== 'local') return
    if (toolServerSyncTimer) clearTimeout(toolServerSyncTimer)
    toolServerSyncTimer = setTimeout(async () => {
      try {
        const targets = await window.electronAPI.getManagedServiceToolTargets()
        sendToWebview({ type: 'connections:tools', data: { targets } }, 'local')
      } catch (cause) {
        console.error('Failed to collect connector tool targets:', cause)
      }
    }, TOOL_SERVER_SYNC_DEBOUNCE_MS)
  }

  const handleWebviewEvent = (
    connId: string,
    payload: { type: string; data?: unknown }
  ): void => {
    if (connId !== 'local' || payload.type !== 'connections:tools:result') return
    const result = (payload.data ?? {}) as ToolServerSyncResult

    if (result.status === 'failed') {
      showWorkspaceFeedback(
        'error',
        l(
          `Konnektoren konnten nicht in Open WebUI registriert werden (${result.reason ?? 'unbekannt'}).`,
          `Connectors could not be registered in Open WebUI (${result.reason ?? 'unknown'}).`
        )
      )
      return
    }
    if (result.status === 'skipped' && result.reason === 'not-admin') {
      showWorkspaceFeedback(
        'error',
        l(
          'Konnektoren brauchen ein Open-WebUI-Adminkonto, um als Werkzeugserver registriert zu werden.',
          'Registering connectors as tool servers requires an Open WebUI admin account.'
        )
      )
      return
    }
    if (result.status === 'synced') {
      showWorkspaceFeedback(
        'success',
        l(
          `${result.count} Konnektor(en) in Open WebUI registriert. Im Chat über das Wolken-Symbol auswählen.`,
          `${result.count} connector(s) registered in Open WebUI. Select them from the cloud icon in chat.`
        )
      )
    }
  }

  // Listen for events from main process
  onMount(() => {
    window.electronAPI.onData((data: any) => {
      if (data.type === 'managed-service:status' && data.data?.id === activeManagedService?.id) {
        activeManagedService = data.data as ManagedServiceSnapshot
      }
      if (data.type === 'managed-service:status' || data.type === 'managed-services:changed') {
        syncToolServersToWebview()
      }
      if (
        data.type === 'managed-services:changed' &&
        activeManagedService &&
        Array.isArray(data.data)
      ) {
        activeManagedService =
          (data.data as ManagedServiceSnapshot[]).find(
            (service) => service.id === activeManagedService?.id
          ) ?? null
      }

      // ── Connection opened (startup, tray click) ───────
      if (data.type === 'connection:open' && data.data?.url) {
        const connId = data.data.connectionId ?? ''
        const incomingUrl = data.data.url

        if (!openConnections.has(connId)) {
          openConnections.set(connId, incomingUrl)
          openConnections = new Map(openConnections)
        }

        if (view !== 'connected') {
          connectedUrl = openConnections.get(connId) ?? incomingUrl
          activeConnectionId = connId
          if (installPhase !== 'working') view = 'connected'
        }
        syncOpenTerminalToWebview(connId)
        syncToolServersToWebview(connId)
        return
      }

      // ── Spotlight / desktop query ─────────────────────
      if (data.type === 'query' && (data.data?.query || data.data?.files?.length)) {
        const connId = data.data.connectionId ?? ''
        const query = data.data.query
        const files = data.data.files
        const baseUrl = data.data.url ?? ''

        if (!openConnections.has(connId)) {
          openConnections.set(connId, baseUrl)
          openConnections = new Map(openConnections)
          connectedUrl = baseUrl
        } else {
          connectedUrl = openConnections.get(connId)!
        }
        activeConnectionId = connId
        if (installPhase !== 'working') view = 'connected'

        // Targeted delivery — wait a frame for the webview DOM to exist
        requestAnimationFrame(() => {
          sendToWebview({ type: 'query', data: { query, files } }, connId)
        })
        return
      }

      // ── Call shortcut ─────────────────────────────────
      if (data.type === 'call' && data.data?.connectionId) {
        const connId = data.data.connectionId ?? ''
        const baseUrl = data.data.url ?? ''

        if (!openConnections.has(connId)) {
          openConnections.set(connId, baseUrl)
          openConnections = new Map(openConnections)
          connectedUrl = baseUrl
        } else {
          connectedUrl = openConnections.get(connId)!
        }
        activeConnectionId = connId
        if (installPhase !== 'working') view = 'connected'

        // Targeted delivery — wait a frame for the webview DOM to exist
        requestAnimationFrame(() => {
          sendToWebview({ type: 'call' }, connId)
        })
        return
      }

      if (data.type === 'connections:terminal') {
        sendToWebview(data, 'local')
        return
      }

      // ── Desktop-only state (not forwarded to webviews) ─
      if (data.type === 'status:open-terminal') {
        openTerminalStatus = data.data
        return
      }
      if (data.type === 'status:open-terminal-setup') {
        openTerminalSetupStatus = data.data ?? ''
        return
      }
      if (data.type === 'status:workspace') {
        workspaceStatus = data.data ?? ''
        return
      }
      if (data.type === 'open-terminal:ready') {
        openTerminalInfo = data.data
        openTerminalStatus = 'started'
        openTerminalSetupStatus = ''
        syncOpenTerminalToWebview()
        return
      }
      if (data.type === 'status:llamacpp') {
        llamaCppStatus = data.data
        return
      }
      if (data.type === 'status:llamacpp-setup') {
        llamaCppSetupStatus = data.data ?? ''
        return
      }
      if (data.type === 'llamacpp:ready') {
        llamaCppInfo = data.data
        llamaCppStatus = 'started'
        llamaCppSetupStatus = ''
        return
      }
      if (data.type === 'status:install') {
        installStatus = data.data ?? ''
        return
      }
      if (data.type === 'packages:changed') {
        localInstalled = !!data.data?.['open-webui']
        return
      }
      if (data.type === 'connections:changed') {
        connections.set(data.data ?? [])
        return
      }

      // ── Everything else → broadcast to all webviews ───
      sendToWebview(data)
    })

    // Auto-connect to the default connection on startup so the webview
    // is pre-loaded and ready for spotlight queries.
    window.electronAPI.getConfig().then((cfg: any) => {
      if (cfg?.defaultConnectionId && !activeConnectionId) {
        connect(cfg.defaultConnectionId)
      }
    })

    // Check current Open Terminal state on mount
    window.electronAPI.getOpenTerminalInfo().then((info: any) => {
      if (info?.status) {
        openTerminalStatus = info.status
        openTerminalInfo = info
        syncOpenTerminalToWebview()
      }
    })

    // Register connectors that were autostarted before this view existed
    syncToolServersToWebview()

    // Check if Open Terminal package is installed
    window.electronAPI.getOpenTerminalStatus().then((installed: boolean) => {
      openTerminalInstalled = installed
    })

    // Check if Open WebUI package is installed
    window.electronAPI.getPackageVersion('open-webui').then((v: string | null) => {
      localInstalled = v !== null
    })

    // Check llama-server state on mount
    window.electronAPI.getLlamaCppInfo().then((info: any) => {
      if (info?.status) {
        llamaCppStatus = info.status
      }
      if (info?.binaryPath || info?.status) {
        llamaCppInfo = info
      }
    })
  })

  onDestroy(() => {
    if (workspaceFeedbackTimer) clearTimeout(workspaceFeedbackTimer)
    if (toolServerSyncTimer) clearTimeout(toolServerSyncTimer)
  })

  const showWorkspaceFeedback = (kind: 'success' | 'error', message: string): void => {
    workspaceFeedback = { kind, message }
    if (workspaceFeedbackTimer) clearTimeout(workspaceFeedbackTimer)
    workspaceFeedbackTimer = setTimeout(
      () => (workspaceFeedback = null),
      kind === 'error' ? 9000 : 7000
    )
  }

  const comparableWorkspacePath = (value: string): string => {
    const normalized = value.trim().replace(/[\\/]+$/, '')
    return /^[a-z]:[\\/]/i.test(normalized) ? normalized.toLowerCase() : normalized
  }

  /**
   * Point Open Terminal at a folder and register it in the bundled Open WebUI,
   * so a chat can read, edit, and run commands inside it.
   */
  const activateWorkspace = async (folder: string, repoFullName?: string): Promise<void> => {
    if (!folder) return

    workspaceBusy = true
    workspaceFeedback = null
    try {
      const currentConfig = await window.electronAPI.getConfig()
      const currentInfo = await window.electronAPI.getOpenTerminalInfo()
      const sameWorkspace =
        comparableWorkspacePath(currentInfo?.workingDirectory ?? '') ===
        comparableWorkspacePath(folder)

      await window.electronAPI.setConfig({
        openTerminal: {
          ...(currentConfig?.openTerminal ?? {}),
          cwd: folder,
          enabled: true
        }
      })
      config.set(await window.electronAPI.getConfig())

      if (currentInfo?.status === 'started' && !sameWorkspace) {
        openTerminalStatus = 'stopping'
        const stopped = await window.electronAPI.stopOpenTerminal()
        if (!stopped) throw new Error('Open Terminal could not be restarted for the new workspace.')
        openTerminalInfo = null
        openTerminalStatus = null
      }

      const result =
        currentInfo?.status === 'started' && sameWorkspace
          ? currentInfo
          : await window.electronAPI.startOpenTerminal()
      if (!result?.url || !result?.workingDirectory) {
        throw new Error('Open Terminal could not be started for the selected workspace.')
      }

      openTerminalInfo = result
      openTerminalStatus = 'started'
      openTerminalInstalled = true
      const synced = await window.electronAPI.syncOpenTerminal()
      if (!synced) throw new Error('The workspace could not be registered in Open WebUI.')

      await window.electronAPI.rememberWorkspace(result.workingDirectory, repoFullName)
      workspacePickerOpen = false
      workspaceStatus = ''

      showWorkspaceFeedback(
        'success',
        l(
          `Arbeitsbereich bereit: ${result.workingDirectory}. Im Chat über das Wolken-Symbol „Local Open Terminal“ auswählen.`,
          `Workspace ready: ${result.workingDirectory}. In the chat, click the cloud icon and select “Local Open Terminal”.`
        )
      )
    } catch (cause) {
      showWorkspaceFeedback('error', cause instanceof Error ? cause.message : String(cause))
    } finally {
      workspaceBusy = false
      workspaceStatus = ''
    }
  }

  const chooseWorkspace = (): void => {
    workspaceFeedback = null
    workspacePickerOpen = true
  }

  const toggleOpenTerminal = async () => {
    if (openTerminalStatus === 'starting') return
    if (openTerminalStatus === 'started') {
      openTerminalStatus = 'stopping'
      await window.electronAPI.stopOpenTerminal()
      openTerminalStatus = null
      openTerminalInfo = null
      openTerminalSetupStatus = ''
    } else {
      openTerminalStatus = 'starting'
      openTerminalSetupStatus = ''
      const result = await window.electronAPI.startOpenTerminal()
      if (result) {
        openTerminalInfo = result
        openTerminalStatus = 'started'
      } else {
        openTerminalStatus = 'failed'
      }
      openTerminalSetupStatus = ''
    }
  }

  const toggleLlamaCpp = async () => {
    if (llamaCppStatus === 'starting' || llamaCppStatus === 'setting-up') return
    if (llamaCppStatus === 'started') {
      llamaCppStatus = 'stopping'
      await window.electronAPI.stopLlamaCpp()
      llamaCppStatus = null
      llamaCppInfo = null
    } else {
      llamaCppStatus = 'starting'
      const result = await window.electronAPI.startLlamaCpp()
      if (result) {
        llamaCppInfo = result
        llamaCppStatus = 'started'
      } else {
        llamaCppStatus = 'failed'
      }
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="h-full w-full flex flex-col bg-[#f5f5f7] dark:bg-[#0a0a0a] text-[#1d1d1f] dark:text-[#fafafa]"
  in:fade={{ duration: 200 }}
>
  <div class="flex-1 min-h-0 flex">
    {#if sidebarOpen}
      <Sidebar
        {activeConnectionId}
        {connectingId}
        {localConn}
        {localInstalled}
        {remoteConnections}
        {serverStatus}
        {serverReachable}
        bind:settingsOpen
        onConnect={connect}
        onDisconnect={disconnect}
        onAddView={() => {
          showAddConnectionModal = true
        }}
        {onOpenSettings}
        onRename={async (id, name) => {
          await window.electronAPI.updateConnection(id, { name })
        }}
        onRemove={remove}
        {openGithub}
      />
    {/if}

    <Content
      {sidebarOpen}
      bind:view
      {activeConnectionId}
      {connectingId}
      {openConnections}
      {localConn}
      {localInstalled}
      {remoteConnections}
      bind:installPhase
      bind:installError
      bind:installStatus
      bind:toastVisible
      bind:url
      bind:connecting
      bind:error
      bind:showAddConnectionModal
      bind:autoInstall
      onStartInstall={startInstall}
      onAddConnection={addConnection}
      onSetView={(v) => {
        view = v
      }}
      onWebviewEvent={handleWebviewEvent}
    />
  </div>

  {#if activeLog}
    <LogPanel
      {activeLog}
      serviceReady={activeLog === 'server'
        ? serverStatus === 'started'
        : activeLog === 'open-terminal'
          ? openTerminalStatus === 'started'
          : llamaCppStatus === 'started'}
      statusText={activeLog === 'server'
        ? serverStatus === 'starting'
          ? 'Starting Open WebUI…'
          : serverStatus === 'running' && !serverReachable
            ? 'Waiting for server…'
            : installStatus || ''
        : activeLog === 'open-terminal'
          ? openTerminalStatus === 'stopping'
            ? 'Stopping Open Terminal…'
            : openTerminalSetupStatus ||
              (openTerminalStatus === 'starting' ? 'Starting Open Terminal…' : '')
          : llamaCppStatus === 'stopping'
            ? 'Stopping llama-server…'
            : llamaCppSetupStatus ||
              (llamaCppStatus === 'starting'
                ? 'Starting llama-server…'
                : llamaCppStatus === 'setting-up'
                  ? 'Setting up llama.cpp…'
                  : '')}
      connectPty={getConnectPty(activeLog)}
      disconnectPty={getDisconnectPty(activeLog)}
      readonly={activeLog !== 'server'}
      onWrite={getOnWrite(activeLog)}
      onResize={getOnResize(activeLog)}
      onStop={activeLog === 'open-terminal'
        ? toggleOpenTerminal
        : activeLog === 'llama-server'
          ? toggleLlamaCpp
          : undefined}
      onClose={() => {
        activeLog = null
        showingLogs = false
      }}
    />
  {:else if activeManagedService}
    <ManagedServiceLogPanel
      service={activeManagedService}
      onClose={() => (activeManagedService = null)}
    />
  {/if}

  {#if workspacePickerOpen}
    <WorkspacePicker
      activePath={openTerminalInfo?.workingDirectory ?? $config?.openTerminal?.cwd ?? ''}
      busy={workspaceBusy}
      statusText={workspaceStatus}
      onClose={() => (workspacePickerOpen = false)}
      onActivate={activateWorkspace}
    />
  {/if}

  {#if workspaceFeedback}
    <div
      class="fixed bottom-10 left-1/2 z-[100] max-w-[min(680px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border px-4 py-2.5 text-[11px] shadow-xl backdrop-blur {workspaceFeedback.kind ===
      'success'
        ? 'border-emerald-500/25 bg-emerald-950/90 text-emerald-100'
        : 'border-red-500/25 bg-red-950/90 text-red-100'}"
      role={workspaceFeedback.kind === 'error' ? 'alert' : 'status'}
    >
      {workspaceFeedback.message}
    </div>
  {/if}

  <StatusBar
    {serverStatus}
    {serverReachable}
    {openTerminalStatus}
    {llamaCppStatus}
    openWebuiInstalled={localInstalled}
    {openTerminalInstalled}
    llamaCppInstalled={!!llamaCppInfo?.binaryPath}
    {activeLog}
    activeManagedServiceId={activeManagedService?.id ?? null}
    workspacePath={openTerminalInfo?.workingDirectory ?? $config?.openTerminal?.cwd ?? ''}
    {workspaceBusy}
    onSelectLog={selectLog}
    onSelectManagedService={selectManagedService}
    onStartServer={async () => {
      if (!localInstalled) {
        // Not installed — trigger full install (handles Python/uv + package)
        startInstall()
        return
      }
      // Already installed — start the server
      await window.electronAPI.startServer()
      // Force-refresh serverInfo immediately (don't wait for 3s poll)
      const info = await window.electronAPI.getServerInfo()
      serverInfo.set(info)
    }}
    onToggleOpenTerminal={toggleOpenTerminal}
    onToggleLlamaCpp={toggleLlamaCpp}
    onChooseWorkspace={chooseWorkspace}
  />
</div>
