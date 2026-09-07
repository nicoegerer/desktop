/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript CI entry point. */
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import yaml from 'js-yaml'

const manifestPlatforms = new Map([
  ['latest.yml', 'windows'],
  ['latest-mac.yml', 'macos'],
  ['latest-linux.yml', 'linux'],
  ['latest-linux-arm64.yml', 'linux']
])
const artifactDirectories = new Map([
  ['windows-2022-x64', { platform: 'windows', arch: 'x64' }],
  ['windows-11-arm-arm64', { platform: 'windows', arch: 'arm64' }],
  ['macos-latest-x64', { platform: 'macos', arch: 'x64' }],
  ['macos-latest-arm64', { platform: 'macos', arch: 'arm64' }],
  ['ubuntu-latest-x64', { platform: 'linux', arch: 'x64' }],
  ['ubuntu-24.04-arm-arm64', { platform: 'linux', arch: 'arm64' }]
])
const assetExtension = /\.(?:exe|dmg|zip|pkg|deb|rpm|AppImage|snap|flatpak|tar\.gz|blockmap)$/i

const checkName = (name) => {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    basename(name) !== name ||
    win32.basename(name) !== name ||
    /[:?#%]/.test(name) ||
    name.includes('\0')
  ) {
    throw new Error('Unsafe release asset name: ' + String(name))
  }
  return name
}

const assetArchitecture = (name) => {
  const tokens = [...name.matchAll(/(?:^|[-_.])(x86_64|amd64|x64|aarch64|arm64)(?=[-_.]|$)/g)]
  const arch = tokens.at(-1)?.[1]
  return arch ? (['arm64', 'aarch64'].includes(arch) ? 'arm64' : 'x64') : null
}

/** Hash bytes as a stream: release installers must not be buffered in memory. */
const fileInfo = async (file) => {
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { sha512: hash.digest('base64'), size }
}

