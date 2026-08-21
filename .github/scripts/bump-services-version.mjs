import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const parse = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-services\.(\d+))?/.exec(value)
  if (!match) throw new Error(`Unsupported version: ${value}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    iteration: match[4] ? Number(match[4]) : 0
  }
}

const compare = (left, right) =>
  left.major - right.major || left.minor - right.minor || left.patch - right.patch

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const current = parse(packageJson.version)
const upstreamPackage = JSON.parse(
  execFileSync('git', ['show', 'upstream/main:package.json'], { encoding: 'utf8' })
)
const upstream = parse(upstreamPackage.version)
const upstreamFloor = { ...upstream, patch: upstream.patch + 1, iteration: 0 }
const base = compare(current, upstreamFloor) >= 0 ? current : upstreamFloor
const sameServicesBase =
  current.major === base.major &&
  current.minor === base.minor &&
  current.patch === base.patch &&
  /-services\.\d+$/.test(packageJson.version)
const iteration = sameServicesBase ? current.iteration + 1 : 1
const version = `${base.major}.${base.minor}.${base.patch}-services.${iteration}`

packageJson.version = version
writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`)

const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
packageLock.version = version
if (packageLock.packages?.['']) packageLock.packages[''].version = version
writeFileSync('package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`)

const changelogPath = 'CHANGELOG.md'
const changelog = readFileSync(changelogPath, 'utf8')
const marker = changelog.indexOf('\n## [')
const section = `\n## [${version}] - ${new Date().toISOString().slice(0, 10)}\n\n### Changed\n\n- Merged the latest official Open WebUI Desktop changes into the Services Edition.\n`
writeFileSync(
  changelogPath,
  marker === -1
    ? `${changelog.trimEnd()}${section}\n`
    : `${changelog.slice(0, marker)}${section}${changelog.slice(marker)}`
)

process.stdout.write(version)
