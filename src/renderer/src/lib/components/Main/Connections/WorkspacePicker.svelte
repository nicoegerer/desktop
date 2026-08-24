<script lang="ts">
  import { onMount } from 'svelte'
  import type { CloudWorkspace } from '../../../../../../shared/services/tool-servers'

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

  interface OpenTerminalEntry {
    cwd: string
    status: string | null
  }

  interface Props {
    terminals: OpenTerminalEntry[]
    cloudWorkspace: CloudWorkspace | null
    busy: boolean
    statusText: string
    onClose: () => void
    onOpen: (workspacePath: string, repoFullName?: string) => Promise<void> | void
    onCloseWorkspace: (workspacePath: string) => Promise<void> | void
    onSelectCloud: (workspace: CloudWorkspace | null) => Promise<void> | void
    onConnectGithub: () => void
  }

  let {
    terminals,
    cloudWorkspace,
    busy,
    statusText,
    onClose,
    onOpen,
    onCloseWorkspace,
    onSelectCloud,
    onConnectGithub
  }: Props = $props()

  const isGerman =
    typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('de')
  const l = (german: string, english: string): string => (isGerman ? german : english)

  // Local and cloud are two ways of working, not two lists of the same thing:
  // a local workspace gets a terminal, a cloud workspace is edited through the
  // GitHub connector without ever being checked out.
  let mode = $state<'local' | 'cloud'>(cloudWorkspace ? 'cloud' : 'local')
  let workspaces = $state<WorkspaceEntry[]>([])
  let repositories = $state<GithubRepoEntry[]>([])
  let githubConnected = $state(false)
  let loadingRepos = $state(false)
  let filter = $state('')
  let pickerError = $state('')
  let workspacesRoot = $state('')

  // Cloud selection in progress: repository first, then its branch.
  let pendingRepo = $state<GithubRepoEntry | null>(null)
  let branches = $state<string[]>([])
  let loadingBranches = $state(false)

  const comparable = (value: string): string => {
    const normalized = value.trim().replace(/[\\/]+$/, '')
    return /^[a-z]:[\\/]/i.test(normalized) ? normalized.toLowerCase() : normalized
  }

  /** A local workspace is "open" when its own Open Terminal is running. */
  const isOpen = (workspacePath: string): boolean =>
    terminals.some(
      (terminal) =>
        terminal.status === 'started' && comparable(terminal.cwd) === comparable(workspacePath)
    )

  const matches = (haystack: string): boolean =>
    !filter.trim() || haystack.toLowerCase().includes(filter.trim().toLowerCase())

  const visibleWorkspaces = $derived(
    workspaces.filter((entry) => matches(`${entry.name} ${entry.path}`))
  )
  const visibleRepositories = $derived(
    repositories.filter((repo) => matches(repo.fullName))
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

  const switchMode = async (next: 'local' | 'cloud'): Promise<void> => {
    mode = next
    filter = ''
    pendingRepo = null
    if (next === 'cloud' && githubConnected && repositories.length === 0) {
      await loadRepositories()
    }
  }

  // ── Local ────────────────────────────────────────────

  const browseFolder = async (): Promise<void> => {
    const folder = await window.electronAPI.selectFolder()
    if (!folder) return
    await onOpen(folder)
    await refreshWorkspaces()
  }

  const toggleWorkspace = async (workspacePath: string, repoFullName?: string): Promise<void> => {
    if (isOpen(workspacePath)) {
      await onCloseWorkspace(workspacePath)
      return
    }
    await onOpen(workspacePath, repoFullName)
    await refreshWorkspaces()
  }

  const forget = async (entry: WorkspaceEntry, event: MouseEvent): Promise<void> => {
    event.stopPropagation()
    workspaces = await window.electronAPI.forgetWorkspace(entry.path)
  }

  // ── Cloud ────────────────────────────────────────────

  const chooseRepository = async (repo: GithubRepoEntry): Promise<void> => {
    pendingRepo = repo
    branches = []
    loadingBranches = true
    pickerError = ''
    try {
      branches = await window.electronAPI.listGithubBranches(repo.fullName)
      if (branches.length === 0) branches = [repo.defaultBranch]
    } catch (cause) {
      // A token without branch access can still work on the default branch.
      pickerError = cause instanceof Error ? cause.message : String(cause)
      branches = [repo.defaultBranch]
    } finally {
      loadingBranches = false
    }
  }

  const chooseBranch = async (branch: string): Promise<void> => {
    if (!pendingRepo) return
    await onSelectCloud({ repoFullName: pendingRepo.fullName, branch })
    pendingRepo = null
  }

  const clearCloud = async (): Promise<void> => {
    await onSelectCloud(null)
    pendingRepo = null
  }

  onMount(async () => {
    workspacesRoot = await window.electronAPI.getWorkspacesRoot()
    await refreshWorkspaces()
    const status = await window.electronAPI.getGithubWorkspaceStatus()
    githubConnected = !!status?.connected
    if (mode === 'cloud' && githubConnected) await loadRepositories()
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
      <h3 class="m-0 text-[14px] font-medium">{l('Arbeitsbereich', 'Workspace')}</h3>
      <button
        class="rounded-lg px-2 py-1 text-[11px] opacity-45 hover:bg-black/5 dark:hover:bg-white/10"
        onclick={onClose}>{l('Schließen', 'Close')}</button
      >
    </div>

    <div class="flex items-center gap-1.5 px-5">
      <div class="flex rounded-lg bg-black/[0.06] p-0.5 dark:bg-white/[0.08]">
        <button
          class="rounded-md px-2.5 py-1 text-[11px] transition-colors {mode === 'local'
            ? 'bg-white shadow-sm dark:bg-white/[0.14]'
            : 'opacity-55 hover:opacity-85'}"
          onclick={() => switchMode('local')}>{l('Lokal', 'Local')}</button
        >
        <button
          class="rounded-md px-2.5 py-1 text-[11px] transition-colors {mode === 'cloud'
            ? 'bg-white shadow-sm dark:bg-white/[0.14]'
            : 'opacity-55 hover:opacity-85'}"
          onclick={() => switchMode('cloud')}>{l('Cloud', 'Cloud')}</button
        >
      </div>
      <input
        class="ml-auto w-[220px] rounded-lg border-none bg-black/5 px-3 py-1.5 text-[11px] outline-none dark:bg-white/10"
        placeholder={mode === 'local'
          ? l('Ordner durchsuchen …', 'Search folders …')
          : l('Repos durchsuchen …', 'Search repos …')}
        bind:value={filter}
      />
    </div>

    <p class="mx-5 mt-3 text-[10px] leading-4 opacity-45">
      {mode === 'local'
        ? l(
            'Ein lokaler Ordner bekommt ein eigenes Terminal. Im Chat wählst du über das Wolken-Symbol, welcher Chat in welchem Ordner arbeitet.',
            'A local folder gets its own terminal. In a chat, the cloud icon picks which conversation works in which folder.'
          )
        : l(
            'Ein Cloud-Arbeitsbereich wird nicht geklont. Das Modell liest und schreibt direkt im Repository über die GitHub-Verbindung.',
            'A cloud workspace is never cloned. The model reads and writes in the repository directly through the GitHub connection.'
          )}
    </p>

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
      {#if mode === 'local'}
        <button
          class="mb-2 w-full rounded-xl border border-dashed border-black/15 px-3 py-2.5 text-left text-[11px] opacity-70 transition-colors hover:bg-black/[0.04] disabled:opacity-30 dark:border-white/15 dark:hover:bg-white/[0.06]"
          disabled={busy}
          onclick={browseFolder}
        >
          {l('Ordner öffnen …', 'Open a folder …')}
        </button>

        {#if visibleWorkspaces.length === 0}
          <p class="px-1 py-6 text-center text-[11px] opacity-40">
            {l(
              'Noch keine lokalen Arbeitsbereiche. Wähle einen Ordner.',
              'No local workspaces yet. Pick a folder.'
            )}
          </p>
        {:else}
          {#each visibleWorkspaces as entry (entry.path)}
            <div
              class="mb-1.5 flex items-center gap-2 rounded-xl pr-2 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06] {isOpen(
                entry.path
              )
                ? 'bg-black/[0.06] dark:bg-white/[0.08]'
                : ''}"
            >
              <button
                class="flex min-w-0 flex-1 items-center gap-2 rounded-xl border-none bg-transparent px-3 py-2.5 text-left disabled:opacity-40"
                disabled={busy}
                onclick={() => toggleWorkspace(entry.path, entry.repoFullName)}
              >
                <span
                  class="size-1.5 shrink-0 rounded-full {isOpen(entry.path)
                    ? 'bg-emerald-400'
                    : 'bg-black/15 dark:bg-white/20'}"
                ></span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12px]">{entry.name}</span>
                  <span class="block truncate font-mono text-[10px] opacity-45">{entry.path}</span>
                </span>
                <span class="shrink-0 text-[10px] opacity-45">
                  {isOpen(entry.path) ? l('Geöffnet', 'Open') : l('Öffnen', 'Open it')}
                </span>
              </button>
              <button
                class="shrink-0 rounded-lg border-none bg-transparent px-1.5 py-0.5 text-[11px] text-red-500 opacity-40 hover:bg-red-500/10 hover:opacity-90 disabled:opacity-20"
                disabled={busy || isOpen(entry.path)}
                aria-label={l('Aus Liste entfernen', 'Remove from list')}
                onclick={(event) => forget(entry, event)}>×</button
              >
            </div>
          {/each}
        {/if}
      {:else if !githubConnected}
        <div class="flex flex-col items-center gap-3 px-1 py-6">
          <p class="m-0 max-w-[420px] text-center text-[11px] leading-5 opacity-50">
            {l(
              'Noch keine GitHub-Verbindung. Ein Fine-grained Personal Access Token genügt — es deckt Repositories, Issues und Pull Requests im Chat sowie Cloud-Arbeitsbereiche ab.',
              'No GitHub connection yet. One fine-grained Personal Access Token covers repositories, issues, and pull requests in chat as well as cloud workspaces.'
            )}
          </p>
          <button
            class="rounded-lg bg-black/[0.08] px-3 py-1.5 text-[11px] transition-colors hover:bg-black/[0.12] dark:bg-white/[0.12] dark:hover:bg-white/[0.18]"
            onclick={onConnectGithub}
          >
            {l('GitHub verbinden', 'Connect GitHub')}
          </button>
        </div>
      {:else if pendingRepo}
        <div class="mb-2 flex items-center gap-2">
          <button
            class="rounded-lg px-2 py-1 text-[11px] opacity-55 hover:bg-black/5 hover:opacity-90 dark:hover:bg-white/10"
            onclick={() => (pendingRepo = null)}>‹ {l('Zurück', 'Back')}</button
          >
          <span class="truncate text-[12px]">{pendingRepo.fullName}</span>
        </div>
        {#if loadingBranches}
          <p class="px-1 py-6 text-center text-[11px] opacity-40">
            {l('Branches werden geladen …', 'Loading branches …')}
          </p>
        {:else}
          {#each branches as branch (branch)}
            <button
              class="mb-1.5 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.06]"
              disabled={busy}
              onclick={() => chooseBranch(branch)}
            >
              <span class="shrink-0 text-[11px] opacity-40" aria-hidden="true">⑂</span>
              <span class="min-w-0 flex-1 truncate text-[12px]">{branch}</span>
              {#if branch === pendingRepo.defaultBranch}
                <span class="shrink-0 text-[9px] uppercase tracking-wide opacity-35">
                  {l('Standard', 'default')}
                </span>
              {/if}
            </button>
          {/each}
        {/if}
      {:else}
        {#if cloudWorkspace}
          <div
            class="mb-2 flex items-center gap-2 rounded-xl bg-black/[0.06] px-3 py-2.5 dark:bg-white/[0.08]"
          >
            <span class="size-1.5 shrink-0 rounded-full bg-sky-400"></span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12px]">{cloudWorkspace.repoFullName}</span>
              <span class="block truncate text-[10px] opacity-45">
                {l('Branch', 'Branch')}: {cloudWorkspace.branch} · {l(
                  'ohne lokalen Klon',
                  'no local clone'
                )}
              </span>
            </span>
            <button
              class="shrink-0 rounded-lg px-2 py-1 text-[10px] opacity-55 hover:bg-black/10 hover:opacity-90 dark:hover:bg-white/15"
              disabled={busy}
              onclick={clearCloud}>{l('Beenden', 'Leave')}</button
            >
          </div>
        {/if}

        {#if loadingRepos}
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
              class="mb-1.5 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.06] {cloudWorkspace?.repoFullName ===
              repo.fullName
                ? 'bg-black/[0.06] dark:bg-white/[0.08]'
                : ''}"
              disabled={busy}
              onclick={() => chooseRepository(repo)}
            >
              <span class="shrink-0 text-[11px] opacity-40" aria-hidden="true">&lt;/&gt;</span>
              <span class="min-w-0 flex-1 truncate text-[12px]">{repo.fullName}</span>
              {#if repo.isPrivate}
                <span class="shrink-0 text-[9px] uppercase tracking-wide opacity-35">
                  {l('privat', 'private')}
                </span>
              {/if}
              <span class="shrink-0 text-[10px] opacity-35">›</span>
            </button>
          {/each}
        {/if}
      {/if}
    </div>

    <div
      class="border-t border-black/[0.06] px-5 py-2.5 text-[10px] leading-4 opacity-40 dark:border-white/[0.06]"
    >
      {#if mode === 'local'}
        {l('Ordner für geklonte Repos', 'Folder for cloned repos')}:
        <span class="font-mono">{workspacesRoot}</span>
      {:else}
        {l(
          'Änderungen werden direkt in den gewählten Branch committet.',
          'Changes are committed straight to the selected branch.'
        )}
      {/if}
    </div>
  </section>
</div>
