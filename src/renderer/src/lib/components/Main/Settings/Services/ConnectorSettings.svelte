<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type {
    ManagedServiceDefinition,
    ManagedServiceImportPreview,
    ManagedServiceIntegration,
    ManagedServiceSnapshot
  } from '../../../../../../../shared/services/types'
  import { toIpcPlainValue } from '../../../../../../../shared/services/ipc-serialization'
  import ManagedServiceLogs from '../../../../services/ManagedServiceLogs.svelte'
  import ConnectorDialog from './ConnectorDialog.svelte'
  import ConnectorIcon from './ConnectorIcon.svelte'
  import { connectorPayload } from './connector-payload'
  import {
    connectorForService,
    connectorStatus,
    searchConnectors,
    type ConnectorCatalogEntry
  } from './connector-catalog'

  type EnvEntry = { key: string; value: string }
  type ServiceType = ManagedServiceDefinition['type']
  let services = $state<ManagedServiceSnapshot[]>([])
  let loading = $state(true)
  let error = $state('')
  let notice = $state('')
  let view = $state<'discover' | 'mine'>('mine')
  let filter = $state<'all' | 'running' | 'setup'>('all')
  let query = $state('')
  let busyIds = $state<string[]>([])
  let preparing = $state(false)
  let saving = $state(false)
  let editorError = $state('')
  let draft = $state<ManagedServiceDefinition | null>(null)
  let argsText = $state('')
  let envEntries = $state<EnvEntry[]>([])
  let editorAdvanced = $state(false)
  let guide = $state<ConnectorCatalogEntry | null>(null)
  let logService = $state<ManagedServiceSnapshot | null>(null)
  let integration = $state<ManagedServiceIntegration | null>(null)
  let integrationName = $state('')
  let revealKey = $state(false)
  let importPreview = $state<ManagedServiceImportPreview | null>(null)
  let importBusy = $state(false)
  let unsubscribe: (() => void) | null = null
  const german =
    typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('de')
  const l = (de: string, en: string): string => (german ? de : en)
  const message = (cause: unknown): string =>
    cause instanceof Error ? cause.message : String(cause)
  const googleScopes: Record<string, string> = {
    gmail: 'https://www.googleapis.com/auth/gmail.readonly',
    'google-drive': 'https://www.googleapis.com/auth/drive.readonly',
    'google-calendar':
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly'
  }
  const visibleServices = $derived(
    services.filter((service) => {
      const matches =
        filter === 'all' ||
        (filter === 'running' && service.status === 'running') ||
        (filter === 'setup' && service.status === 'failed')
      return (
        matches &&
        `${service.name} ${service.type}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
      )
    })
  )
  const providers = $derived(searchConnectors(query, german))
  const githubDraft = $derived(draft ? connectorForService(draft)?.id === 'github' : false)
  function updateStatus(service: ManagedServiceSnapshot): void {
    services = services.some((entry) => entry.id === service.id)
      ? services.map((entry) => (entry.id === service.id ? service : entry))
      : [...services, service]
    if (logService?.id === service.id) logService = service
  }
  async function refresh(): Promise<void> {
    loading = true
    try {
      services = await window.electronAPI.listManagedServices()
      error = ''
    } catch (cause) {
      error = message(cause)
    } finally {
      loading = false
    }
  }
  function emptyService(type: ServiceType, port = 0): ManagedServiceDefinition {
    return {
      id: '',
      name: '',
      type,
      command: '',
      args: [],
      enabled: true,
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
    }
  }
  async function openAdd(type: ServiceType, provider?: ConnectorCatalogEntry): Promise<void> {
    if (preparing) return
    preparing = true
    error = ''
    editorError = ''
    notice = ''
    try {
      const port = type === 'mcpo' ? await window.electronAPI.suggestManagedServicePort() : 0
      draft = emptyService(type, port)
      if (provider?.setup === 'github') {
        draft.name = 'GitHub MCP'
        draft.remote = { url: provider.endpoint! }
        draft.accessToken = ''
      }
      argsText = ''
      envEntries = []
      editorAdvanced = false
    } catch (cause) {
      error = message(cause)
    } finally {
      preparing = false
    }
  }
  async function openEdit(service: ManagedServiceSnapshot): Promise<void> {
    if (preparing) return
    preparing = true
    error = ''
    editorError = ''
    notice = ''
    try {
      const full = await window.electronAPI.getManagedService(service.id)
      draft = full
      argsText = (full.type === 'mcpo' ? full.mcpo?.serverArgs : full.args)?.join('\n') ?? ''
      envEntries = Object.entries(full.env ?? {}).map(([key, value]) => ({ key, value }))
      editorAdvanced = false
    } catch (cause) {
      error = message(cause)
    } finally {
      preparing = false
    }
  }
  function configuredProvider(provider: ConnectorCatalogEntry): ManagedServiceSnapshot | undefined {
    return services.find((service) => connectorForService(service)?.id === provider.id)
  }
  async function chooseProvider(provider: ConnectorCatalogEntry): Promise<void> {
    const existing = configuredProvider(provider)
    if (existing) {
      await openEdit(existing)
      return
    }
    if (provider.setup === 'google') {
      guide = provider
      notice = ''
      return
    }
    await openAdd(provider.setup === 'mcpo' ? 'mcpo' : 'remote', provider)
  }
  async function changeType(type: ServiceType): Promise<void> {
    if (!draft || type === draft.type) return
    try {
      if (type === 'mcpo') {
        const port = await window.electronAPI.suggestManagedServicePort()
        draft = {
          ...draft,
          type,
          mcpo: {
            serverCommand: draft.command,
            serverArgs: argsText.split(/\r?\n/).filter(Boolean),
            port,
            runnerCommand: 'uvx'
          },
          remote: undefined,
          accessToken: undefined,
          apiKey: ''
        }
      } else if (type === 'remote') {
        draft = {
          ...draft,
          type,
          command: '',
          args: [],
          mcpo: undefined,
          apiKey: undefined,
          remote: { url: '' },
          accessToken: ''
        }
        argsText = ''
      } else {
        if (draft.type === 'mcpo') {
          const preview = await window.electronAPI.previewManagedService(
            toIpcPlainValue({
              ...draft,
              mcpo: { ...draft.mcpo!, serverArgs: argsText.split(/\r?\n/).filter(Boolean) }
            })
          )
          draft = { ...preview, id: draft.id }
          argsText = draft.args.join('\n')
        }
        draft = {
          ...draft,
          type,
          mcpo: undefined,
          remote: undefined,
          apiKey: undefined,
          accessToken: undefined
        }
      }
    } catch (cause) {
      editorError = message(cause)
    }
  }
  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!draft || saving) return
    editorError = ''
    if (!draft.name.trim()) {
      editorError = l('Gib einen Namen für die Verbindung ein.', 'Enter a name for the connection.')
      return
    }
    if (draft.type === 'generic' && !draft.command.trim()) {
      editorError = l('Gib das auszuführende Programm ein.', 'Enter the program to run.')
      return
    }
    if (draft.type === 'mcpo' && !draft.mcpo?.serverCommand.trim()) {
      editorError = l('Gib das Programm deines MCP-Servers ein.', 'Enter your MCP server program.')
      return
    }
    if (draft.type === 'remote') {
      try {
        const url = new URL(draft.remote?.url.trim() ?? '')
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new Error()
      } catch {
        editorError = l(
          'Gib eine gültige HTTP(S)-Serveradresse ohne Zugangsdaten in der URL ein.',
          'Enter a valid HTTP(S) server address without credentials in the URL.'
        )
        return
      }
      if (githubDraft && !draft.accessToken?.trim()) {
        editorError = l(
          'GitHub benötigt ein Personal Access Token mit nur den benötigten Rechten.',
          'GitHub requires a Personal Access Token with only the permissions you need.'
        )
        return
      }
    }
    if (
      draft.type === 'mcpo' &&
      argsText.includes('ghcr.io/github/github-mcp-server') &&
      !envEntries.find((entry) => entry.key === 'GITHUB_PERSONAL_ACCESS_TOKEN')?.value.trim()
    ) {
      editorError = l(
        'Die GitHub-Docker-Vorlage benötigt GITHUB_PERSONAL_ACCESS_TOKEN unter Erweitert.',
        'The GitHub Docker preset requires GITHUB_PERSONAL_ACCESS_TOKEN under Advanced.'
      )
      editorAdvanced = true
      return
    }
    if (
      draft.type === 'mcpo' &&
      services.some(
        (service) => service.id !== draft?.id && service.mcpo?.port === draft?.mcpo?.port
      )
    ) {
      editorError = l(
        'Dieser Port ist bereits belegt. Wähle unter „Erweitert“ einen anderen.',
        'This port is already assigned. Choose a different one under Advanced.'
      )
      editorAdvanced = true
      return
    }
    const payload = connectorPayload(draft, argsText, envEntries)
    saving = true
    try {
      const saved = await window.electronAPI.saveManagedService(toIpcPlainValue(payload))
      updateStatus(saved)
      draft = null
      view = 'mine'
      query = ''
      filter = 'all'
      notice = l(
        `${saved.name} wurde gespeichert. Den aktuellen Status siehst du unten.`,
        `${saved.name} was saved. Its current status appears below.`
      )
    } catch (cause) {
      editorError = message(cause)
    } finally {
      saving = false
    }
  }
  async function runAction(
    service: ManagedServiceSnapshot,
    action: 'start' | 'stop' | 'remove'
  ): Promise<void> {
    if (busyIds.includes(service.id)) return
    if (
      action === 'remove' &&
      !window.confirm(
        l(
          `„${service.name}“ entfernen? Die gespeicherte Verbindung wird gelöscht.`,
          `Remove “${service.name}”? Its saved connection will be deleted.`
        )
      )
    )
      return
    busyIds = [...busyIds, service.id]
    error = ''
    notice = ''
    try {
      if (action === 'remove') {
        await window.electronAPI.removeManagedService(service.id)
        services = services.filter((entry) => entry.id !== service.id)
      } else if (action === 'start' && service.type !== 'generic' && !service.enabled) {
        const full = await window.electronAPI.getManagedService(service.id)
        updateStatus(
          await window.electronAPI.saveManagedService(toIpcPlainValue({ ...full, enabled: true }))
        )
      } else
        updateStatus(
          await (action === 'start'
            ? window.electronAPI.startManagedService(service.id)
            : window.electronAPI.stopManagedService(service.id))
        )
    } catch (cause) {
      error = message(cause)
    } finally {
      busyIds = busyIds.filter((id) => id !== service.id)
    }
  }
  async function showIntegration(service: ManagedServiceSnapshot): Promise<void> {
    error = ''
    notice = ''
    try {
      integration = await window.electronAPI.getManagedServiceIntegration(service.id)
      integrationName = service.name
      revealKey = false
    } catch (cause) {
      error = message(cause)
    }
  }
  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      notice = l('In die Zwischenablage kopiert.', 'Copied to clipboard.')
    } catch (cause) {
      error = message(cause)
    }
  }
  async function external(url: string): Promise<void> {
    try {
      await window.electronAPI.openInBrowser(url)
    } catch (cause) {
      error = message(cause)
    }
  }
  async function exportServices(): Promise<void> {
    try {
      await window.electronAPI.exportManagedServices()
    } catch (cause) {
      error = message(cause)
    }
  }
  async function previewImport(): Promise<void> {
    try {
      importPreview = await window.electronAPI.previewManagedServicesImport()
    } catch (cause) {
      error = message(cause)
    }
  }
  async function confirmImport(): Promise<void> {
    if (!importPreview || importBusy) return
    importBusy = true
    try {
      services = await window.electronAPI.confirmManagedServicesImport(importPreview.token)
      importPreview = null
      view = 'mine'
      query = ''
      filter = 'all'
    } catch (cause) {
      error = message(cause)
    } finally {
      importBusy = false
    }
  }
  async function cancelImport(): Promise<void> {
    if (!importPreview || importBusy) return
    try {
      await window.electronAPI.cancelManagedServicesImport(importPreview.token)
      importPreview = null
    } catch (cause) {
      error = message(cause)
    }
  }
  function openWebUIIntegrations(): void {
    guide = null
    window.dispatchEvent(new CustomEvent('desktop:open-webui-integrations'))
  }
  onMount(() => {
    void refresh()
    unsubscribe = window.electronAPI.onData((event: { type: string; data?: unknown }) => {
      if (event.type === 'managed-services:changed' && Array.isArray(event.data))
        services = event.data as ManagedServiceSnapshot[]
      if (event.type === 'managed-service:status' && event.data)
        updateStatus(event.data as ManagedServiceSnapshot)
    })
  })
  onDestroy(() => unsubscribe?.())
</script>

<section class="connectors" aria-label={l('Dienste und Konnektoren', 'Services and connectors')}>
  <header class="page-heading">
    <div>
      <h2>{l('Verbinde deine Werkzeuge', 'Connect your tools')}</h2>
      <p>
        {l(
          'Deine Konten und lokalen Dienste an einem Ort.',
          'Your accounts and local services in one place.'
        )}
      </p>
    </div>
    <button
      class="primary"
      disabled={preparing}
      onclick={() => {
        view = 'discover'
        query = ''
      }}>{l('Hinzufügen', 'Add connection')}</button
    >
  </header>
  <nav class="tabs" aria-label={l('Konnektoren anzeigen', 'Connector views')}>
    <button
      class:active={view === 'discover'}
      aria-pressed={view === 'discover'}
      onclick={() => {
        view = 'discover'
        query = ''
      }}>{l('Entdecken', 'Discover')}</button
    >
    <button
      class:active={view === 'mine'}
      aria-pressed={view === 'mine'}
      onclick={() => {
        view = 'mine'
        query = ''
      }}>{l('Deine', 'Yours')} <span class="count">{services.length}</span></button
    >
  </nav>
  <div class="search-row">
    <label class="search"
      ><span class="sr-only">{l('Konnektoren durchsuchen', 'Search connectors')}</span><svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg
      ><input
        type="search"
        bind:value={query}
        placeholder={l('Konnektoren durchsuchen …', 'Search connectors…')}
      /></label
    >
    {#if view === 'mine'}<label class="filter"
        ><span class="sr-only">{l('Status filtern', 'Filter status')}</span><select
          bind:value={filter}
          ><option value="all">{l('Alle Status', 'All statuses')}</option><option value="running"
            >{l('Läuft', 'Running')}</option
          ><option value="setup">{l('Prüfung nötig', 'Needs attention')}</option></select
        ></label
      >{/if}
  </div>
  {#if error}<div class="feedback error" role="alert">
      {error}<button onclick={refresh}>{l('Erneut prüfen', 'Check again')}</button>
    </div>{/if}
  {#if notice}<div class="feedback" role="status">{notice}</div>{/if}
  {#if preparing}<p class="muted" role="status">
      {l('Verbindung wird vorbereitet …', 'Preparing connection…')}
    </p>{/if}
  {#if view === 'discover'}
    <div class="section-label">
      <h3>{l('Für deinen Arbeitsalltag', 'For your everyday work')}</h3>
    </div>
    <div class="provider-grid">
      {#each providers as provider (provider.id)}
        {@const existing = configuredProvider(provider)}
        <article class="provider-card">
          <div class="provider-icon"><ConnectorIcon icon={provider.icon} /></div>
          <div class="provider-copy">
            <h4>
              {!german && provider.id === 'custom-remote'
                ? 'Custom connection'
                : !german && provider.id === 'local-mcp'
                  ? 'Local connector'
                  : !german && provider.id === 'google-calendar'
                    ? 'Google Calendar'
                    : provider.name}
            </h4>
            <p>{provider.description[german ? 0 : 1]}</p>
            {#if provider.preview}<span class="badge">Developer Preview</span>{/if}
          </div>
          <button
            class="secondary card-action"
            disabled={preparing || loading}
            aria-label={`${existing ? l('Verwalten', 'Manage') : l('Einrichten', 'Set up')}: ${provider.name}`}
            onclick={() => chooseProvider(provider)}
            >{existing ? l('Verwalten', 'Manage') : l('Einrichten', 'Set up')}</button
          >
        </article>
      {/each}
    </div>
    {#if providers.length === 0}<div class="empty">
        <h3>{l('Kein passender Konnektor', 'No matching connector')}</h3>
        <p>
          {l(
            'Suche nach einem anderen Namen oder füge einen eigenen Server hinzu.',
            'Try another name or add your own server.'
          )}
        </p>
        <button class="secondary" onclick={() => openAdd('remote')}
          >{l('Eigene Verbindung', 'Custom connection')}</button
        >
      </div>{/if}
    <p class="footnote">
      {l(
        'Eine Einrichtung ist noch keine Freigabe. Du entscheidest beim Anbieter, auf welche Daten zugegriffen werden darf.',
        'Setup does not grant access. You decide with each provider which data may be accessed.'
      )}
    </p>
  {:else}
    <div class="section-label">
      <h3>{l('Deine Verbindungen', 'Your connections')}</h3>
      <button class="text-button" disabled={loading} onclick={refresh}
        >{l('Aktualisieren', 'Refresh')}</button
      >
    </div>
    {#if loading}<div class="empty" role="status">
        {l('Verbindungen werden geladen …', 'Loading connections…')}
      </div>
    {:else if visibleServices.length === 0}<div class="empty">
        <ConnectorIcon />
        <h3>
          {services.length
            ? l('Keine passenden Verbindungen', 'No matching connections')
            : l('Deine Werkzeuge fehlen noch', 'Your tools belong here')}
        </h3>
        <p>
          {services.length
            ? l(
                'Passe deine Suche oder den Statusfilter an.',
                'Change your search or status filter.'
              )
            : l(
                'Wähle unter „Entdecken“ einen Konnektor aus. Bestehende Dienste bleiben unverändert.',
                'Choose a connector under Discover. Existing services are left unchanged.'
              )}
        </p>
        <button
          class="secondary"
          onclick={() => {
            view = 'discover'
            query = ''
          }}>{l('Konnektoren entdecken', 'Discover connectors')}</button
        >
      </div>{/if}
    <div class="service-list">
      {#each visibleServices as service (service.id)}
        {@const working = service.status === 'running' || service.status === 'starting'}
        <article class="service-card">
          <div class="service-main">
            <div class="provider-icon">
              <ConnectorIcon
                icon={connectorForService(service)?.icon ??
                  (service.type === 'generic' ? 'terminal' : 'plug')}
              />
            </div>
            <div class="provider-copy">
              <h4>{service.name}</h4>
              <p>
                {service.type === 'generic'
                  ? l('Lokaler Dienst', 'Local service')
                  : l('Werkzeuge für deine Chats', 'Tools for your chats')} · {service.type ===
                'generic'
                  ? service.enabled
                    ? l('Automatischer Start', 'Automatic start')
                    : l('Manueller Start', 'Manual start')
                  : service.enabled
                    ? l('Für Chats aktiviert', 'Enabled for chats')
                    : l('Für Chats deaktiviert', 'Disabled for chats')}
              </p>
            </div>
            <span class="status" data-status={service.status}
              ><span></span>{connectorStatus(service, german)}</span
            >
          </div>
          {#if service.lastError}<p class="service-error">{service.lastError}</p>{/if}
          <div class="service-actions">
            <button
              class="secondary"
              disabled={busyIds.includes(service.id)}
              onclick={() => runAction(service, working ? 'stop' : 'start')}
              >{busyIds.includes(service.id)
                ? l('Bitte warten …', 'Please wait…')
                : working
                  ? l('Pausieren', 'Pause')
                  : service.type === 'remote'
                    ? l('Verbinden', 'Connect')
                    : l('Starten', 'Start')}</button
            ><button class="text-button" disabled={preparing} onclick={() => openEdit(service)}
              >{l('Verwalten', 'Manage')}</button
            ><button class="text-button" onclick={() => (logService = service)}
              >{l('Protokoll', 'Logs')}</button
            >
            <details class="service-more">
              <summary>{l('Details', 'Details')}</summary>
              <div class="details-actions">
                {#if service.type !== 'generic'}<button
                    class="text-button"
                    onclick={() => showIntegration(service)}
                    >{l('Verbindungsdetails', 'Connection details')}</button
                  >{/if}<button
                  class="text-button danger"
                  disabled={busyIds.includes(service.id)}
                  onclick={() => runAction(service, 'remove')}>{l('Entfernen …', 'Remove…')}</button
                >
              </div>
            </details>
          </div>
        </article>
      {/each}
    </div>
    <p class="footnote">
      {l(
        'Aktivierte, erreichbare Konnektoren werden automatisch für deine Chats bereitgestellt. „Pausieren“ stoppt die Verbindung jetzt. Unter „Verwalten“ kannst du sie dauerhaft deaktivieren.',
        'Enabled, reachable connectors are made available to your chats automatically. Pause stops the connection now. Disable it permanently under Manage.'
      )}
    </p>
  {/if}
  <details class="advanced-tools">
    <summary>{l('Erweitert', 'Advanced')}</summary>
    <p>
      {l(
        'Für vorhandene Konfigurationen oder eigene Programme.',
        'For existing configurations or custom programs.'
      )}
    </p>
    <div class="inline-actions">
      <button class="secondary" onclick={previewImport}>{l('Importieren …', 'Import…')}</button
      ><button class="secondary" onclick={exportServices}>{l('Exportieren …', 'Export…')}</button
      ><button class="secondary" disabled={preparing} onclick={() => openAdd('generic')}
        >{l('Lokalen Prozess hinzufügen', 'Add local process')}</button
      >
    </div>
  </details>
</section>

{#if draft}
  <ConnectorDialog
    title={draft.id
      ? `${draft.name} · ${l('Verwalten', 'Manage')}`
      : githubDraft
        ? l('GitHub verbinden', 'Connect GitHub')
        : l('Verbindung einrichten', 'Set up connection')}
    closeLabel={l('Schließen', 'Close')}
    busy={saving}
    onClose={() => (draft = null)}
  >
    <form class="connector-form" onsubmit={save}>
      {#if editorError}<div class="feedback error" role="alert">{editorError}</div>{/if}
      {#if githubDraft}<p class="intro">
          {l(
            'Verbinde den offiziellen GitHub-Server mit einem persönlichen Zugriffstoken. Kein Docker nötig.',
            'Connect the official GitHub server with a Personal Access Token. No Docker required.'
          )}
        </p>{/if}
      <label
        >{l('Name', 'Name')}<input
          required
          bind:value={draft.name}
          placeholder={l('z. B. Mein Konnektor', 'e.g. My connector')}
        /></label
      >
      {#if draft.type === 'remote' && draft.remote}
        {#if !githubDraft}<label
            >{l('Serveradresse', 'Server address')}<input
              type="url"
              required
              bind:value={draft.remote.url}
              placeholder="https://example.com/mcp"
            /><small
              >{l(
                'MCP-Server mit Streamable HTTP. Für OAuth-Anbieter nutze deren Einrichtungsanleitung unter „Entdecken“.',
                'MCP server using Streamable HTTP. For OAuth providers, use the setup guide under Discover.'
              )}</small
            ></label
          >{/if}
        <label
          >{githubDraft
            ? l('Personal Access Token', 'Personal Access Token')
            : l('Zugriffstoken (optional)', 'Access token (optional)')}<input
            type="password"
            autocomplete="off"
            required={githubDraft}
            bind:value={draft.accessToken}
          /><small
            >{l(
              'Wird lokal verschlüsselt gespeichert. Teile nur die benötigten Berechtigungen.',
              'Stored encrypted on this computer. Grant only the permissions you need.'
            )}</small
          ></label
        >
        {#if githubDraft}<button
            type="button"
            class="text-button inline-link"
            onclick={() => external('https://github.com/settings/personal-access-tokens/new')}
            >{l('Token bei GitHub erstellen ↗', 'Create a token on GitHub ↗')}</button
          >{/if}
      {:else if draft.type === 'mcpo' && draft.mcpo}
        <p class="intro">
          {l(
            'Verbinde einen bereits installierten MCP-Server. Desktop übernimmt den lokalen Adapter und erzeugt den Verbindungsschlüssel.',
            'Connect an installed MCP server. Desktop manages the local adapter and generates the connection key.'
          )}
        </p>
        <label
          >{l('Serverprogramm', 'Server program')}<input
            required
            bind:value={draft.mcpo.serverCommand}
            placeholder={l('Programmname oder vollständiger Pfad', 'Program name or full path')}
          /></label
        >
        <label
          >{l('Argumente (eines pro Zeile)', 'Arguments (one per line)')}<textarea
            rows="3"
            bind:value={argsText}
          ></textarea><small
            >{l(
              'Die Startanleitung deines MCP-Servers nennt Programm und Argumente.',
              'Your MCP server’s setup instructions specify its program and arguments.'
            )}</small
          ></label
        >
      {:else}
        <label>{l('Programm', 'Program')}<input required bind:value={draft.command} /></label><label
          >{l('Argumente (eines pro Zeile)', 'Arguments (one per line)')}<textarea
            rows="3"
            bind:value={argsText}
          ></textarea></label
        >
      {/if}
      <label class="check-row"
        ><input type="checkbox" bind:checked={draft.enabled} /><span
          >{draft.type === 'generic'
            ? l('Automatisch mit Desktop starten', 'Start automatically with Desktop')
            : l(
                'In Chats verwenden und automatisch starten',
                'Use in chats and start automatically'
              )}<small
            >{draft.type === 'generic'
              ? l(
                  'Bei Aktivierung wird der Dienst auch jetzt gestartet.',
                  'Enabling this also starts the service now.'
                )
              : l(
                  'Aktivieren verbindet jetzt und bei jedem Desktop-Start. Deaktivieren entfernt die Werkzeuge aus den Chats.',
                  'Enabling connects now and on every Desktop startup. Disabling removes its tools from chats.'
                )}</small
          ></span
        ></label
      >
      <details class="editor-advanced" bind:open={editorAdvanced}>
        <summary>{l('Erweitert', 'Advanced')}</summary>
        <div class="advanced-fields">
          <label
            >{l('Verbindungstyp', 'Connection type')}<select
              value={draft.type}
              onchange={(event) => changeType(event.currentTarget.value as ServiceType)}
              ><option value="remote">{l('Remote-MCP (HTTP)', 'Remote MCP (HTTP)')}</option><option
                value="mcpo">{l('Lokaler MCP-Server', 'Local MCP server')}</option
              ><option value="generic">{l('Lokaler Prozess', 'Local process')}</option></select
            ></label
          >
          {#if githubDraft && draft.remote}<label
              >{l('Serveradresse', 'Server address')}<input
                type="url"
                bind:value={draft.remote.url}
              /></label
            >{/if}
          {#if draft.mcpo}<div class="form-columns">
              <label
                >{l('Lokaler Port', 'Local port')}<input
                  type="number"
                  min="1"
                  max="65535"
                  required
                  bind:value={draft.mcpo.port}
                /></label
              ><label
                >{l('Adapterprogramm', 'Adapter program')}<input
                  bind:value={draft.mcpo.runnerCommand}
                  placeholder="uvx"
                /></label
              >
            </div>
            {#if draft.id}<label
                >{l('Adapter-Schlüssel', 'Adapter key')}<input
                  type="password"
                  autocomplete="off"
                  bind:value={draft.apiKey}
                /><small
                  >{l(
                    'Nur ändern, wenn du den vorhandenen Schlüssel austauschen möchtest.',
                    'Only change this to replace the existing key.'
                  )}</small
                ></label
              >{/if}{/if}
          {#if draft.type !== 'remote'}<label
              >{l('Arbeitsverzeichnis (optional)', 'Working directory (optional)')}<input
                bind:value={draft.cwd}
              /></label
            ><label
              >{l('Status-URL (optional)', 'Health check URL (optional)')}<input
                type="url"
                bind:value={draft.healthCheckUrl}
                placeholder="http://127.0.0.1:8000/health"
              /></label
            >{/if}
          <fieldset>
            <legend>{l('Umgebungsvariablen', 'Environment variables')}</legend>
            <p class="muted">
              {l('Werte werden verschlüsselt gespeichert.', 'Values are stored encrypted.')}
            </p>
            {#each envEntries as entry, index (index)}<div class="env-row">
                <label
                  ><span class="sr-only">{l('Name der Variable', 'Variable name')} {index + 1}</span
                  ><input bind:value={entry.key} placeholder="KEY" /></label
                ><label
                  ><span class="sr-only"
                    >{l('Wert der Variable', 'Variable value')} {index + 1}</span
                  ><input
                    type="password"
                    autocomplete="off"
                    bind:value={entry.value}
                    placeholder={l('Wert', 'Value')}
                  /></label
                ><button
                  type="button"
                  class="text-button danger"
                  aria-label={l(`Variable ${index + 1} entfernen`, `Remove variable ${index + 1}`)}
                  onclick={() => (envEntries = envEntries.filter((_, i) => i !== index))}>×</button
                >
              </div>{/each}<button
              type="button"
              class="secondary"
              onclick={() => (envEntries = [...envEntries, { key: '', value: '' }])}
              >{l('Variable hinzufügen', 'Add variable')}</button
            >
          </fieldset>
          <div class="form-columns">
            <label
              >{l('Max. Neustarts', 'Restart limit')}<input
                type="number"
                min="0"
                max="20"
                bind:value={draft.restartLimit}
              /></label
            ><label
              >{l('Startzeitlimit (Millisekunden)', 'Startup timeout (milliseconds)')}<input
                type="number"
                min="1000"
                max="600000"
                step="1000"
                bind:value={draft.startupTimeoutMs}
              /></label
            >
          </div>
          <label class="check-row"
            ><input type="checkbox" bind:checked={draft.autoRestart} /><span
              >{l(
                'Bei Fehler automatisch neu starten',
                'Restart automatically after failure'
              )}</span
            ></label
          >
        </div>
      </details>
      <footer class="dialog-actions">
        <button type="button" class="secondary" disabled={saving} onclick={() => (draft = null)}
          >{l('Abbrechen', 'Cancel')}</button
        ><button class="primary" disabled={saving} type="submit"
          >{saving
            ? l('Wird gespeichert …', 'Saving…')
            : draft.id
              ? l('Änderungen speichern', 'Save changes')
              : draft.enabled
                ? l('Speichern und starten', 'Save and start')
                : l('Speichern', 'Save')}</button
        >
      </footer>
    </form>
  </ConnectorDialog>
{/if}

{#if guide}
  <ConnectorDialog
    title={`${guide.name} ${l('einrichten', 'setup')}`}
    closeLabel={l('Schließen', 'Close')}
    onClose={() => (guide = null)}
  >
    <div class="connector-guide">
      {#if notice}<p class="feedback" role="status">{notice}</p>{/if}{#if error}<p
          class="feedback error"
          role="alert"
        >
          {error}
        </p>{/if}<span class="badge">Google Developer Preview</span>
      <p class="intro">
        {l(
          'Möglich, aber noch kein Ein-Klick-Login: Google benötigt eine Preview-Freischaltung und eine eigene OAuth-Konfiguration. Es wird noch kein Konto verbunden.',
          'Available, but not a one-click login yet: Google requires preview access and your own OAuth configuration. No account is connected by opening this guide.'
        )}
      </p>
      <ol>
        <li>
          <strong>{l('Zugang bei Google vorbereiten', 'Prepare Google access')}</strong>
          <p>
            {l(
              'Developer Preview freischalten, ein Google-Cloud-Projekt einrichten und die passenden Workspace- und MCP-APIs aktivieren.',
              'Join the developer preview, set up a Google Cloud project, and enable the appropriate Workspace and MCP APIs.'
            )}
          </p>
        </li>
        <li>
          <strong>{l('OAuth-Zugang anlegen', 'Create OAuth credentials')}</strong>
          <p>
            {l(
              'Consent Screen sowie eigene Client-ID und Client-Secret anlegen. Nutze zunächst nur lesenden Zugriff; Zugangsdaten anderer Apps lassen sich nicht übernehmen.',
              'Set up the consent screen and your own client ID and client secret. Start with read-only access; credentials from other apps cannot be reused.'
            )}
          </p>
        </li>
        <li>
          <strong>{l('In Open WebUI verbinden', 'Connect in Open WebUI')}</strong>
          <p>
            {l(
              'Admin-Einstellungen → Integrationen → Externe Werkzeugserver → Hinzufügen. Typ „MCP (Streamable HTTP)“, Authentifizierung „OAuth 2.1 (Static)“ wählen. Registriere deinen Client, speichere und autorisiere anschließend dein Konto im Verbindungseintrag.',
              'Admin Settings → Integrations → External Tool Servers → Add. Select MCP (Streamable HTTP) and OAuth 2.1 (Static). Register your client, save, then authorize your account in the connection entry.'
            )}
          </p>
        </li>
      </ol>
      <button class="text-button inline-link" onclick={() => external(guide!.documentation!)}
        >{l('Offizielle Google-Anleitung ↗', 'Official Google setup guide ↗')}</button
      >
      <div class="copy-field">
        <span>{l('Serveradresse', 'Server address')}</span><code>{guide.endpoint}</code><button
          class="secondary"
          onclick={() => copy(guide!.endpoint!)}>{l('Adresse kopieren', 'Copy address')}</button
        >
      </div>
      <div class="copy-field">
        <span>{l('Berechtigungen: nur lesen', 'Permissions: read only')}</span><code
          >{googleScopes[guide.id]}</code
        ><button class="secondary" onclick={() => copy(googleScopes[guide!.id])}
          >{l('Berechtigungen kopieren', 'Copy scopes')}</button
        >
      </div>
      <p class="footnote">
        {l(
          'OAuth-Verbindungen werden in Open WebUI verwaltet. Ihr Kontostatus erscheint nicht in der Desktop-Diensteliste. Prüfe nach dem Verbinden die angebotenen Werkzeuge und Berechtigungen.',
          'OAuth connections are managed in Open WebUI. Their account status is not shown in the Desktop service list. Review the offered tools and permissions after connecting.'
        )}
      </p>
      <footer class="dialog-actions">
        <button class="secondary" onclick={() => (guide = null)}>{l('Später', 'Later')}</button
        ><button class="primary" onclick={openWebUIIntegrations}
          >{l('In Open WebUI einrichten', 'Set up in Open WebUI')}</button
        >
      </footer>
    </div>
  </ConnectorDialog>
{/if}
{#if logService}<ManagedServiceLogs
    id={logService.id}
    name={logService.name}
    onClose={() => (logService = null)}
  />{/if}
{#if integration}
  <ConnectorDialog
    title={`${integrationName} · ${l('Verbindungsdetails', 'Connection details')}`}
    closeLabel={l('Schließen', 'Close')}
    onClose={() => (integration = null)}
  >
    <div class="connector-guide">
      {#if notice}<p class="feedback" role="status">{notice}</p>{/if}{#if error}<p
          class="feedback error"
          role="alert"
        >
          {error}
        </p>{/if}
      <p class="intro">
        {l(
          'Desktop stellt aktivierte Konnektoren automatisch bereit. Diese Werte brauchst du nur zur Fehlersuche oder für eine zusätzliche manuelle Verbindung.',
          'Desktop makes enabled connectors available automatically. These values are only needed for troubleshooting or an additional manual connection.'
        )}
      </p>
      <div class="copy-field">
        <span>URL</span><code>{integration.url}</code><button
          class="secondary"
          onclick={() => copy(integration!.url)}>{l('Kopieren', 'Copy')}</button
        >
      </div>
      <div class="copy-field">
        <span>{l('Zugriffsschlüssel', 'Access key')}</span><code
          >{revealKey ? integration.bearerKey : '••••••••••••'}</code
        >
        <div class="inline-actions">
          <button class="secondary" onclick={() => (revealKey = !revealKey)}
            >{revealKey ? l('Verbergen', 'Hide') : l('Anzeigen', 'Reveal')}</button
          ><button class="secondary" onclick={() => copy(integration!.bearerKey)}
            >{l('Kopieren', 'Copy')}</button
          >
        </div>
      </div>
      <details>
        <summary>{l('Technisches Kommando', 'Technical command')}</summary><code
          class="technical-command">{integration.commandPreview}</code
        >
      </details>
      <footer class="dialog-actions">
        <button class="primary" onclick={() => (integration = null)}>{l('Fertig', 'Done')}</button>
      </footer>
    </div>
  </ConnectorDialog>
{/if}
{#if importPreview}
  <ConnectorDialog
    title={l('Import prüfen', 'Review import')}
    closeLabel={l('Schließen', 'Close')}
    busy={importBusy}
    onClose={cancelImport}
  >
    <div class="connector-guide">
      {#if error}<p class="feedback error" role="alert">{error}</p>{/if}
      <div class="feedback error">
        {l(
          'Dieser Import ersetzt die aktuelle Verbindungsliste. Prüfe die Programme und exportiere bei Bedarf zuerst deine vorhandene Konfiguration.',
          'This import replaces your current connection list. Review the programs and export your existing configuration first if needed.'
        )}
      </div>
      {#each importPreview.services as service (service.id)}<div class="copy-field">
          <strong>{service.name} · {service.type}</strong><code>{service.commandPreview}</code>
        </div>{/each}{#each importPreview.warnings as warning (warning)}<p class="feedback error">
          {warning}
        </p>{/each}
      <footer class="dialog-actions">
        <button class="secondary" disabled={importBusy} onclick={cancelImport}
          >{l('Abbrechen', 'Cancel')}</button
        ><button class="primary" disabled={importBusy} onclick={confirmImport}
          >{importBusy
            ? l('Importiert …', 'Importing…')
            : l('Prüfung bestätigen und ersetzen', 'Confirm review and replace')}</button
        >
      </footer>
    </div>
  </ConnectorDialog>
{/if}

<style>
  .connectors {
    --connector-border: rgb(0 0 0 / 0.12);
    --connector-surface: rgb(0 0 0 / 0.025);
    --connector-muted: #606064;
    --connector-field: rgb(0 0 0 / 0.045);
    --connector-text: #1d1d1f;
    padding: 4px 0 16px;
    container-type: inline-size;
  }
  :global(.dark) .connectors {
    --connector-border: rgb(255 255 255 / 0.14);
    --connector-surface: rgb(255 255 255 / 0.028);
    --connector-muted: #aaaab0;
    --connector-field: rgb(255 255 255 / 0.06);
    --connector-text: #ececec;
  }
  .page-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
  }
  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.025em;
  }
  .page-heading p,
  .provider-copy p {
    margin: 6px 0 0;
    color: var(--connector-muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .connectors :is(button, input, select, summary):focus-visible {
    outline: 2px solid #3b82f6;
    outline-offset: 3px;
  }
  :is(.connectors, .connector-form, .connector-guide) :is(button, input, select, textarea) {
    font: inherit;
  }
  :is(.connectors, .connector-form, .connector-guide) button {
    transition:
      background-color 150ms,
      opacity 150ms;
  }
  :is(.connectors, .connector-form, .connector-guide) button:disabled {
    opacity: 0.45;
    cursor: wait;
  }
  .primary,
  .secondary,
  .text-button {
    min-height: 40px;
    border-radius: 9px;
    padding: 8px 13px;
    font-size: 12px !important;
    font-weight: 500;
  }
  .primary {
    flex-shrink: 0;
    color: #fff;
    background: #242426;
  }
  :global(.dark) .primary {
    color: #171717;
    background: #ececec;
  }
  .primary:hover {
    opacity: 0.85;
  }
  .secondary {
    border: 1px solid rgb(127 127 127 / 0.25);
    background: transparent;
  }
  .secondary:hover,
  .text-button:hover {
    background: rgb(127 127 127 / 0.1);
  }
  .text-button {
    color: inherit;
    font-weight: 400;
  }
  .tabs {
    display: flex;
    gap: 8px;
    padding-bottom: 16px;
    margin-bottom: 18px;
    border-bottom: 1px solid var(--connector-border);
  }
  .tabs button {
    min-height: 40px;
    padding: 8px 14px;
    border-radius: 9px;
    color: var(--connector-muted);
    font-size: 13px;
  }
  .tabs button.active {
    color: var(--connector-text);
    background: var(--connector-field);
    font-weight: 600;
  }
  .count {
    margin-left: 6px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .search-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 22px;
  }
  .search {
    display: flex;
    align-items: center;
    flex: 1 1 200px;
    gap: 9px;
    border: 1px solid var(--connector-border);
    border-radius: 11px;
    padding-left: 13px;
    color: var(--connector-muted);
  }
  .search input {
    width: 100%;
    min-width: 0;
    padding: 13px 10px 13px 0;
    background: transparent;
    border: 0;
    color: var(--connector-text);
    font-size: 13px;
  }
  .filter select {
    height: 46px;
    max-width: 100%;
    padding: 0 10px;
    border-radius: 11px;
    border: 1px solid var(--connector-border);
    background: var(--connector-surface);
  }
  .section-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    gap: 8px;
  }
  h3 {
    font-size: 13px;
    font-weight: 600;
    margin: 0;
  }
  .provider-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .provider-card {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    border: 1px solid var(--connector-border);
    border-radius: 14px;
    padding: 17px;
    background: var(--connector-surface);
  }
  .provider-icon {
    display: grid;
    place-items: center;
    flex: 0 0 42px;
    width: 42px;
    height: 42px;
    border-radius: 11px;
    border: 1px solid var(--connector-border);
    color: var(--connector-text);
    background: var(--connector-field);
  }
  .provider-copy {
    min-width: 0;
  }
  h4 {
    margin: 1px 0 0;
    font-size: 14px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .provider-copy p {
    font-size: 12px;
  }
  .card-action {
    grid-column: 2;
    justify-self: start;
  }
  .badge {
    display: inline-block;
    font-size: 10px;
    padding: 3px 7px;
    margin-top: 9px;
    border-radius: 5px;
    background: rgb(127 127 127 / 0.12);
    color: inherit;
  }
  .service-list {
    display: grid;
    gap: 12px;
  }
  .service-card {
    padding: 16px 17px 10px;
    border: 1px solid var(--connector-border);
    border-radius: 14px;
    background: var(--connector-surface);
  }
  .service-main {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .service-main .provider-copy {
    flex: 1;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--connector-muted);
    white-space: nowrap;
  }
  .status span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #909095;
  }
  .status[data-status='running'] span {
    background: #10b981;
  }
  .status[data-status='starting'] span {
    background: #d97706;
  }
  .status[data-status='failed'] span {
    background: #ef4444;
  }
  .service-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 13px 0 0 54px;
  }
  .service-more {
    margin-left: auto;
  }
  .service-more summary {
    min-height: 40px;
    padding: 10px;
    font-size: 12px;
    cursor: pointer;
  }
  .details-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .service-error {
    margin: 12px 0 0;
    font-size: 12px;
    overflow-wrap: anywhere;
    color: #b91c1c;
  }
  :global(.dark) .service-error {
    color: #fca5a5;
  }
  .footnote {
    color: var(--connector-muted, #68686d);
    font-size: 12px;
    line-height: 1.6;
    margin: 18px 0 0;
  }
  :global(.dark) .connector-guide .footnote {
    color: #aaaab0;
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: 12px;
    text-align: center;
    padding: 36px 20px;
    border: 1px dashed var(--connector-border);
    border-radius: 14px;
    color: var(--connector-muted);
  }
  .empty p {
    max-width: 360px;
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
  }
  .empty h3 {
    font-size: 15px;
    color: var(--connector-text);
  }
  .advanced-tools {
    margin-top: 26px;
    border-top: 1px solid var(--connector-border);
    padding-top: 10px;
  }
  .advanced-tools summary {
    padding: 12px 0;
    font-size: 12px;
    color: var(--connector-muted);
    cursor: pointer;
  }
  .advanced-tools p {
    margin: 2px 0 12px;
    font-size: 12px;
    color: var(--connector-muted);
  }
  .inline-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .feedback {
    padding: 12px;
    border-radius: 10px;
    margin-bottom: 14px;
    background: rgb(127 127 127 / 0.08);
    font-size: 12px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .feedback.error {
    background: rgb(220 38 38 / 0.08);
    color: #b91c1c;
  }
  :global(.dark) .feedback.error {
    color: #fca5a5;
  }
  .feedback button {
    padding: 6px 10px;
    text-decoration: underline;
  }
  .danger {
    color: #b91c1c;
  }
  :global(.dark) .danger {
    color: #fca5a5;
  }
  .connector-form,
  .connector-guide {
    font-size: 13px;
  }
  .connector-form > label,
  .advanced-fields > label {
    display: grid;
    gap: 7px;
    margin-bottom: 17px;
  }
  .intro {
    margin: 0 0 20px;
    font-size: 13px;
    line-height: 1.65;
    color: #606064;
  }
  :global(.dark) .intro,
  :global(.dark) .muted {
    color: #aaaab0;
  }
  .connector-form :is(input:not([type='checkbox']), textarea, select) {
    width: 100%;
    min-width: 0;
    border: 1px solid rgb(127 127 127 / 0.28);
    background: rgb(127 127 127 / 0.06);
    border-radius: 9px;
    padding: 11px 12px;
    color: inherit;
    box-sizing: border-box;
  }
  .connector-form textarea {
    resize: vertical;
    font-family: ui-monospace, monospace;
  }
  .connector-form small {
    display: block;
    font-size: 11px;
    line-height: 1.6;
    color: #646468;
  }
  :global(.dark) .connector-form small {
    color: #aaaab0;
  }
  .check-row {
    display: flex !important;
    align-items: flex-start;
    gap: 10px !important;
    margin: 22px 0 !important;
  }
  .check-row input {
    width: 17px;
    height: 17px;
    margin-top: 2px;
    accent-color: #4b5563;
  }
  .check-row span small {
    margin-top: 4px;
  }
  .editor-advanced {
    border-top: 1px solid rgb(127 127 127 / 0.2);
    border-bottom: 1px solid rgb(127 127 127 / 0.2);
  }
  .editor-advanced summary,
  .connector-guide summary {
    padding: 15px 0;
    cursor: pointer;
    font-size: 12px;
  }
  .advanced-fields {
    padding-top: 8px;
  }
  .form-columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .form-columns label {
    display: grid;
    gap: 7px;
  }
  .connector-form fieldset {
    border: 0;
    padding: 0;
    margin: 8px 0 20px;
  }
  .muted {
    font-size: 12px;
    color: #606064;
    line-height: 1.6;
  }
  .env-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) 38px;
    gap: 7px;
    margin-bottom: 8px;
  }
  .env-row button {
    padding: 0;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 24px;
  }
  .inline-link {
    margin: -8px 0 8px -12px;
    text-decoration: underline;
  }
  .connector-guide ol {
    list-style: decimal;
    padding-left: 22px;
    margin: 22px 0;
  }
  .connector-guide li {
    padding: 0 0 14px 4px;
  }
  .connector-guide li p {
    line-height: 1.65;
    margin: 6px 0 0;
    color: #606064;
  }
  :global(.dark) .connector-guide li p {
    color: #aaaab0;
  }
  .copy-field {
    padding: 14px;
    border: 1px solid rgb(127 127 127 / 0.25);
    border-radius: 11px;
    margin-top: 12px;
  }
  .copy-field span {
    display: block;
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: 500;
  }
  .copy-field code,
  .technical-command {
    display: block;
    font-size: 11px;
    line-height: 1.7;
    overflow-wrap: anywhere;
    user-select: text;
    white-space: pre-wrap;
  }
  .copy-field button,
  .copy-field .inline-actions {
    margin-top: 10px;
  }
  .copy-field .inline-actions button {
    margin-top: 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @container (max-width: 570px) {
    .provider-grid {
      grid-template-columns: 1fr;
    }
    .provider-card {
      grid-template-columns: 42px minmax(0, 1fr) auto;
      align-items: center;
    }
    .card-action {
      grid-column: 3;
    }
  }
  @container (max-width: 420px) {
    .page-heading {
      flex-direction: column;
    }
    .service-main {
      flex-wrap: wrap;
    }
    .service-main .status {
      margin-left: 54px;
    }
    .service-actions {
      margin-left: 0;
    }
    .provider-card {
      grid-template-columns: 42px minmax(0, 1fr);
    }
    .card-action {
      grid-column: 2;
    }
  }
  @media (max-width: 480px) {
    .form-columns {
      grid-template-columns: 1fr;
    }
    .primary,
    .secondary,
    .text-button {
      min-height: 44px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :is(.connectors, .connector-form, .connector-guide) button {
      transition: none;
    }
  }
</style>
