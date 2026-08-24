<script lang="ts">
  import { onMount } from 'svelte'

  interface WorkspaceEntry {
    path: string
    name: string
    repoFullName?: string
    lastUsedAt: number
  }

  interface GithubRepoEntry {
    fullName: string
    name: string
    owner: string
    isPrivate: boolean
    defaultBranch: string
    updatedAt: string
    localPath: string | null
  }

  interface Props {
    activePath: string
    busy: boolean
    statusText: string
    onClose: () => void
    onActivate: (workspacePath: string, repoFullName?: string) => Promise<void> | void
  }

  let { activePath, busy, statusText, onClose, onActivate }: Props = $props()

  const isGerman =
    typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('de')
  const l = (german: string, english: string): string => (isGerman ? german : english)

  let tab = $state<'local' | 'github'>('local')
  let workspaces = $state<WorkspaceEntry[]>([])
  let repositories = $state<GithubRepoEntry[]>([])
  let githubConnected = $state(false)
  let loadingRepos = $state(false)
  let filter = $state('')
  let pickerError = $state('')
  let workspacesRoot = $state('')

  const comparable = (value: string): string => {
    const normalized = value.trim().replace(/[\\/]+$/, '')
    return /^[a-z]:[\\/]/i.test(normalized) ? normalized.toLowerCase() : normalized
  }

  const isActive = (workspacePath: string): boolean =>
    !!activePath && comparable(activePath) === comparable(workspacePath)

  const visibleWorkspaces = $derived(
    filter.trim()
      ? workspaces.filter((entry) =>
          `${entry.name} ${entry.path}`.toLowerCase().includes(filter.trim().toLowerCase())
        )
      : workspaces
  )

  const visibleRepositories = $derived(
    filter.trim()
      ? repositories.filter((repo) =>
          repo.fullName.toLowerCase().includes(filter.trim().toLowerCase())
        )
      : repositories
  )

  const refreshWorkspaces = async (): Promise<void> => {
    workspaces = await window.electronAPI.listWorkspaces()
  }

  const loadRepositories = async (): Promise<void> => {
    if (loadingRepos) return
    loadingRepos = true
    pickerError = ''
    try {
      repositories = await window.electronAPI.listGithubRepositories()
    } catch (cause) {
      pickerError = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loadingRepos = false
    }
  }

  const openGithubTab = async (): Promise<void> => {
    tab = 'github'
    filter = ''
    if (githubConnected && repositories.length === 0) await loadRepositories()
  }

  const browseFolder = async (): Promise<void> => {
    const folder = await window.electronAPI.selectFolder()
    if (!folder) return
    await onActivate(folder)
  }

  const useRepository = async (repo: GithubRepoEntry): Promise<void> => {
    pickerError = ''
    try {
      const prepared = await window.electronAPI.prepareGithubWorkspace(repo.fullName)
      await onActivate(prepared.path, repo.fullName)
    } catch (cause) {
      pickerError = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const forget = async (entry: WorkspaceEntry, event: MouseEvent): Promise<void> => {
    event.stopPropagation()
    workspaces = await window.electronAPI.forgetWorkspace(entry.path)
  }

  onMount(async () => {
    workspacesRoot = await window.electronAPI.getWorkspacesRoot()
    await refreshWorkspaces()
    const status = await window.electronAPI.getGithubWorkspaceStatus()
    githubConnected = !!status?.connected
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm"
  onclick={onClose}
>
  <section
    class="flex max-h-[80vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-2xl border border-black/10 bg-[#f5f5f7] shadow-2xl dark:border-white/10 dark:bg-[#171717]"
    role="dialog"
    aria-modal="true"
    onclick={(event) => event.stopPropagation()}
  >
    <div class="flex items-center justify-between px-5 pt-5 pb-3">
      <h3 class="m-0 text-[14px] font-medium">
        {l('Arbeitsbereich wählen', 'Choose workspace')}
      </h3>
      <button
        class="rounded-lg px-2 py-1 text-[11px] opacity-45 hover:bg-black/5 dark:hover:bg-white/10"
        onclick={onClose}>{l('Schließen', 'Close')}</button
      >
    </div>

    <div class="flex items-center gap-1.5 px-5">
      <button
        class="rounded-lg px-2.5 py-1 text-[11px] transition-colors {tab === 'local'
          ? 'bg-black/[0.08] dark:bg-white/[0.12]'
          : 'opacity-50 hover:bg-black/5 dark:hover:bg-white/10'}"
        onclick={() => {
          tab = 'local'
          filter = ''
        }}>{l('Lokal', 'Local')}</button
      >
      <button
        class="rounded-lg px-2.5 py-1 text-[11px] transition-colors {tab === 'github'
          ? 'bg-black/[0.08] dark:bg-white/[0.12]'
          : 'opacity-50 hover:bg-black/5 dark:hover:bg-white/10'}"
        onclick={openGithubTab}>GitHub</button
      >
      <input
        class="ml-auto w-[220px] rounded-lg border-none bg-black/5 px-3 py-1.5 text-[11px] outline-none dark:bg-white/10"
        placeholder={l('Durchsuchen …', 'Search …')}
        bind:value={filter}
      />
    </div>

    {#if pickerError}
      <div
        class="mx-5 mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-300"
        role="alert"
      >
        {pickerError}
      </div>
    {/if}

    {#if busy && statusText}
      <div
        class="mx-5 mt-3 rounded-lg bg-black/[0.06] px-3 py-2 text-[11px] opacity-70 dark:bg-white/[0.08]"
        role="status"
      >
        {statusText}
      </div>
    {/if}

    <div class="min-h-[220px] flex-1 overflow-auto px-5 py-3">
      {#if tab === 'local'}
        <button
          class="mb-2 w-full rounded-xl border border-dashed border-black/15 px-3 py-2.5 text-left text-[11px] opacity-70 transition-colors hover:bg-black/[0.04] disabled:opacity-30 dark:border-white/15 dark:hover:bg-white/[0.06]"
          disabled={busy}
          onclick={browseFolder}
        >
          {l('Ordner auswählen …', 'Browse for a folder …')}
        </button>

        {#if visibleWorkspaces.length === 0}
          <p class="px-1 py-6 text-center text-[11px] opacity-40">
            {l(
              'Noch keine Arbeitsbereiche. Wähle einen Ordner oder klone ein GitHub-Repository.',
              'No workspaces yet. Pick a folder or clone a GitHub repository.'
            )}
          </p>
        {:else}
          {#each visibleWorkspaces as entry (entry.path)}
            <div
              class="mb-1.5 flex items-center gap-2 rounded-xl pr-2 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06] {isActive(
                entry.path
              )
                ? 'bg-black/[0.06] dark:bg-white/[0.08]'
                : ''}"
            >
              <button
                class="flex min-w-0 flex-1 items-center gap-2 rounded-xl border-none bg-transparent px-3 py-2.5 text-left disabled:opacity-40"
                disabled={busy}
                onclick={() => onActivate(entry.path, entry.repoFullName)}
              >
                <span
                  class="size-1.5 shrink-0 rounded-full {isActive(entry.path)
                    ? 'bg-emerald-400'
                    : 'bg-black/15 dark:bg-white/20'}"
                ></span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12px]">{entry.name}</span>
                  <span class="block truncate font-mono text-[10px] opacity-45">{entry.path}</span>
                </span>
                {#if entry.repoFullName}
                  <span class="shrink-0 text-[9px] uppercase tracking-wide opacity-35">GitHub</span>
                {/if}
              </button>
              <button
                class="shrink-0 rounded-lg border-none bg-transparent px-1.5 py-0.5 text-[11px] text-red-500 opacity-40 hover:bg-red-500/10 hover:opacity-90"
                aria-label={l('Aus Liste entfernen', 'Remove from list')}
                onclick={(event) => forget(entry, event)}>×</button
              >
            </div>
          {/each}
        {/if}
      {:else if !githubConnected}
        <p class="px-1 py-6 text-center text-[11px] leading-5 opacity-50">
          {l(
            'Kein GitHub-Konnektor verbunden. Füge ihn unter Einstellungen → Dienste & Konnektoren als „GitHub MCP“ hinzu; sein Token wird auch zum Klonen verwendet.',
            'No GitHub connector is connected. Add it under Settings → Services & Connectors as “GitHub MCP”; its token is reused for cloning.'
          )}
        </p>
      {:else if loadingRepos}
        <p class="px-1 py-6 text-center text-[11px] opacity-40">
          {l('Repositories werden geladen …', 'Loading repositories …')}
        </p>
      {:else if visibleRepositories.length === 0}
        <p class="px-1 py-6 text-center text-[11px] opacity-40">
          {l('Keine Repositories gefunden.', 'No repositories found.')}
        </p>
      {:else}
        {#each visibleRepositories as repo (repo.fullName)}
          <button
            class="mb-1.5 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.06] {repo.localPath &&
            isActive(repo.localPath)
              ? 'bg-black/[0.06] dark:bg-white/[0.08]'
              : ''}"
            disabled={busy}
            onclick={() => useRepository(repo)}
          >
            <span
              class="size-1.5 shrink-0 rounded-full {repo.localPath
                ? 'bg-emerald-400'
                : 'bg-black/15 dark:bg-white/20'}"
            ></span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12px]">{repo.fullName}</span>
              <span class="block truncate text-[10px] opacity-45">
                {repo.localPath
                  ? l('Geklont — wird aktualisiert', 'Cloned — will be updated')
                  : l('Wird nach Auswahl geklont', 'Cloned on selection')}
              </span>
            </span>
            {#if repo.isPrivate}
              <span class="shrink-0 text-[9px] uppercase tracking-wide opacity-35">
                {l('privat', 'private')}
              </span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>

    <div
      class="border-t border-black/[0.06] px-5 py-2.5 text-[10px] leading-4 opacity-40 dark:border-white/[0.06]"
    >
      {l('Klon-Ordner', 'Clone folder')}: <span class="font-mono">{workspacesRoot}</span> ·
      {l(
        'Der ausgewählte Ordner wird zum Arbeitsverzeichnis von Open Terminal.',
        'The selected folder becomes the Open Terminal working directory.'
      )}
    </div>
  </section>
</div>
