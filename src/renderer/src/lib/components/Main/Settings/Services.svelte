<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  import type {
    ManagedServiceDefinition,
    ManagedServiceImportPreview,
    ManagedServiceIntegration,
    ManagedServiceSnapshot
  } from '../../../../../../shared/services/types'
  import Switch from '../../common/Switch.svelte'
  import ManagedServiceLogs from '../../../services/ManagedServiceLogs.svelte'

  type EnvEntry = { key: string; value: string }
  type MainDataMessage = { type: string; data?: unknown }

  let services = $state<ManagedServiceSnapshot[]>([])
  let loading = $state(true)
  let error = $state('')
  let editorError = $state('')
  let editorOpen = $state(false)
  let addMenuOpen = $state(false)
  let saving = $state(false)
  let draft = $state<ManagedServiceDefinition | null>(null)
  let argsText = $state('')
  let envEntries = $state<EnvEntry[]>([])
  let logService = $state<ManagedServiceSnapshot | null>(null)
  let integration = $state<ManagedServiceIntegration | null>(null)
  let integrationName = $state('')
  let importPreview = $state<ManagedServiceImportPreview | null>(null)
  let unsubscribe: (() => void) | null = null
  let filter = $state<'all' | 'running' | 'setup'>('all')
  let query = $state('')

  const isGerman =
    typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('de')
  const l = (german: string, english: string): string => (isGerman ? german : english)

  const refresh = async (): Promise<void> => {
    try {
      services = await window.electronAPI.listManagedServices()
      error = ''
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading = false
    }
  }

  const updateStatus = (service: ManagedServiceSnapshot): void => {
    const index = services.findIndex((entry) => entry.id === service.id)
    services =
      index === -1
        ? [...services, service]
        : services.map((entry, itemIndex) => (itemIndex === index ? service : entry))
    if (logService?.id === service.id) logService = service
  }

  const emptyService = (
    port: number,
    type: ManagedServiceDefinition['type']
  ): ManagedServiceDefinition => ({
    id: '',
    name: '',
    type,
    command: '',
    args: [],
    enabled: false,
    autoRestart: true,
    restartLimit: 3,
    startupTimeoutMs: 120_000,
    env: {},
    apiKey: type === 'mcpo' ? '' : undefined,
    mcpo:
      type === 'mcpo'
        ? { serverCommand: '', serverArgs: [], port, runnerCommand: 'uvx' }
        : undefined,
    remote: type === 'remote' ? { url: '' } : undefined
  })

  const openAdd = async (type: ManagedServiceDefinition['type']): Promise<void> => {
    error = ''
    editorError = ''
    const port = await window.electronAPI.suggestManagedServicePort()
    draft = emptyService(port, type)
    argsText = ''
    envEntries = []
    addMenuOpen = false
    editorOpen = true
  }

  const openEdit = async (service: ManagedServiceSnapshot): Promise<void> => {
    error = ''
    editorError = ''
    const full = await window.electronAPI.getManagedService(service.id)
    draft = full
    argsText = (full.type === 'mcpo' ? full.mcpo?.serverArgs : full.args)?.join('\n') ?? ''
    envEntries = Object.entries(full.env ?? {}).map(([key, value]) => ({ key, value }))
    editorOpen = true
  }

  const refreshMcpoPreview = async (): Promise<void> => {
    if (!draft || draft.type !== 'mcpo' || !draft.mcpo?.serverCommand.trim()) return
    const apiKey = draft.apiKey
    try {
      const preview = await window.electronAPI.previewManagedService({
        ...draft,
        id: draft.id || undefined,
        mcpo: {
          ...draft.mcpo,
          serverArgs: argsText.split(/\r?\n/).filter((entry) => entry.length > 0)
        }
      })
      draft = { ...preview, id: draft.id, apiKey }
      editorError = ''
    } catch (cause) {
      editorError = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const changeServiceType = async (nextType: ManagedServiceDefinition['type']): Promise<void> => {
    if (!draft || draft.type === nextType) return

    if (nextType === 'generic') {
      await refreshMcpoPreview()
      if (!draft) return
      argsText = draft.args.join('\n')
      draft = {
        ...draft,
        type: 'generic',
        mcpo: undefined,
        remote: undefined,
        apiKey: undefined,
        accessToken: undefined
      }
      return
    }

    if (nextType === 'remote') {
      draft = {
        ...draft,
        type: 'remote',
        command: '',
        args: [],
        mcpo: undefined,
        apiKey: undefined,
        remote: { url: draft.remote?.url ?? '' },
        accessToken: draft.accessToken ?? ''
      }
      argsText = ''
      return
    }

    const serverArgs = argsText.split(/\r?\n/).filter((entry) => entry.length > 0)
    const port = await window.electronAPI.suggestManagedServicePort()
    draft = {
      ...draft,
      type: 'mcpo',
      remote: undefined,
      apiKey: draft.apiKey ?? '',
      accessToken: undefined,
      mcpo: { serverCommand: draft.command, serverArgs, port, runnerCommand: 'uvx' }
    }
    argsText = serverArgs.join('\n')
    await refreshMcpoPreview()
  }

  const assignedPortWarning = (): string => {
    if (!draft || draft.type !== 'mcpo' || !draft.mcpo) return ''
    const collision = services.find(
      (service) => service.id !== draft?.id && service.mcpo?.port === draft?.mcpo?.port
    )
    return collision
      ? l(
          `Port ${draft.mcpo.port} wird bereits von ${collision.name} verwendet.`,
          `Port ${draft.mcpo.port} is already assigned to ${collision.name}.`
        )
      : ''
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    editorError = ''
    if (!draft.name.trim()) {
      editorError = l('Ein Anzeigename ist erforderlich.', 'A display name is required.')
      return
    }
    if (draft.type === 'generic' && !draft.command.trim()) {
      editorError = l('Ein Kommando ist erforderlich.', 'A command is required.')
      return
    }
    if (draft.type === 'mcpo' && !draft.mcpo?.serverCommand.trim()) {
      editorError = l(
        'Der Pfad zum MCP-Server ist erforderlich.',
        'The MCP server executable is required.'
      )
      return
    }
    if (draft.type === 'remote' && !draft.remote?.url.trim()) {
      editorError = l(
        'Eine Remote-Endpunkt-URL ist erforderlich.',
        'A remote endpoint URL is required.'
      )
      return
    }
    if (assignedPortWarning()) {
      editorError = assignedPortWarning()
      return
    }

    const env = Object.fromEntries(
      envEntries.filter((entry) => entry.key.trim()).map((entry) => [entry.key.trim(), entry.value])
    )
    const parsedArgs = argsText.split(/\r?\n/).filter((entry) => entry.length > 0)
    const payload = {
      ...draft,
      id: draft.id || undefined,
      name: draft.name.trim(),
      env,
      ...(draft.type === 'generic'
        ? { args: parsedArgs, mcpo: undefined, remote: undefined, accessToken: undefined }
        : draft.type === 'mcpo'
          ? {
              mcpo: { ...draft.mcpo!, serverArgs: parsedArgs },
              remote: undefined,
              accessToken: undefined
            }
          : { command: '', args: [], mcpo: undefined })
    } as ManagedServiceDefinition

    saving = true
    try {
      const saved = await window.electronAPI.saveManagedService(payload)
      updateStatus(saved)
      editorOpen = false
      draft = null
      if (saved.type === 'mcpo' || saved.type === 'remote') await showIntegration(saved)
      await refresh()
    } catch (cause) {
      editorError = cause instanceof Error ? cause.message : String(cause)
    } finally {
      saving = false
    }
  }

  const toggleEnabled = async (
    service: ManagedServiceSnapshot,
    enabled: boolean
  ): Promise<void> => {
    try {
      const full = await window.electronAPI.getManagedService(service.id)
      updateStatus(await window.electronAPI.saveManagedService({ ...full, enabled }))
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const toggleRunning = async (service: ManagedServiceSnapshot): Promise<void> => {
    try {
      const result =
        service.status === 'running' || service.status === 'starting'
          ? await window.electronAPI.stopManagedService(service.id)
          : await window.electronAPI.startManagedService(service.id)
      updateStatus(result)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const remove = async (service: ManagedServiceSnapshot): Promise<void> => {
    if (!window.confirm(l(`„${service.name}“ wirklich entfernen?`, `Remove “${service.name}”?`)))
      return
    try {
      await window.electronAPI.removeManagedService(service.id)
      await refresh()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const showIntegration = async (service: ManagedServiceSnapshot): Promise<void> => {
    try {
      integration = await window.electronAPI.getManagedServiceIntegration(service.id)
      integrationName = service.name
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const previewImport = async (): Promise<void> => {
    try {
      importPreview = await window.electronAPI.previewManagedServicesImport()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const confirmImport = async (): Promise<void> => {
    if (!importPreview) return
    try {
      services = await window.electronAPI.confirmManagedServicesImport(importPreview.token)
      importPreview = null
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const cancelImport = async (): Promise<void> => {
    if (importPreview) await window.electronAPI.cancelManagedServicesImport(importPreview.token)
    importPreview = null
  }

  const copy = async (value: string): Promise<void> => navigator.clipboard.writeText(value)

  const dotClass = (status: ManagedServiceSnapshot['status']): string => {
    if (status === 'running') return 'bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.6)]'
    if (status === 'starting') return 'bg-amber-400 animate-pulse'
    if (status === 'failed') return 'bg-red-400'
    return 'bg-black/15 dark:bg-white/20'
  }

  const generatedCommand = (): string => {
    if (!draft || draft.type !== 'mcpo' || !draft.mcpo) return ''
    const runner = draft.mcpo.runnerCommand || draft.command || 'uvx'
    const parts = [
      runner,
      '--refresh',
      '--with',
      'mcp==1.9.4',
      'mcpo',
      '--host',
      '127.0.0.1',
      '--port',
      String(draft.mcpo.port),
      '--api-key',
      '<encrypted-api-key>',
      '--',
      draft.mcpo.serverCommand || '<mcp-server>',
      ...argsText.split(/\r?\n/).filter(Boolean)
    ]
    return parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
  }

  const visibleServices = (): ManagedServiceSnapshot[] => {
    const normalizedQuery = query.trim().toLowerCase()
    return services.filter((service) => {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'running' && service.status === 'running') ||
        (filter === 'setup' && (service.status === 'failed' || !service.enabled))
      const matchesQuery =
        !normalizedQuery ||
        service.name.toLowerCase().includes(normalizedQuery) ||
        service.type.toLowerCase().includes(normalizedQuery)
      return matchesFilter && matchesQuery
    })
  }

  const serviceDetail = (service: ManagedServiceSnapshot): string => {
    if (service.lastError) return service.lastError
    if (service.type === 'mcpo') return `MCP → http://127.0.0.1:${service.mcpo?.port ?? ''}`
    if (service.type === 'remote') return service.remote?.url ?? ''
    return [service.command, ...service.args].filter(Boolean).join(' ')
  }

  onMount(() => {
    void refresh()
    unsubscribe = window.electronAPI.onData((message: MainDataMessage) => {
      if (message.type === 'managed-services:changed' && Array.isArray(message.data)) {
        services = message.data as ManagedServiceSnapshot[]
      }
      if (message.type === 'managed-service:status' && message.data) {
        updateStatus(message.data as ManagedServiceSnapshot)
      }
    })
  })

  onDestroy(() => unsubscribe?.())
</script>

<section class="py-2">
  <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
    <div class="max-w-xl">
      <div class="text-[14px] font-medium opacity-80">
        {l('Dienste & Konnektoren', 'Services & connectors')}
      </div>
      <div class="mt-1 text-[11px] leading-4 opacity-40">
        {l(
          'Lokale Prozesse, MCP-Adapter und externe Werkzeug-Endpunkte zentral verwalten.',
          'Manage local processes, MCP adapters, and external tool endpoints in one place.'
        )}
      </div>
    </div>
    <div class="flex shrink-0 gap-1.5">
      <button
        class="rounded-lg px-2.5 py-1.5 text-[10px] opacity-45 transition hover:bg-black/5 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 dark:hover:bg-white/10"
        onclick={() => window.electronAPI.exportManagedServices()}>{l('Export', 'Export')}</button
      >
      <button
        class="rounded-lg px-2.5 py-1.5 text-[10px] opacity-45 transition hover:bg-black/5 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 dark:hover:bg-white/10"
        onclick={previewImport}>{l('Import', 'Import')}</button
      >
      <div class="relative">
        <button
          class="rounded-lg bg-[#1d1d1f] px-3 py-1.5 text-[10px] text-white transition hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 dark:bg-white dark:text-[#111]"
          aria-expanded={addMenuOpen}
          onclick={() => (addMenuOpen = !addMenuOpen)}>+ {l('Hinzufügen', 'Add')}</button
        >
        {#if addMenuOpen}
          <div
            class="absolute right-0 top-8 z-30 w-60 rounded-xl border border-black/10 bg-[#f8f8fa] p-1.5 shadow-xl dark:border-white/10 dark:bg-[#1b1b1d]"
          >
            {#each [['mcpo', 'MCP → OpenAPI', l('Lokalen MCP-Server über mcpo bereitstellen', 'Expose a local MCP server through mcpo')], ['generic', l('Lokaler Prozess', 'Local process'), l('Beliebiges Kommando starten und überwachen', 'Run and monitor any command')], ['remote', l('Remote-Endpunkt', 'Remote endpoint'), l('Vorhandenen HTTP(S)-Werkzeugserver verbinden', 'Connect an existing HTTP(S) tool server')]] as item (item[0])}
              <button
                class="block w-full rounded-lg px-2.5 py-2 text-left transition hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 dark:hover:bg-white/10"
                onclick={() => openAdd(item[0] as ManagedServiceDefinition['type'])}
              >
                <span class="block text-[11px] font-medium opacity-75">{item[1]}</span>
                <span class="mt-0.5 block text-[9px] opacity-35">{item[2]}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div
    class="mb-4 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 rounded-xl border border-black/[0.06] bg-black/[0.018] px-3 py-2.5 dark:border-white/[0.07] dark:bg-white/[0.025]"
    aria-label={l('Verbindungsroute', 'Connector route')}
  >
    <div class="min-w-0">
      <div class="text-[9px] uppercase tracking-[0.14em] opacity-25">{l('Quelle', 'Source')}</div>
      <div class="truncate text-[11px] opacity-65">MCP · CLI · HTTPS</div>
    </div>
    <div class="h-px w-8 bg-gradient-to-r from-transparent to-emerald-500/45"></div>
    <div class="min-w-0 text-center">
      <div class="text-[9px] uppercase tracking-[0.14em] opacity-25">Adapter</div>
      <div class="truncate text-[11px] text-emerald-600/80 dark:text-emerald-300/80">Registry</div>
    </div>
    <div class="h-px w-8 bg-gradient-to-r from-emerald-500/45 to-transparent"></div>
    <div class="min-w-0 text-right">
      <div class="text-[9px] uppercase tracking-[0.14em] opacity-25">{l('Ziel', 'Target')}</div>
      <div class="truncate text-[11px] opacity-65">Open WebUI</div>
    </div>
  </div>

  {#if error}
    <div class="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-300">
      {error}
    </div>
  {/if}

  <div class="mb-2 flex flex-wrap items-center gap-2">
    <div class="flex rounded-lg bg-black/[0.035] p-0.5 dark:bg-white/[0.05]">
      {#each [['all', l('Alle', 'All')], ['running', l('Läuft', 'Running')], ['setup', l('Einrichtung nötig', 'Needs setup')]] as item (item[0])}
        <button
          class="rounded-md px-2.5 py-1 text-[10px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 {filter ===
          item[0]
            ? 'bg-white opacity-75 shadow-sm dark:bg-white/10'
            : 'opacity-35 hover:opacity-65'}"
          onclick={() => (filter = item[0] as typeof filter)}>{item[1]}</button
        >
      {/each}
    </div>
    <label class="relative ml-auto min-w-40 flex-1 sm:max-w-64">
      <span class="sr-only">{l('Dienste durchsuchen', 'Search services')}</span>
      <input
        class="w-full rounded-lg border border-black/[0.06] bg-transparent px-3 py-1.5 text-[10px] outline-none placeholder:opacity-30 focus:border-emerald-500/40 dark:border-white/[0.08]"
        placeholder={l('Dienste durchsuchen …', 'Search services…')}
        bind:value={query}
      />
    </label>
    <span class="text-[9px] tabular-nums opacity-25"
      >{visibleServices().length}/{services.length}</span
    >
  </div>

  <div class="space-y-1.5">
    {#if loading}
      <div
        class="rounded-xl border border-black/[0.05] px-4 py-8 text-center text-[11px] opacity-35 dark:border-white/[0.06]"
      >
        {l('Dienste werden geladen …', 'Loading services…')}
      </div>
    {:else if services.length === 0}
      <div
        class="rounded-xl border border-dashed border-black/10 px-5 py-10 text-center dark:border-white/10"
      >
        <div class="text-[12px] font-medium opacity-55">
          {l('Noch keine Dienste', 'No services yet')}
        </div>
        <div class="mx-auto mt-1 max-w-sm text-[10px] leading-4 opacity-30">
          {l(
            'Füge einen lokalen Prozess, MCP-Server oder vorhandenen Remote-Endpunkt hinzu. Persönliche Dienste werden nie vorinstalliert.',
            'Add a local process, MCP server, or existing remote endpoint. Personal services are never preinstalled.'
          )}
        </div>
        <button
          class="mt-3 rounded-lg bg-black/[0.07] px-3 py-1.5 text-[10px] opacity-65 hover:opacity-90 dark:bg-white/10"
          onclick={() => (addMenuOpen = true)}
          >+ {l('Ersten Dienst hinzufügen', 'Add first service')}</button
        >
      </div>
    {:else if visibleServices().length === 0}
      <div
        class="rounded-xl border border-black/[0.05] px-4 py-8 text-center text-[11px] opacity-35 dark:border-white/[0.06]"
      >
        {l('Keine passenden Dienste.', 'No matching services.')}
      </div>
    {/if}

    {#each visibleServices() as service (service.id)}
      <article
        class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl border border-transparent bg-black/[0.022] px-3 py-2.5 transition motion-reduce:transition-none hover:border-black/[0.06] hover:bg-black/[0.032] sm:grid-cols-[auto_minmax(150px,1fr)_auto] dark:bg-white/[0.028] dark:hover:border-white/[0.07] dark:hover:bg-white/[0.045]"
      >
        <span class={`h-2 w-2 shrink-0 rounded-full ${dotClass(service.status)}`}></span>
        <div class="min-w-0">
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate text-[12px] font-medium opacity-75">{service.name}</span>
            <span
              class="rounded bg-black/5 px-1.5 py-0.5 text-[8px] uppercase tracking-wide opacity-35 dark:bg-white/10"
            >
              {service.type === 'generic' ? 'local' : service.type}
            </span>
          </div>
          <div class="truncate font-mono text-[9px] opacity-30" title={serviceDetail(service)}>
            {serviceDetail(service)}
          </div>
        </div>
        <div
          class="col-span-2 ml-5 flex flex-wrap items-center justify-end gap-1 sm:col-span-1 sm:ml-0"
        >
          <span class="mr-1 text-[9px] capitalize opacity-30">{service.status}</span>
          <Switch
            checked={service.enabled}
            label={`${service.name} autostart`}
            onchange={(value) => toggleEnabled(service, value)}
          />
          <button
            class="rounded-lg px-2 py-1 text-[10px] opacity-45 hover:bg-black/5 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 dark:hover:bg-white/10"
            onclick={() => toggleRunning(service)}
            >{service.status === 'running' || service.status === 'starting'
              ? l('Stop', 'Stop')
              : l('Start', 'Start')}</button
          >
          <button
            class="rounded-lg px-2 py-1 text-[10px] opacity-45 hover:bg-black/5 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 dark:hover:bg-white/10"
            onclick={() => (logService = service)}>{l('Logs', 'Logs')}</button
          >
          {#if service.type === 'mcpo' || service.type === 'remote'}
            <button
              class="rounded-lg px-2 py-1 text-[10px] opacity-45 hover:bg-black/5 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 dark:hover:bg-white/10"
              onclick={() => showIntegration(service)}>{l('Verbindung', 'Connection')}</button
            >
          {/if}
          <button
            class="rounded-lg px-2 py-1 text-[10px] opacity-45 hover:bg-black/5 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 dark:hover:bg-white/10"
            onclick={() => openEdit(service)}>{l('Bearbeiten', 'Edit')}</button
          >
          <button
            class="rounded-lg px-2 py-1 text-[10px] text-red-500 opacity-30 hover:bg-red-500/10 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
            onclick={() => remove(service)}>{l('Entfernen', 'Remove')}</button
          >
        </div>
      </article>
    {/each}
  </div>
</section>

{#if editorOpen && draft}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-6"
    role="presentation"
    onclick={() => (editorOpen = false)}
  >
    <section
      class="max-h-[88vh] w-[min(720px,92vw)] overflow-auto rounded-2xl border border-black/10 bg-[#f5f5f7] p-5 shadow-2xl dark:border-white/10 dark:bg-[#171717]"
      role="dialog"
      aria-modal="true"
      onclick={(event) => event.stopPropagation()}
    >
      <div class="mb-4 flex items-center justify-between">
        <h3 class="m-0 text-[14px] font-medium">
          {draft.id
            ? l('Dienst bearbeiten', 'Edit service')
            : l('Dienst hinzufügen', 'Add service')}
        </h3>
        <button
          class="rounded-lg px-2 py-1 text-[11px] opacity-45 hover:bg-black/5 dark:hover:bg-white/10"
          onclick={() => (editorOpen = false)}>{l('Schließen', 'Close')}</button
        >
      </div>

      {#if editorError}
        <div
          class="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-300"
          role="alert"
        >
          {editorError}
        </div>
      {/if}

      <div class="grid grid-cols-2 gap-3">
        <label class="col-span-2 text-[11px] opacity-55"
          >{l('Typ', 'Type')}
          <select
            class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 outline-none dark:bg-white/10"
            value={draft.type}
            onchange={(event) =>
              changeServiceType(
                (event.currentTarget as HTMLSelectElement).value as ManagedServiceDefinition['type']
              )}
          >
            <option value="mcpo">mcpo (MCP → OpenAPI)</option>
            <option value="generic">{l('Lokaler Prozess', 'Local process')}</option>
            <option value="remote">{l('Remote-Endpunkt', 'Remote endpoint')}</option>
          </select>
        </label>
        <label class="col-span-2 text-[11px] opacity-55"
          >{l('Anzeigename', 'Display name')}
          <input
            class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 outline-none dark:bg-white/10"
            bind:value={draft.name}
          />
        </label>

        {#if draft.type === 'generic'}
          <label class="col-span-2 text-[11px] opacity-55"
            >Command
            <input
              class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              bind:value={draft.command}
            />
          </label>
          <label class="col-span-2 text-[11px] opacity-55"
            >{l('Argumente (eines pro Zeile)', 'Arguments (one per line)')}
            <textarea
              class="mt-1 h-24 w-full resize-y rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              bind:value={argsText}
            ></textarea>
          </label>
          <label class="text-[11px] opacity-55"
            >Working directory
            <input
              class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              bind:value={draft.cwd}
            />
          </label>
          <label class="text-[11px] opacity-55"
            >Health-check URL
            <input
              class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              placeholder="http://127.0.0.1:8000/health"
              bind:value={draft.healthCheckUrl}
            />
          </label>
        {:else if draft.mcpo}
          <label class="col-span-2 text-[11px] opacity-55"
            >{l('mcpo-Runner', 'mcpo runner')}
            <input
              class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              placeholder="uvx"
              bind:value={draft.mcpo.runnerCommand}
              onchange={refreshMcpoPreview}
            />
            <span class="mt-1 block text-[9px] leading-4 opacity-45">
              {l(
                '„uvx“ wird automatisch über PATH und übliche Python-Installationsordner gefunden. Alternativ einen absoluten Pfad eintragen.',
                '“uvx” is resolved through PATH and common Python install folders. You can also enter an absolute path.'
              )}
            </span>
          </label>
          <label class="col-span-2 text-[11px] opacity-55"
            >{l('MCP-Server-Executable', 'MCP server executable')}
            <input
              class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              placeholder="C:\\Users\\…\\.local\\bin\\server.exe"
              bind:value={draft.mcpo.serverCommand}
              onchange={refreshMcpoPreview}
            />
          </label>
          <label class="col-span-2 text-[11px] opacity-55"
            >{l('mcpo API-Key (optional, verschlüsselt)', 'mcpo API key (optional, encrypted)')}
            <input
              type="password"
              autocomplete="new-password"
              class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              placeholder={l(
                'Leer lassen, um einen sicheren Schlüssel zu erzeugen',
                'Leave empty to generate a secure key'
              )}
              bind:value={draft.apiKey}
            />
            <span class="mt-1 block text-[9px] leading-4 opacity-45">
              {l(
                'Bei einem bereits eingerichteten Open-WebUI-Eintrag denselben Schlüssel verwenden oder nach dem Speichern den neu erzeugten Bearer-Key übernehmen.',
                'Reuse the key from an existing Open WebUI entry, or copy the newly generated bearer key after saving.'
              )}
            </span>
          </label>
          <label class="text-[11px] opacity-55"
            >{l('Port', 'Port')}
            <input
              type="number"
              min="1"
              max="65535"
              class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 outline-none dark:bg-white/10"
              bind:value={draft.mcpo.port}
              onchange={refreshMcpoPreview}
            />
          </label>
          <label class="text-[11px] opacity-55"
            >{l('Server-Argumente (eines pro Zeile)', 'Server arguments (one per line)')}
            <textarea
              class="mt-1 h-20 w-full resize-y rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              bind:value={argsText}
              onchange={refreshMcpoPreview}
            ></textarea>
          </label>
          <label class="col-span-2 text-[11px] opacity-55"
            >{l('Generiertes Kommando (nur lesen)', 'Generated command (read-only)')}
            <textarea
              readonly
              class="mt-1 h-24 w-full resize-y rounded-lg border-none bg-black/[0.035] px-3 py-2 font-mono text-[10px] opacity-55 outline-none dark:bg-white/[0.05]"
              value={generatedCommand()}
            ></textarea>
          </label>
          {#if assignedPortWarning()}
            <div
              class="col-span-2 rounded-lg bg-amber-500/10 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300"
            >
              {assignedPortWarning()}
            </div>
          {/if}
        {:else if draft.type === 'remote' && draft.remote}
          <label class="col-span-2 text-[11px] opacity-55"
            >{l('HTTP(S)-Endpunkt', 'HTTP(S) endpoint')}
            <input
              class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              placeholder="https://tools.example.com"
              bind:value={draft.remote.url}
            />
            <span class="mt-1 block text-[9px] leading-4 opacity-45">
              {l(
                'Für GitHub, Gmail oder Kalender wird ein kompatibler Anbieter-Adapter bzw. Werkzeugserver benötigt; OAuth-Zugänge werden nicht vorgetäuscht oder mitgeliefert.',
                'GitHub, Gmail, and calendar providers need a compatible adapter or tool server; provider OAuth is not bundled or simulated.'
              )}
            </span>
          </label>
          <label class="col-span-2 text-[11px] opacity-55"
            >{l('Bearer-Token (optional, verschlüsselt)', 'Bearer token (optional, encrypted)')}
            <input
              type="password"
              autocomplete="off"
              class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 font-mono outline-none dark:bg-white/10"
              bind:value={draft.accessToken}
            />
          </label>
        {/if}

        <div class="col-span-2 mt-1 text-[11px] font-medium opacity-55">
          {l(
            'Umgebungsvariablen (verschlüsselt gespeichert)',
            'Environment variables (stored encrypted)'
          )}
        </div>
        <div class="col-span-2 space-y-1.5">
          {#each envEntries as entry, index (index)}
            <div class="grid grid-cols-[1fr_1.5fr_auto] gap-1.5">
              <input
                class="rounded-lg border-none bg-black/5 px-2.5 py-1.5 font-mono text-[10px] outline-none dark:bg-white/10"
                placeholder="KEY"
                bind:value={entry.key}
              />
              <input
                class="rounded-lg border-none bg-black/5 px-2.5 py-1.5 font-mono text-[10px] outline-none dark:bg-white/10"
                placeholder="value"
                bind:value={entry.value}
              />
              <button
                class="rounded-lg px-2 text-[10px] text-red-500 opacity-50 hover:bg-red-500/10"
                onclick={() =>
                  (envEntries = envEntries.filter((_, itemIndex) => itemIndex !== index))}>×</button
              >
            </div>
          {/each}
          <button
            class="rounded-lg px-2 py-1 text-[10px] opacity-45 hover:bg-black/5 dark:hover:bg-white/10"
            onclick={() => (envEntries = [...envEntries, { key: '', value: '' }])}>+ Env</button
          >
        </div>

        <label class="text-[11px] opacity-55"
          >Restart limit
          <input
            type="number"
            min="0"
            max="20"
            class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 outline-none dark:bg-white/10"
            bind:value={draft.restartLimit}
          />
        </label>
        <label class="text-[11px] opacity-55"
          >Startup timeout (ms)
          <input
            type="number"
            min="1000"
            max="600000"
            step="1000"
            class="mt-1 w-full rounded-lg border-none bg-black/5 px-3 py-2 outline-none dark:bg-white/10"
            bind:value={draft.startupTimeoutMs}
          />
        </label>
        <div
          class="flex items-center justify-between rounded-lg bg-black/[0.025] px-3 py-2 dark:bg-white/[0.035]"
        >
          <span class="text-[11px] opacity-55">Autostart</span><Switch
            checked={draft.enabled}
            label="Autostart"
            onchange={(value) => {
              if (draft) draft.enabled = value
            }}
          />
        </div>
        <div
          class="flex items-center justify-between rounded-lg bg-black/[0.025] px-3 py-2 dark:bg-white/[0.035]"
        >
          <span class="text-[11px] opacity-55">Auto-restart</span><Switch
            checked={draft.autoRestart}
            label="Auto-restart"
            onchange={(value) => {
              if (draft) draft.autoRestart = value
            }}
          />
        </div>
      </div>

      <div class="mt-4 flex justify-end gap-2">
        <button
          class="rounded-lg px-3 py-1.5 text-[11px] opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
          onclick={() => (editorOpen = false)}>{l('Abbrechen', 'Cancel')}</button
        >
        <button
          class="rounded-lg bg-black/[0.08] px-3 py-1.5 text-[11px] disabled:opacity-30 dark:bg-white/[0.12]"
          disabled={saving}
          onclick={save}>{saving ? l('Speichern …', 'Saving…') : l('Speichern', 'Save')}</button
        >
      </div>
    </section>
  </div>
{/if}

{#if logService}
  <ManagedServiceLogs
    id={logService.id}
    name={logService.name}
    onClose={() => (logService = null)}
  />
{/if}

{#if integration}
  <div
    class="fixed inset-0 z-[110] flex items-center justify-center bg-black/35 p-6"
    role="presentation"
    onclick={() => (integration = null)}
  >
    <section
      class="w-[min(720px,92vw)] rounded-2xl border border-black/10 bg-[#f5f5f7] p-5 shadow-2xl dark:border-white/10 dark:bg-[#171717]"
      role="dialog"
      aria-modal="true"
      onclick={(event) => event.stopPropagation()}
    >
      <h3 class="m-0 text-[14px] font-medium">{integrationName}: Open WebUI</h3>
      <p class="text-[11px] opacity-45">
        {l(
          'Unter Integrationen → Externe Werkzeug-Server mit Auth-Typ „Bearer“ eintragen. Im Schlüssel-Feld nur den Wert ohne „Bearer “ verwenden und einen alten Schlüssel vollständig ersetzen:',
          'Enter these values under Integrations → External Tool Servers using the “Bearer” auth type. Put only the value without “Bearer ” in the key field and fully replace any old key:'
        )}
      </p>
      {#each [[l('URL', 'URL'), integration.url], [l('Bearer-Key', 'Bearer key'), integration.bearerKey], [l('Kommando', 'Command'), integration.commandPreview]] as item (item[0])}
        <div class="mb-2 rounded-xl bg-black/[0.035] p-3 dark:bg-white/[0.05]">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[10px] opacity-35">{item[0]}</span><button
              class="rounded px-2 py-0.5 text-[10px] opacity-45 hover:bg-black/5 dark:hover:bg-white/10"
              onclick={() => copy(item[1])}>Copy</button
            >
          </div>
          <code class="block break-all text-[10px] opacity-65">{item[1]}</code>
        </div>
      {/each}
      <div class="mt-4 flex justify-end">
        <button
          class="rounded-lg bg-black/[0.08] px-3 py-1.5 text-[11px] dark:bg-white/[0.12]"
          onclick={() => (integration = null)}>{l('Fertig', 'Done')}</button
        >
      </div>
    </section>
  </div>
{/if}

{#if importPreview}
  <div
    class="fixed inset-0 z-[110] flex items-center justify-center bg-black/35 p-6"
    role="presentation"
    onclick={cancelImport}
  >
    <section
      class="max-h-[82vh] w-[min(760px,92vw)] overflow-auto rounded-2xl border border-black/10 bg-[#f5f5f7] p-5 shadow-2xl dark:border-white/10 dark:bg-[#171717]"
      role="dialog"
      aria-modal="true"
      onclick={(event) => event.stopPropagation()}
    >
      <h3 class="m-0 text-[14px] font-medium">{l('Import bestätigen', 'Confirm import')}</h3>
      <p class="text-[11px] opacity-45">
        {l(
          'Diese Registry ersetzt die aktuelle Liste. Prüfe alle enthaltenen Kommandos:',
          'This registry replaces the current list. Review every command before continuing:'
        )}
      </p>
      <div class="space-y-2">
        {#each importPreview.services as service (service.id)}
          <div class="rounded-xl bg-black/[0.035] p-3 dark:bg-white/[0.05]">
            <div class="mb-1 text-[11px] font-medium opacity-65">
              {service.name} · {service.type}
            </div>
            <code class="block break-all text-[10px] opacity-50">{service.commandPreview}</code>
          </div>
        {/each}
      </div>
      {#each importPreview.warnings as warning (warning)}<div
          class="mt-2 rounded-lg bg-amber-500/10 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300"
        >
          {warning}
        </div>{/each}
      <div class="mt-4 flex justify-end gap-2">
        <button
          class="rounded-lg px-3 py-1.5 text-[11px] opacity-50 hover:bg-black/5 dark:hover:bg-white/10"
          onclick={cancelImport}>{l('Abbrechen', 'Cancel')}</button
        ><button
          class="rounded-lg bg-black/[0.08] px-3 py-1.5 text-[11px] dark:bg-white/[0.12]"
          onclick={confirmImport}
          >{l('Kommandos bestätigen und importieren', 'Confirm commands and import')}</button
        >
      </div>
    </section>
  </div>
{/if}
