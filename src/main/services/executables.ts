import { access, readdir } from 'fs/promises'
import { basename, delimiter, isAbsolute, join } from 'path'

const canExecute = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

const executableNames = (command: string): string[] => {
  if (process.platform !== 'win32') return [command]
  if (/\.(exe|cmd|bat|com)$/i.test(command)) return [command]
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
}

const pythonScriptCandidates = async (command: string): Promise<string[]> => {
  if (process.platform !== 'win32' || !/^uvx(?:\.exe)?$/i.test(basename(command))) return []

  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return []
  const pythonRoot = join(localAppData, 'Programs', 'Python')
  try {
    const entries = await readdir(pythonRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && /^Python/i.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
      .map((entry) => join(pythonRoot, entry.name, 'Scripts', 'uvx.exe'))
  } catch {
    return []
  }
}

export const resolveExecutable = async (command: string): Promise<string> => {
  const requested = command.trim()
  if (!requested) throw new Error('The service command is empty')

  const pathLike = isAbsolute(requested) || requested.includes('/') || requested.includes('\\')
  if (pathLike) {
    if (await canExecute(requested)) return requested
    throw new Error(`Executable not found: ${requested}`)
  }

  const candidates: string[] = []
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of executableNames(requested)) candidates.push(join(directory, name))
  }

  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE
    const localAppData = process.env.LOCALAPPDATA
    if (userProfile) candidates.push(join(userProfile, '.local', 'bin', 'uvx.exe'))
    if (localAppData) candidates.push(join(localAppData, 'Microsoft', 'WinGet', 'Links', 'uvx.exe'))
    candidates.push(...(await pythonScriptCandidates(requested)))
  }

  for (const candidate of [...new Set(candidates)]) {
    if (await canExecute(candidate)) return candidate
  }

  throw new Error(
    `Executable “${requested}” was not found. Add it to PATH or configure its absolute path.`
  )
}
