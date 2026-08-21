<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { fly } from 'svelte/transition'

  import type { ManagedServiceSnapshot } from '../../../../shared/services/types'

  interface Props {
    service: ManagedServiceSnapshot
    onClose: () => void
  }

  let { service, onClose }: Props = $props()
  let lines = $state<string[]>([])
  let error = $state('')
  let copied = $state(false)
  let stopping = $state(false)
  let panelHeight = $state(250)
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const refresh = async (): Promise<void> => {
    try {
      lines = await window.electronAPI.getManagedServiceLogs(service.id)
      error = ''
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const copyLogs = async (): Promise<void> => {
    await navigator.clipboard.writeText(lines.join('\n'))
    copied = true
    setTimeout(() => (copied = false), 1_500)
  }

  const stop = async (): Promise<void> => {
    stopping = true
    try {
      await window.electronAPI.stopManagedService(service.id)
      await refresh()
    } finally {
      stopping = false
    }
  }

  const onDragStart = (event: MouseEvent): void => {
    const startY = event.clientY
    const startHeight = panelHeight
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:ns-resize;'
    document.body.appendChild(overlay)

    const onMove = (moveEvent: MouseEvent): void => {
      panelHeight = Math.max(120, Math.min(600, startHeight + startY - moveEvent.clientY))
    }
    const onEnd = (): void => {
      overlay.remove()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
  }

  onMount(() => {
    void refresh()
    refreshTimer = setInterval(refresh, 1_000)
  })

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer)
  })
</script>

<div
  class="shrink-0 overflow-hidden border-t border-black/[0.1] bg-[#0a0a0a] dark:border-white/[0.1]"
  style="height: {panelHeight}px"
  in:fly={{ y: reduceMotion ? 0 : 60, duration: reduceMotion ? 0 : 180 }}
  out:fly={{ y: reduceMotion ? 0 : 60, duration: reduceMotion ? 0 : 130 }}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="relative h-0 cursor-ns-resize" onmousedown={onDragStart}>
    <div class="absolute -top-[3px] left-0 right-0 z-10 h-[6px]"></div>
  </div>
  <header class="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1">
    <span
      class="h-[7px] w-[7px] rounded-full {service.status === 'running'
        ? 'bg-emerald-400'
        : service.status === 'failed'
          ? 'bg-red-400'
          : 'bg-white/20'}"
    ></span>
    <span
      class="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wider text-white/40"
    >
      {service.name}
    </span>
    <span class="text-[9px] text-white/25">{service.type} · last 500 lines</span>
    {#if service.type !== 'remote' && (service.status === 'running' || service.status === 'starting')}
      <button
        class="rounded-md border-none bg-transparent p-1 text-white opacity-40 transition hover:bg-white/[0.08] hover:opacity-80 disabled:opacity-20"
        disabled={stopping}
        title="Stop"
        onclick={stop}
      >
        <svg
          class="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M5.636 5.636a9 9 0 1012.728 0M12 3v9"
          />
        </svg>
      </button>
    {/if}
    <button
      class="rounded-md border-none bg-transparent px-2 py-1 text-[10px] text-white opacity-40 transition hover:bg-white/[0.08] hover:opacity-80"
      onclick={copyLogs}>{copied ? 'Copied' : 'Copy'}</button
    >
    <button
      class="rounded-md border-none bg-transparent p-1 text-white opacity-40 transition hover:bg-white/[0.08] hover:opacity-80"
      title="Close"
      onclick={onClose}
    >
      <svg
        class="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="2"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </header>
  {#if error}
    <div class="border-b border-red-500/20 bg-red-500/10 px-3 py-1 text-[10px] text-red-300">
      {error}
    </div>
  {/if}
  <pre
    class="m-0 h-[calc(100%-29px)] overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-5 text-[#d6d9df]">{lines.length
      ? lines.join('\n')
      : 'No output yet.'}</pre>
</div>
