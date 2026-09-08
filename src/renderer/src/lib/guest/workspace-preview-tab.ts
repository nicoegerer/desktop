interface PreviewSelection {
  terminalId: string
  chatKey: string
  mode: string
  pending: boolean
}

/** Injected into the guest: only a tab/placeholder lives here, never the privileged iframe. */
export function createWorkspacePreviewTab(
  ask: (
    type: string,
    data?: Record<string, unknown>
  ) => Promise<{ ok?: boolean; available?: boolean; entryPath?: string } | null>,
  translate: (de: string, en: string) => string,
  invalidate: () => void
): { update(value: PreviewSelection): void; close(): void } {
  let current: PreviewSelection | null = null
  let context = ''
  let revision = 0
  let checkedAt = 0
  let checking = false
  let entryPath = ''
  let opened = false
  let button: HTMLButtonElement | null = null
  let body: HTMLElement | null = null
  let header: HTMLElement | null = null
  let oldVisibility = ''
  let lastBounds = ''
  let resize: ResizeObserver | null = null

  const close = (): void => {
    if (body) body.style.visibility = oldVisibility
    header?.removeAttribute('data-desktop-preview-active')
    if (button) button.setAttribute('aria-pressed', 'false')
    const wasOpen = opened
    opened = false
    lastBounds = ''
    if (wasOpen) void ask('workspacePreviewHide')
  }
  const findPanel = (): {
    files: HTMLButtonElement
    header: HTMLElement
    body: HTMLElement
  } | null => {
    const container = document.getElementById('controls-container') ?? document
    for (const candidate of container.querySelectorAll<HTMLButtonElement>('button')) {
      if (!['Files', 'Dateien'].includes(candidate.textContent?.trim() ?? '')) continue
      const row = candidate.parentElement
      const bar = row?.parentElement
      const content = bar?.nextElementSibling
      // Anchor to the upstream tab bar, not file rows or a settings menu.
      if (
        !row ||
        !bar ||
        !(content instanceof HTMLElement) ||
        !Array.from(row.children).some((node) =>
          ['Controls', 'Steuerung', 'Overview', 'Übersicht'].includes(
            node.textContent?.trim() ?? ''
          )
        )
      )
        continue
      if (bar.getBoundingClientRect().width > 0)
        return { files: candidate, header: bar, body: content }
    }
    return null
  }
  const show = (): void => {
    if (!current || current.pending || !entryPath || !body?.isConnected || !header) return
    const bounds = body.getBoundingClientRect()
    if (bounds.width < 1 || bounds.height < 1) {
      close()
      return
    }
    opened = true
    body.style.visibility = 'hidden'
    header.setAttribute('data-desktop-preview-active', 'true')
    button?.setAttribute('aria-pressed', 'true')
    const data = {
      terminalId: current.terminalId,
      chatKey: current.chatKey,
      entryPath,
      bounds: {
        left: bounds.left / window.innerWidth,
        top: bounds.top / window.innerHeight,
        width: bounds.width / window.innerWidth,
        height: bounds.height / window.innerHeight
      }
    }
    const key = JSON.stringify(data)
    if (key !== lastBounds) {
      lastBounds = key
      void ask('workspacePreviewShow', data).then((result) => {
        if (key === lastBounds && !result?.ok) close()
      })
    }
  }
  const update = (value: PreviewSelection): void => {
    current = value
    const key = JSON.stringify(value)
    if (key !== context) {
      close()
      context = key
      revision++
      entryPath = ''
      checking = false
      checkedAt = 0
    }
    const eligible = value.mode === 'local' && !!value.terminalId && !value.pending
    if (eligible && !checking && Date.now() - checkedAt > 3000) {
      checking = true
      checkedAt = Date.now()
      const version = revision
      void ask('workspacePreviewInspect', { terminalId: value.terminalId })
        .then((result) => {
          if (version !== revision) return
          checking = false
          const next =
            result?.available && typeof result.entryPath === 'string' ? result.entryPath : ''
          if (next !== entryPath) {
            entryPath = next
            if (!entryPath) close()
            invalidate()
          }
        })
        .catch(() => {
          if (version === revision) {
            checking = false
            entryPath = ''
            close()
            invalidate()
          }
        })
    }
    const panel = eligible && entryPath ? findPanel() : null
    if (!panel) {
      close()
      button?.remove()
      button = null
      resize?.disconnect()
      body = null
      header = null
      return
    }
    if (panel.body !== body || !button?.isConnected) {
      close()
      button?.remove()
      resize?.disconnect()
      body = panel.body
      header = panel.header
      oldVisibility = body.style.visibility
      button = document.createElement('button')
      button.type = 'button'
      button.dataset.desktopPreviewTab = 'true'
      button.className =
        'px-2.5 py-1 text-sm rounded-lg transition whitespace-nowrap text-gray-500 dark:text-gray-400'
      button.textContent = translate('Vorschau', 'Preview')
      button.setAttribute('aria-pressed', 'false')
      button.onclick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        show()
      }
      panel.files.after(button)
      const owner = header
      owner.addEventListener(
        'click',
        (event) => {
          if (
            owner === header &&
            event.target instanceof Element &&
            event.target.closest('button') !== button
          )
            close()
        },
        true
      )
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(() => {
          if (opened) show()
        })
        resize.observe(body)
      }
    }
    if (button) button.title = entryPath
    if (opened) show()
  }
  const style = document.createElement('style')
  style.textContent =
    '[data-desktop-preview-tab]:focus-visible{outline:2px solid currentColor;outline-offset:2px}' +
    '[data-desktop-preview-tab]:hover,[data-desktop-preview-tab][aria-pressed="true"]{background:#8882;color:inherit}' +
    '[data-desktop-preview-active] button:not([data-desktop-preview-tab]){background:transparent!important}'
  document.head?.appendChild(style)
  window.addEventListener('resize', () => {
    if (opened) show()
  })
  // Detect HTML created/deleted by a model or external editor; no HTTP server starts here.
  window.setInterval?.(() => {
    if (document.visibilityState === 'visible') invalidate()
  }, 3500)
  return { update, close }
}
