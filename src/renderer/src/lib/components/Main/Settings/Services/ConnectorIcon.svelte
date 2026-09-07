<script lang="ts">
  let { icon = 'plug' }: { icon?: string } = $props()
</script>

<svg
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if icon === 'code'}<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" />
  {:else if icon === 'mail'}<rect x="3" y="5" width="18" height="14" rx="3" /><path
      d="m4 7 8 6 8-6"
    />
  {:else if icon === 'folder'}<path
      d="M3 8V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"
    />
  {:else if icon === 'calendar'}<rect x="3" y="5" width="18" height="16" rx="3" /><path
      d="M7 3v4m10-4v4M3 11h18M8 15h2m4 0h2m-8 3h2"
    />
  {:else if icon === 'terminal'}<rect x="3" y="4" width="18" height="16" rx="3" /><path
      d="m7 9 3 3-3 3m6 0h4"
    />
  {:else}<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4" />{/if}
</svg>
