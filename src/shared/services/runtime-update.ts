/** Upgrade to the release-tested runtime, respecting explicit pins/offline mode. */
export function runtimeUpgradeVersion(
  installed: string | null,
  tested: string,
  settings: { autoUpdate?: boolean; version?: string } = {}
): string | undefined {
  if (settings.autoUpdate === false || settings.version) return undefined
  if (!installed) return tested
  const parse = (v: string): number[] | null =>
    /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null
  const current = parse(installed)
  const target = parse(tested)
  // Do not silently downgrade a newer or custom/development runtime.
  if (!current || !target) return undefined
  for (let i = 0; i < 3; i++) {
    if (current[i] < target[i]) return tested
    if (current[i] > target[i]) return undefined
  }
  return undefined
}
