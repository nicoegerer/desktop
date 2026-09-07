import type { ManagedServiceDefinition } from '../../../../../../../shared/services/types'

/** Rebuild only edited fields; hidden advanced settings and secrets survive. */
export function connectorPayload(
  draft: ManagedServiceDefinition,
  argsText: string,
  entries: ReadonlyArray<{ key: string; value: string }>
): Omit<ManagedServiceDefinition, 'id'> & { id?: string } {
  const args = argsText.split(/\r?\n/).filter((entry) => entry.length > 0)
  const env = Object.fromEntries(
    entries.filter((entry) => entry.key.trim()).map((entry) => [entry.key.trim(), entry.value])
  )
  return {
    ...draft,
    id: draft.id || undefined,
    name: draft.name.trim(),
    env,
    ...(draft.type === 'generic'
      ? { args, mcpo: undefined, remote: undefined, accessToken: undefined }
      : draft.type === 'mcpo'
        ? {
            apiKey: draft.id ? draft.apiKey : '',
            mcpo: { ...draft.mcpo!, serverArgs: args },
            remote: undefined,
            accessToken: undefined
          }
        : { command: '', args: [], mcpo: undefined, remote: { url: draft.remote!.url.trim() } })
  }
}
