/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript CI entry point. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const compareStable = (left, right) => {
  const parse = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Not a stable version: ${value}`)
    return value.split('.').map(Number)
  }
  const a = parse(left),
    b = parse(right)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function nextServicesVersion(previous, upstream) {
  const match = /^(\d+\.\d+\.\d+)-services\.(\d+)$/.exec(previous)
  if (!match) throw new Error(`Not a Services release: ${previous}`)
  const newerBase = compareStable(upstream, match[1]) > 0
  return `${newerBase ? upstream : match[1]}-services.${newerBase ? 1 : Number(match[2]) + 1}`
}

/** Prepare only. CI tests the candidate before atomically pushing any branch. */
export function prepareSync(cwd, backendTag) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const read = (path) => JSON.parse(readFileSync(resolve(cwd, path), 'utf8'))
  const write = (path, value) =>
    writeFileSync(resolve(cwd, path), JSON.stringify(value, null, 2) + '\n')
  if (git('status', '--porcelain')) throw new Error('Sync requires a clean checkout')
  git('merge-base', '--is-ancestor', 'origin/main', 'upstream/main')
  const baseline = git('rev-parse', 'HEAD')
  const previous = read('package.json').version
  const backendVersion = backendTag.replace(/^v/, '')
  compareStable(backendVersion, backendVersion)
  try {
    git('merge', '--no-edit', 'origin/managed-services')
    git('merge', '--no-edit', 'upstream/main')
  } catch (error) {
    try {
      git('merge', '--abort')
    } catch {
      /* no merge in progress */
    }
    throw new Error('Upstream merge conflict; no branches were pushed', { cause: error })
  }
  const runtimePath = 'src/shared/runtime-versions.json'
  const runtime = read(runtimePath)
  const runtimeChanged = compareStable(backendVersion, runtime.openWebUI) > 0
  if (runtimeChanged) {
    runtime.openWebUI = backendVersion
    write(runtimePath, runtime)
  }
  const changed = baseline !== git('rev-parse', 'HEAD') || runtimeChanged
  if (!changed) return { changed: false, version: previous, backend: runtime.openWebUI }
  const upstream = JSON.parse(git('show', 'upstream/main:package.json')).version
  const version = nextServicesVersion(previous, upstream)
  const pkg = read('package.json'),
    lock = read('package-lock.json')
  pkg.version = lock.version = version
  if (lock.packages?.['']) lock.packages[''].version = version
  write('package.json', pkg)
  write('package-lock.json', lock)
  const changelogPath = resolve(cwd, 'CHANGELOG.md')
  const changelog = readFileSync(changelogPath, 'utf8')
  const index = changelog.indexOf('\n## [')
  const entry = `\n## [${version}] - ${new Date().toISOString().slice(0, 10)}\n\n### Changed\n\n- Integrated official Desktop upstream and Open WebUI ${runtime.openWebUI}; retained all Services Edition changes.\n`
  writeFileSync(
    changelogPath,
    index < 0 ? changelog + entry : changelog.slice(0, index) + entry + changelog.slice(index)
  )
  git('add', 'package.json', 'package-lock.json', 'CHANGELOG.md', runtimePath)
  git('commit', '-m', `chore: release v${version}`)
  return { changed: true, version, backend: runtime.openWebUI }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = prepareSync(process.cwd(), process.argv[2] || '')
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(result))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
  console.log(JSON.stringify(result))
}
