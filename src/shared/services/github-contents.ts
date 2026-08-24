/**
 * Turning GitHub's contents API into the shapes Open WebUI's file browser
 * expects from a terminal server. Kept separate from the HTTP layer so the
 * translation can be exercised without a network or an Electron runtime.
 */

export interface FileEntry {
  name: string
  type: 'directory' | 'file'
  size: number
  modified: number
}

/**
 * Normalise a path the panel sent into a repository-relative one.
 *
 * The panel echoes back the `dir` from a previous listing, so paths arrive with
 * a leading slash; a repository has no parent, so traversal segments are simply
 * dropped rather than rejected.
 */
export const repoPath = (value: string): string =>
  String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')

/** Directories first, then files, each alphabetically — as a file tree reads. */
export const toFileEntries = (payload: unknown): FileEntry[] => {
  if (!Array.isArray(payload)) return []
  return payload
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      name: String(entry.name ?? ''),
      type: entry.type === 'dir' ? ('directory' as const) : ('file' as const),
      size: Number(entry.size ?? 0),
      // The contents API carries no timestamps and asking per file would cost a
      // request each, so the panel is told they are unknown.
      modified: 0
    }))
    .filter((entry) => entry.name)
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
    )
}

/** The listing path in the form the panel will send back to us. */
export const listingDir = (path: string): string => (path ? `/${path}` : '/')

export interface FileSlice {
  path: string
  total_lines: number
  content: string
}

/**
 * Split a file the way Open Terminal does: line endings are kept, so a slice
 * pasted back together is byte-identical to the original range.
 */
export const sliceFile = (
  path: string,
  text: string,
  startLine?: number,
  endLine?: number
): FileSlice => {
  const lines = text.split(/(?<=\n)/)
  const start = Math.max(0, (startLine ?? 1) - 1)
  const end = endLine ?? lines.length
  return {
    path: `/${path}`,
    total_lines: lines.length,
    content: lines.slice(start, end).join('')
  }
}

/** A file the panel could only render as mojibake is refused, as Open Terminal does. */
export const isBinary = (buffer: Uint8Array): boolean => buffer.includes(0)
