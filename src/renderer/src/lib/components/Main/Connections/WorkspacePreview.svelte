<script lang="ts">
  import { onMount } from 'svelte'
  import type { WorkspacePreviewInfo } from '../../../../../../shared/workspace-preview'
  import { WORKSPACE_PREVIEW_SANDBOX } from '../../../../../../shared/workspace-preview'
  let { terminalId, label, onClose }: { terminalId: string; label: string; onClose: () => void } =
    $props()
  let entry = $state('index.html')
  let preview = $state<WorkspacePreviewInfo | null>(null)
  let busy = $state(false)
  let error = $state('')
  let loaded = $state(false)
  let mobile = $state(false)
  let generation = 0
  let disposed = false
  const closeServer = (value: WorkspacePreviewInfo | null): void => {
    if (value) void window.electronAPI.workspacePreviewClose({ id: value.id })
  }
  async function load(): Promise<void> {
    const current = ++generation
    closeServer(preview)
    preview = null
    busy = true
    loaded = false
    error = ''
    try {
      const result = await window.electronAPI.workspacePreviewOpen({
        terminalId,
        entryPath: entry.trim()
      })
      if (disposed || current !== generation) {
        if (result.ok) closeServer(result.preview)
        return
      }
      if (!result.ok) {
        error =
          result.code === 'ENTRY_NOT_FOUND'
            ? 'Diese HTML-Datei wurde im Arbeitsbereich nicht gefunden. Prüfe den Dateinamen.'
            : result.code === 'UNSUPPORTED_ENTRY'
              ? 'Bitte eine HTML-Datei auswählen. Serverseitige Anwendungen benötigen einen Entwicklungsserver.'
              : 'Vorschau nicht verfügbar. Prüfe den Arbeitsbereich und den relativen HTML-Pfad.'
        return
      }
      const url = new URL(result.preview.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
        closeServer(result.preview)
        throw new Error('Invalid preview origin')
      }
      preview = result.preview
    } catch {
      if (!disposed && current === generation)
        error = 'Vorschau nicht erreichbar. Bitte erneut versuchen.'
    } finally {
      if (!disposed && current === generation) busy = false
    }
  }
  onMount(() => {
    void load()
    return () => {
      disposed = true
      generation++
      closeServer(preview)
    }
  })
</script>

<aside
  aria-label="Website-Vorschau"
  class="preview-panel bg-[#f5f5f7] dark:bg-[#151515] border-l border-black/10 dark:border-white/10"
>
  <header class="flex items-center gap-2 px-4 py-3 border-b border-black/10 dark:border-white/10">
    <div class="min-w-0 flex-1">
      <h2 class="text-[13px] font-medium">Vorschau</h2>
      <p class="text-[12px] opacity-60 truncate" title={label}>{label}</p>
    </div>
    <button
      class="preview-action"
      aria-pressed={mobile}
      onclick={() => (mobile = !mobile)}
      title="Darstellungsbreite wechseln">{mobile ? 'Mobil' : 'Breit'}</button
    >
    <button class="preview-action" disabled={busy} onclick={load} aria-label="Vorschau neu laden"
      >↻</button
    >
    <button class="preview-action" onclick={onClose} aria-label="Vorschau schließen">×</button>
  </header>
  <form
    class="flex items-center gap-2 px-4 py-2 border-b border-black/10 dark:border-white/10"
    onsubmit={(event) => {
      event.preventDefault()
      void load()
    }}
  >
    <label for="preview-entry" class="text-[12px] shrink-0">HTML-Datei</label>
    <input
      id="preview-entry"
      bind:value={entry}
      class="min-w-0 flex-1 rounded-lg bg-black/5 dark:bg-white/5 px-2 py-1.5 text-[12px]"
      placeholder="index.html"
      spellcheck="false"
    />
    <button class="preview-action" disabled={busy || !entry.trim()} type="submit">Öffnen</button>
  </form>
  <div class="relative flex-1 min-h-0 overflow-auto bg-black/5 dark:bg-black/20 p-2">
    {#if error}
      <div role="alert" class="mx-auto max-w-sm p-6 text-[13px] leading-relaxed">
        <p class="font-medium mb-2">Noch keine Vorschau</p>
        <p class="opacity-70">{error}</p>
        <button class="preview-action mt-4" onclick={load}>Erneut versuchen</button>
      </div>
    {:else if preview}
      {#key preview.id}
        <iframe
          title="Website aus dem ausgewählten Arbeitsbereich"
          src={preview.url}
          sandbox={WORKSPACE_PREVIEW_SANDBOX}
          referrerpolicy="same-origin"
          class="block mx-auto h-full border-0 bg-white"
          style:width={mobile ? 'min(375px, 100%)' : '100%'}
          onload={() => (loaded = true)}
        ></iframe>
      {/key}
    {/if}
    {#if busy || (preview && !loaded)}<p
        role="status"
        class="absolute inset-x-0 top-5 mx-auto w-fit rounded-lg bg-white dark:bg-[#252525] px-4 py-2 text-[12px] shadow"
      >
        Vorschau wird geladen …
      </p>{/if}
  </div>
  <p class="px-4 py-2 text-[11px] opacity-60 border-t border-black/10 dark:border-white/10">
    Lokal · HTML, CSS und JavaScript. Externe Verbindungen und Formulare sind gesperrt.
  </p>
</aside>

<style>
  .preview-panel {
    display: flex;
    flex-direction: column;
    flex: 0 0 min(48%, 780px);
    min-width: 320px;
    min-height: 0;
  }
  .preview-action {
    border-radius: 8px;
    padding: 5px 9px;
    font-size: 12px;
    cursor: pointer;
  }
  .preview-action:hover {
    background: #8882;
  }
  .preview-action:disabled {
    cursor: default;
    opacity: 0.4;
  }
  .preview-action:focus-visible,
  input:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
  @media (max-width: 800px) {
    .preview-panel {
      flex-basis: 100%;
      min-width: 0;
    }
  }
</style>
