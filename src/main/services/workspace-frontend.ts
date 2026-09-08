import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'

interface SourceMap {
  sources: string[]
  sourcesContent: string[]
  names: string[]
  mappings: string
}

/** Keep all generated columns unchanged: store discovery uses these source maps. */
export function patchWorkspaceFileNav(code: string, map: SourceMap): string | null {
  const sourceIndex = map.sources.findIndex((name) =>
    name.endsWith('/components/chat/FileNav.svelte')
  )
  if (sourceIndex < 0) return null
  const source = map.sourcesContent[sourceIndex]
  if (!source?.includes("const useServerPath = !!chatId || savedPath === '/';")) {
    throw new Error(
      'Open WebUI FileNav initialization changed; workspace compatibility needs review.'
    )
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let file = 0,
    name = 0
  const lines = code.split('\n')
  let patched = false
  map.mappings.split(';').forEach((mappingLine, generatedLine) => {
    let generatedColumn = 0
    for (const segment of mappingLine.split(',')) {
      if (!segment) continue
      const fields: number[] = []
      let value = 0,
        shift = 0
      for (const character of segment) {
        const digit = alphabet.indexOf(character)
        if (digit < 0) throw new Error('Invalid frontend source map')
        value += (digit & 31) << shift
        if (digit & 32) {
          shift += 5
          continue
        }
        fields.push(value & 1 ? -(value >> 1) : value >> 1)
        value = 0
        shift = 0
      }
      generatedColumn += fields[0]
      if (fields.length < 4) continue
      file += fields[1]
      if (fields.length < 5) continue
      name += fields[4]
      if (file !== sourceIndex || map.names[name] !== 'useServerPath') continue
      const tail = lines[generatedLine].slice(generatedColumn)
      const assignment = tail.match(/^([\w$]+=)(!![^,;]+|true\s*)(?=[,;])/)
      if (!assignment) continue // A later reference, not the declaration.
      const expression = assignment[2]
      if (
        !/^true\s*$/.test(expression) &&
        !/^!![\w$()]+\|\|[\w$]+===["']\/["']$/.test(expression)
      ) {
        throw new Error('Open WebUI FileNav generated initialization changed.')
      }
      const start = generatedColumn + assignment[1].length
      lines[generatedLine] =
        lines[generatedLine].slice(0, start) +
        'true'.padEnd(expression.length) +
        lines[generatedLine].slice(start + expression.length)
      patched = true
    }
  })
  if (!patched)
    throw new Error('Open WebUI FileNav initialization was not found in its source map.')
  return lines.join('\n')
}

/** Small, idempotent runtime compatibility patch; preserve the original installed asset. */
export async function prepareWorkspaceFrontend(frontend: string): Promise<void> {
  const directory = path.join(frontend, '_app', 'immutable', 'chunks')
  let found = false
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.js.map')) continue
    const map = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as SourceMap
    if (!map.sources.some((source) => source.endsWith('/components/chat/FileNav.svelte'))) continue
    const filename = path.join(directory, name.slice(0, -4))
    const code = await readFile(filename, 'utf8')
    const patched = patchWorkspaceFileNav(code, map)
    if (patched === null) continue
    if (patched !== code) {
      // COPYFILE_EXCL: a retry never replaces the recoverable upstream original.
      await copyFile(filename, filename + '.desktop-original', 1).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
      await writeFile(filename, patched)
    }
    found = true
  }
  if (!found)
    throw new Error('Open WebUI FileNav source map is missing; cannot safely switch workspaces.')
}
