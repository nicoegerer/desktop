<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte'

  let {
    title,
    closeLabel,
    onClose,
    busy = false,
    children
  }: {
    title: string
    closeLabel: string
    onClose: () => void
    busy?: boolean
    children: Snippet
  } = $props()
  let panel: HTMLElement
  const headingId = $props.id()

  onMount(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    void tick().then(() => panel?.focus())
    return () => previousFocus?.isConnected && previousFocus.focus()
  })

  function keyboard(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onClose()
    }
    if (event.key !== 'Tab' || !panel) return
    const elements = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]'
      )
    ).filter((element) => element.getClientRects().length > 0)
    const first = elements[0]
    const last = elements.at(-1)
    if (!first || !last) {
      event.preventDefault()
      return
    }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault()
      last.focus()
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || document.activeElement === panel)
    ) {
      event.preventDefault()
      first.focus()
    }
  }
</script>

<div
  class="connector-overlay"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget && !busy) onClose()
  }}
>
  <div
    bind:this={panel}
    class="connector-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby={headingId}
    tabindex="-1"
    onkeydown={keyboard}
  >
    <header>
      <h3 id={headingId}>{title}</h3>
      <button type="button" aria-label={closeLabel} disabled={busy} onclick={onClose}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg
        >
      </button>
    </header>
    {@render children()}
  </div>
</div>

<style>
  .connector-overlay {
    position: fixed;
    inset: 0;
    z-index: 110;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgb(0 0 0 / 0.5);
  }
  .connector-dialog {
    width: min(660px, 100%);
    max-height: calc(100dvh - 32px);
    overflow: auto;
    padding: 24px;
    border: 1px solid rgb(0 0 0 / 0.12);
    border-radius: 20px;
    color: #1d1d1f;
    background: #f5f5f7;
    box-shadow: 0 24px 80px rgb(0 0 0 / 0.25);
  }
  :global(.dark) .connector-dialog {
    color: #ececec;
    background: #171717;
    border-color: rgb(255 255 255 / 0.14);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }
  h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  header button {
    display: grid;
    flex: none;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 10px;
  }
  header button:hover {
    background: rgb(127 127 127 / 0.12);
  }
  .connector-dialog:focus {
    outline: none;
  }
  :global(.connector-dialog :is(button, input, select, textarea, summary, a):focus-visible) {
    outline: 2px solid #3b82f6;
    outline-offset: 3px;
  }
  @media (max-width: 480px) {
    .connector-overlay {
      padding: 8px;
    }
    .connector-dialog {
      padding: 18px;
      max-height: calc(100dvh - 16px);
      border-radius: 16px;
    }
  }
</style>