/** Select each basename once and build update metadata from the exact staged bytes. */
export async function prepareReleaseAssets(
  rootDirectory,
  { version, outputName = 'release-assets', requiredManifests = [...manifestPlatforms.keys()] } = {}
) {
  if (typeof version !== 'string' || !version.trim()) throw new Error('Release version is required')
  const root = await realpath(resolve(rootDirectory))
  checkName(outputName)
  const output = resolve(root, outputName)
  if (dirname(output) !== root)
    throw new Error('Release output must be a direct child of the workspace')
  try {
    await lstat(output)
    throw new Error('Release output already exists; refusing to overwrite: ' + output)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const groups = new Map()
  let sourceCount = 0
  for (const directory of await readdir(root, { withFileTypes: true })) {
    const artifact = artifactDirectories.get(directory.name)
    if (!artifact) {
      if (/^(windows|macos|ubuntu)-/.test(directory.name)) {
        throw new Error('Unknown release artifact directory: ' + directory.name)
      }
      continue
    }
    const { platform, arch } = artifact
    if (directory.isSymbolicLink()) throw new Error('Symlink artifact directory: ' + directory.name)
    if (!directory.isDirectory()) continue
    for (const entry of await readdir(join(root, directory.name), { withFileTypes: true })) {
      const isManifest = /^latest.*\.yml$/.test(entry.name)
      if (!assetExtension.test(entry.name) && !isManifest) continue
      checkName(entry.name)
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error('Release asset must be a regular file: ' + entry.name)
      }
      if (isManifest && !manifestPlatforms.has(entry.name)) {
        throw new Error('Unexpected unmerged update manifest: ' + entry.name)
      }
      const candidate = {
        name: entry.name,
        directory: directory.name,
        file: join(root, directory.name, entry.name),
        platform,
        arch
      }
      const candidates = groups.get(entry.name) ?? []
      candidates.push(candidate)
      groups.set(entry.name, candidates)
      sourceCount++
    }
  }
  if (!groups.size) throw new Error('No release assets found')
  for (const name of requiredManifests) {
    if (!manifestPlatforms.has(name)) throw new Error('Unknown required manifest: ' + name)
    if (!groups.has(name)) throw new Error('Missing required update manifest: ' + name)
  }
  for (const [directory, artifact] of artifactDirectories) {
    const manifestName =
      artifact.platform === 'windows'
        ? 'latest.yml'
        : artifact.platform === 'macos'
          ? 'latest-mac.yml'
          : artifact.arch === 'arm64'
            ? 'latest-linux-arm64.yml'
            : 'latest-linux.yml'
    if (
      requiredManifests.includes(manifestName) &&
      !groups.get(manifestName)?.some((candidate) => candidate.directory === directory)
    ) {
      throw new Error('Missing producer update manifest: ' + directory + '/' + manifestName)
    }
  }

  const hashes = new Map()
  const info = (file) => {
    if (!hashes.has(file)) hashes.set(file, fileInfo(file))
    return hashes.get(file)
  }
  const unambiguous = async (name, candidates) => {
    if (!candidates.length) throw new Error('No compatible source for release asset: ' + name)
    const ordered = [...candidates].sort((a, b) => a.directory.localeCompare(b.directory))
    const first = ordered[0]
    if (ordered.length > 1) {
      const expected = await info(first.file)
      for (const candidate of ordered.slice(1)) {
        const actual = await info(candidate.file)
        if (actual.size !== expected.size || actual.sha512 !== expected.sha512) {
          throw new Error('Ambiguous different-byte duplicate release asset: ' + name)
        }
      }
    }
    return first
  }

  const selected = new Map()
  for (const [name, candidates] of groups) {
    if (name.endsWith('.blockmap') || manifestPlatforms.has(name)) continue
    if (new Set(candidates.map((candidate) => candidate.platform)).size !== 1) {
      throw new Error('Conflicting platform sources for release asset: ' + name)
    }
    const arch = assetArchitecture(name)
    const matching = arch ? candidates.filter((candidate) => candidate.arch === arch) : []
    selected.set(name, await unambiguous(name, matching.length ? matching : candidates))
  }

  // A sidecar must describe the chosen payload, not another producer's build.
  for (const [name, candidates] of groups) {
    if (!name.endsWith('.blockmap')) continue
    const payloadName = name.slice(0, -'.blockmap'.length)
    const payload = selected.get(payloadName)
    if (!payload) throw new Error('Blockmap has no application payload: ' + name)
    let matching = candidates.filter((candidate) => candidate.directory === payload.directory)
    if (!matching.length) {
      const expected = await info(payload.file)
      matching = []
      for (const candidate of candidates) {
        const companion = groups
          .get(payloadName)
          ?.find((item) => item.directory === candidate.directory)
        if (!companion || candidate.platform !== payload.platform) continue
        const actual = await info(companion.file)
        if (actual.size === expected.size && actual.sha512 === expected.sha512)
          matching.push(candidate)
      }
    }
    if (!matching.length)
      throw new Error('No matching blockmap for canonical payload: ' + payloadName)
    selected.set(name, await unambiguous(name, matching))
  }
  for (const [name, candidate] of selected) {
    const needsBlockmap =
      (candidate.platform === 'windows' && name.endsWith('.exe')) ||
      (candidate.platform === 'macos' && /\.(zip|dmg)$/.test(name))
    if (needsBlockmap && !selected.has(name + '.blockmap')) {
      throw new Error('Missing blockmap for release payload: ' + name)
    }
  }

  // Read every producer's manifest before merging, so payload-specific fields
  // such as blockMapSize can be taken from the selected producer intact.
  const producerManifests = new Map()
  for (const [name, platform] of manifestPlatforms) {
    const producers = []
    for (const candidate of groups.get(name) ?? []) {
      if (candidate.platform !== platform)
        throw new Error('Wrong platform for update manifest: ' + name)
      const manifest = yaml.load(await readFile(candidate.file, 'utf8'), {
        schema: yaml.JSON_SCHEMA
      })
      if (!manifest || manifest.version !== version)
        throw new Error('Manifest version mismatch: ' + name)
      if (!Array.isArray(manifest.files) || !manifest.files.length) {
        throw new Error('Manifest has no file entries: ' + name)
      }
      const seen = new Set()
      for (const entry of manifest.files) {
        const assetName = checkName(entry?.url)
        if (seen.has(assetName)) throw new Error('Duplicate manifest file reference: ' + assetName)
        seen.add(assetName)
        const asset = selected.get(assetName)
        if (!asset) throw new Error('Missing manifest asset: ' + assetName)
        if (asset.platform !== platform || assetName.endsWith('.blockmap')) {
          throw new Error('Invalid platform/application reference in ' + name + ': ' + assetName)
        }
      }
      if (manifest.path !== undefined && !seen.has(checkName(manifest.path))) {
        throw new Error('Manifest update path is not listed in files: ' + name)
      }
      if (manifest.sha512 !== undefined && manifest.path === undefined) {
        throw new Error('Manifest has a legacy hash without an update path: ' + name)
      }
      producers.push({ candidate, manifest })
    }
    if (producers.length) producerManifests.set(name, producers)
  }

  const manifests = new Map()
  for (const [name, producers] of producerManifests) {
    const preferredArch = name === 'latest-linux-arm64.yml' ? 'arm64' : 'x64'
    const preferred = producers.filter((item) => item.candidate.arch === preferredArch)
    const baseCandidate = await unambiguous(
      name,
      (preferred.length ? preferred : producers).map((item) => item.candidate)
    )
    const base = producers.find((item) => item.candidate === baseCandidate)
    const others = producers.filter((item) => item !== base)
    if (name === 'latest-linux.yml')
      others.push(...(producerManifests.get('latest-linux-arm64.yml') ?? []))
    const sources = [base, ...others]
    const urls = [
      ...new Set(sources.flatMap((item) => item.manifest.files.map((entry) => entry.url)))
    ]
    const manifest = { ...base.manifest, files: [] }
    for (const url of urls) {
      const payload = selected.get(url)
      const entries = sources.flatMap((item) =>
        item.manifest.files
          .filter((entry) => entry.url === url)
          .map((entry) => ({ ...item, entry }))
      )
      let matching = entries.filter((item) => item.candidate.directory === payload.directory)
      if (!matching.length) {
        const expected = await info(payload.file)
        matching = []
        for (const item of entries) {
          const companion = groups
            .get(url)
            ?.find((candidate) => candidate.directory === item.candidate.directory)
          if (!companion) continue
          const actual = await info(companion.file)
          if (actual.size === expected.size && actual.sha512 === expected.sha512)
            matching.push(item)
        }
      }
      if (!matching.length) throw new Error('No producer metadata for canonical payload: ' + url)
      const comparable = (entry) => {
        const result = { ...entry }
        delete result.sha512
        delete result.size
        return result
      }
      const canonical = matching[0].entry
      for (const alternative of matching.slice(1)) {
        if (!isDeepStrictEqual(comparable(canonical), comparable(alternative.entry))) {
          throw new Error('Ambiguous producer metadata for release asset: ' + url)
        }
      }
      manifest.files.push({ ...canonical })
    }
    selected.set(name, baseCandidate)
    manifests.set(name, manifest)
  }

  // No destructive cleanup: fresh output is mandatory, and each destination is exclusive.
  await mkdir(output)
  for (const [name, candidate] of selected) {
    if (!manifests.has(name))
      await copyFile(candidate.file, join(output, name), constants.COPYFILE_EXCL)
  }
  for (const [name, manifest] of manifests) {
    for (const entry of manifest.files) Object.assign(entry, await info(join(output, entry.url)))
    if (manifest.path !== undefined) {
      const legacyInfo = await info(join(output, manifest.path))
      manifest.sha512 = legacyInfo.sha512
      if (Object.hasOwn(manifest, 'size')) manifest.size = legacyInfo.size
    }
    await writeFile(join(output, name), yaml.dump(manifest, { lineWidth: -1, noRefs: true }), {
      flag: 'wx'
    })
  }
  return {
    output,
    assets: [...selected.keys()].sort(),
    sourceCount,
    deduplicated: sourceCount - selected.size,
    selectedSources: Object.fromEntries(
      [...selected].map(([name, candidate]) => [name, candidate.directory])
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.cwd()
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const result = await prepareReleaseAssets(root, { version })
  console.log(
    JSON.stringify({
      version,
      output: result.output,
      assets: result.assets,
      deduplicated: result.deduplicated
    })
  )
}
