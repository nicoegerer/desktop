<script lang="ts">
  // @ts-nocheck -- Test-only bridge intentionally exposes only synthetic fixture operations.
  import { onMount } from 'svelte'
  import Services from '../../src/renderer/src/lib/components/Main/Settings/Services.svelte'
  import WorkspacePreview from '../../src/renderer/src/lib/components/Main/Connections/WorkspacePreview.svelte'
  let tab = $state('services')
  let workspace = $state('a')
  let previewOpen = $state(false)
  let notice = $state('Keine produktiven Konten, Chats, Profile oder Dienste werden verwendet.')
  let revision = $state(0)
  async function chooseWorkspace(value: string): Promise<void> {
    previewOpen = false
    await window.electronAPI.uiSmokeSwitchWorkspace(value)
    workspace = value
    revision++
    previewOpen = true
  }
  onMount(() => {
    const openIntegrations = (): void => {
      notice =
        'Setup-Navigation ausgelöst: Open WebUI → Admin → Integrationen. Im isolierten Test wird kein echtes Konto geöffnet.'
    }
    window.addEventListener('desktop:open-webui-integrations', openIntegrations)
    const unsubscribe = window.electronAPI.onData((event) => {
      if (event.type === 'ui-smoke:notice') notice = event.data
    })
    return () => {
      window.removeEventListener('desktop:open-webui-integrations', openIntegrations)
      unsubscribe()
    }
  })
</script>

<div class="harness">
  <header class="harness-bar">
    <div>
      <strong>Open WebUI – UI Test</strong>
      <p>Isolierte Testumgebung · synthetische Daten</p>
    </div>
    <nav aria-label="Testbereich">
      <button class:active={tab === 'services'} onclick={() => (tab = 'services')}
        >Dienste & Konnektoren</button
      >
      <button class:active={tab === 'preview'} onclick={() => (tab = 'preview')}
        >Website-Vorschau testen</button
      >
    </nav>
  </header>
  <p class="harness-notice" role="status">{notice}</p>
  {#if tab === 'services'}
    <div class="services-shell"><Services /></div>
  {:else}
    <div class="preview-shell">
      <section class="workspace-controls" aria-label="Test-Arbeitsbereiche">
        <h1>Website im Arbeitsbereich</h1>
        <p>
          Die rechte Ansicht ist die echte Vorschau-Komponente. HTML und CSS werden durch den echten
          lokalen Preview-Server bereitgestellt.
        </p>
        <div class="workspace-buttons">
          <button class:active={workspace === 'a'} onclick={() => chooseWorkspace('a')}
            >Arbeitsbereich A</button
          >
          <button class:active={workspace === 'b'} onclick={() => chooseWorkspace('b')}
            >Arbeitsbereich B</button
          >
        </div>
        <p>Ausgewählt: <strong>Arbeitsbereich {workspace.toUpperCase()}</strong></p>
        <button class="primary" onclick={() => (previewOpen = true)}>Vorschau öffnen</button>
        <ul>
          <li>index.html: Website mit separatem CSS und JavaScript</li>
          <li>missing.html: verständlicher Fehler</li>
          <li>style.css: keine HTML-Einstiegsdatei</li>
          <li>../outside.html: Zugriff verweigert</li>
        </ul>
      </section>
      {#if previewOpen}
        {#key `${workspace}-${revision}`}
          <WorkspacePreview
            terminalId={`smoke-${workspace}`}
            label={`Arbeitsbereich ${workspace.toUpperCase()}`}
            onClose={() => (previewOpen = false)}
          />
        {/key}
      {/if}
    </div>
  {/if}
</div>

<style>
  :global(html),
  :global(body),
  :global(#app) {
    width: 100%;
    height: 100%;
    margin: 0;
  }
  .harness {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #101010;
    color: #eee;
  }
  .harness-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 16px 24px;
    border-bottom: 1px solid #303030;
  }
  .harness-bar strong {
    font-size: 15px;
  }
  .harness-bar p,
  .harness-notice {
    color: #a9a9a9;
    font-size: 12px;
  }
  nav,
  .workspace-buttons {
    display: flex;
    gap: 8px;
  }
  button {
    padding: 9px 14px;
    border-radius: 9px;
    border: 1px solid #444;
    cursor: pointer;
    background: #222;
  }
  button.active,
  button:hover {
    background: #383838;
  }
  button:focus-visible {
    outline: 2px solid #9ed2ff;
    outline-offset: 3px;
  }
  .harness-notice {
    margin: 0;
    padding: 10px 24px;
    background: #171e23;
  }
  .services-shell {
    flex: 1;
    min-height: 0;
    padding: 26px;
    overflow: auto;
  }
  .preview-shell {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .workspace-controls {
    flex: 1;
    min-width: 0;
    padding: 28px;
  }
  .workspace-controls h1 {
    font-size: 22px;
    margin-bottom: 14px;
  }
  .workspace-controls p {
    color: #b9b9b9;
    line-height: 1.65;
    margin: 16px 0;
  }
  .workspace-controls ul {
    color: #aaa;
    line-height: 2;
    margin-top: 28px;
  }
  .primary {
    background: #eee;
    color: #111;
  }
</style>
