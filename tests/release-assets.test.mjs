/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript release fixtures. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import yaml from 'js-yaml'
import { prepareReleaseAssets } from '../.github/scripts/prepare-release-assets.mjs'

const VERSION = '0.0.20-services.29'
const DATE = '2026-09-07T14:49:39.073Z'
const DIR = {
  wx: 'windows-2022-x64',
  wa: 'windows-11-arm-arm64',
  mx: 'macos-latest-x64',
  ma: 'macos-latest-arm64',
  lx: 'ubuntu-latest-x64',
  la: 'ubuntu-24.04-arm-arm64'
}
const sha = (bytes) => createHash('sha512').update(bytes).digest('base64')

const fixture = (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'desktop-release-assets-test-'))
  const root = realpathSync(temporary)
  t.after(() => {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
    assert.ok(basename(temporary).startsWith('desktop-release-assets-test-'))
    rmSync(temporary, { recursive: true, force: true })
  })
  const write = (directory, name, content) => {
    mkdirSync(join(root, directory), { recursive: true })
    writeFileSync(join(root, directory, name), content)
  }
  const payload = (directory, name, content) => {
    write(directory, name, content)
    if (/\.(exe|zip|dmg)$/.test(name)) write(directory, name + '.blockmap', 'map for ' + content)
  }
  const entry = (url, blockMapSize) => ({
    url,
    sha512: 'old-' + url,
    size: 999,
    ...(blockMapSize === undefined ? {} : { blockMapSize })
  })
  const manifest = (directory, name, files, path = files[0].url, version = VERSION) =>
    write(
      directory,
      name,
      yaml.dump({ version, files, path, sha512: 'old-root', releaseDate: DATE })
    )
  return { root, write, payload, entry, manifest }
}

const fullFixture = (t) => {
  const f = fixture(t)
  for (const [directory, arch] of [
    [DIR.wx, 'x64'],
    [DIR.wa, 'arm64']
  ]) {
    const name = 'open-webui-' + arch + '-setup.exe'
    f.payload(directory, name, 'windows ' + arch)
    f.manifest(directory, 'latest.yml', [f.entry(name)])
  }
  for (const [directory, nativeArch] of [
    [DIR.mx, 'x64'],
    [DIR.ma, 'arm64']
  ]) {
    const files = []
    for (const arch of ['x64', 'arm64']) {
      const name = 'open-webui-' + arch + '-mac.zip'
      const native = arch === nativeArch
      f.payload(directory, name, (native ? 'native ' : 'cross ') + arch + ' from ' + nativeArch)
      files.push(f.entry(name, native ? (arch === 'x64' ? 11 : 22) : 999))
    }
    const dmg = 'open-webui-' + nativeArch + '.dmg'
    f.payload(directory, dmg, 'dmg ' + nativeArch)
    files.push(f.entry(dmg))
    f.manifest(directory, 'latest-mac.yml', files, 'open-webui-' + nativeArch + '-mac.zip')
  }
  const linux = [
    [DIR.lx, 'x86_64', 'amd64', 'latest-linux.yml', 101],
    [DIR.la, 'arm64', 'arm64', 'latest-linux-arm64.yml', 202]
  ]
  for (const [directory, imageArch, debArch, name, blockMapSize] of linux) {
    const image = 'open-webui_' + imageArch + '.AppImage'
    const deb = 'open-webui_' + debArch + '.deb'
    f.payload(directory, image, 'appimage ' + imageArch)
    f.payload(directory, deb, 'deb ' + debArch)
    f.manifest(directory, name, [f.entry(image, blockMapSize), f.entry(deb)])
  }
  f.payload(DIR.lx, 'open-webui_amd64.snap', 'snap')
  f.payload(DIR.lx, 'open-webui.flatpak', 'flatpak')
  return f
}

test('canonical staging retains all platforms, native mac payload/sidecar pairs and four update manifests', async (t) => {
  const f = fullFixture(t)
  const result = await prepareReleaseAssets(f.root, { version: VERSION })
  assert.equal(result.assets.length, 22)
  assert.equal(new Set(result.assets).size, 22)
  assert.equal(result.deduplicated, 6)
  for (const [arch, directory, blockMapSize] of [
    ['x64', DIR.mx, 11],
    ['arm64', DIR.ma, 22]
  ]) {
    const zip = 'open-webui-' + arch + '-mac.zip'
    assert.equal(result.selectedSources[zip], directory)
    assert.equal(result.selectedSources[zip + '.blockmap'], directory)
    assert.equal(readFileSync(join(result.output, zip), 'utf8'), 'native ' + arch + ' from ' + arch)
    assert.equal(
      readFileSync(join(result.output, zip + '.blockmap'), 'utf8'),
      'map for native ' + arch + ' from ' + arch
    )
    const mac = yaml.load(readFileSync(join(result.output, 'latest-mac.yml'), 'utf8'))
    assert.equal(mac.files.find((entry) => entry.url === zip).blockMapSize, blockMapSize)
  }
  const defaults = {
    'latest.yml': 'open-webui-x64-setup.exe',
    'latest-mac.yml': 'open-webui-x64-mac.zip',
    'latest-linux.yml': 'open-webui_x86_64.AppImage',
    'latest-linux-arm64.yml': 'open-webui_arm64.AppImage'
  }
  for (const [name, expectedPath] of Object.entries(defaults)) {
    const manifest = yaml.load(readFileSync(join(result.output, name), 'utf8'))
    assert.equal(manifest.version, VERSION)
    assert.equal(manifest.path, expectedPath)
    assert.equal(manifest.releaseDate, DATE)
    assert.equal(manifest.sha512, sha(readFileSync(join(result.output, expectedPath))))
    for (const entry of manifest.files) {
      const staged = readFileSync(join(result.output, entry.url))
      assert.equal(entry.sha512, sha(staged))
      assert.equal(entry.size, staged.length)
    }
  }
  const windows = yaml.load(readFileSync(join(result.output, 'latest.yml'), 'utf8'))
  assert.deepEqual(
    windows.files.map((entry) => entry.url),
    ['open-webui-x64-setup.exe', 'open-webui-arm64-setup.exe']
  )
  const linux = yaml.load(readFileSync(join(result.output, 'latest-linux.yml'), 'utf8'))
  assert.equal(
    linux.files.find((entry) => entry.url === 'open-webui_x86_64.AppImage').blockMapSize,
    101
  )
  assert.equal(
    linux.files.find((entry) => entry.url === 'open-webui_arm64.AppImage').blockMapSize,
    202
  )
  const armLinux = yaml.load(readFileSync(join(result.output, 'latest-linux-arm64.yml'), 'utf8'))
  assert.ok(armLinux.files.every((entry) => entry.url.includes('arm64')))
  assert.equal(
    yaml.load(readFileSync(join(f.root, DIR.wx, 'latest.yml'), 'utf8')).sha512,
    'old-root'
  )
})

test('legacy top-level size is refreshed only when the producer provided it', async (t) => {
  const f = fullFixture(t)
  const source = yaml.load(readFileSync(join(f.root, DIR.wx, 'latest.yml'), 'utf8'))
  source.size = 12345
  f.write(DIR.wx, 'latest.yml', yaml.dump(source))
  const result = await prepareReleaseAssets(f.root, { version: VERSION })
  const windows = yaml.load(readFileSync(join(result.output, 'latest.yml'), 'utf8'))
  assert.equal(windows.size, readFileSync(join(result.output, windows.path)).length)
  for (const name of ['latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml']) {
    const manifest = yaml.load(readFileSync(join(result.output, name), 'utf8'))
    assert.equal(Object.hasOwn(manifest, 'size'), false)
  }
})

test('identical archless duplicates are deduplicated and optional pkg/rpm/tar.gz assets are retained', async (t) => {
  const f = fixture(t)
  f.payload(DIR.lx, 'shared.tar.gz', 'same')
  f.payload(DIR.la, 'shared.tar.gz', 'same')
  f.payload(DIR.mx, 'open-webui-x64.pkg', 'pkg')
  f.payload(DIR.lx, 'open-webui_amd64.rpm', 'rpm')
  const result = await prepareReleaseAssets(f.root, { version: VERSION, requiredManifests: [] })
  assert.equal(result.deduplicated, 1)
  assert.deepEqual(result.assets, ['open-webui-x64.pkg', 'open-webui_amd64.rpm', 'shared.tar.gz'])
  assert.equal(readFileSync(join(result.output, 'shared.tar.gz'), 'utf8'), 'same')
})

test('ambiguous different-byte archless duplicates fail before staging', async (t) => {
  const f = fixture(t)
  f.payload(DIR.lx, 'shared.tar.gz', 'x64 bytes')
  f.payload(DIR.la, 'shared.tar.gz', 'arm bytes')
  await assert.rejects(
    prepareReleaseAssets(f.root, { version: VERSION, requiredManifests: [] }),
    /Ambiguous different-byte/
  )
})

test('a canonical payload cannot use a sidecar from a different build', async (t) => {
  const f = fixture(t)
  f.write(DIR.mx, 'open-webui-x64-mac.zip', 'canonical')
  f.payload(DIR.ma, 'open-webui-x64-mac.zip', 'different cross build')
  await assert.rejects(
    prepareReleaseAssets(f.root, { version: VERSION, requiredManifests: [] }),
    /No matching blockmap/
  )
})

test('an alternate sidecar is accepted only with identical producer payload bytes', async (t) => {
  const f = fixture(t)
  f.write(DIR.mx, 'open-webui-x64-mac.zip', 'identical')
  f.payload(DIR.ma, 'open-webui-x64-mac.zip', 'identical')
  const result = await prepareReleaseAssets(f.root, { version: VERSION, requiredManifests: [] })
  assert.equal(result.selectedSources['open-webui-x64-mac.zip'], DIR.mx)
  assert.equal(result.selectedSources['open-webui-x64-mac.zip.blockmap'], DIR.ma)
  assert.equal(
    readFileSync(join(result.output, 'open-webui-x64-mac.zip.blockmap'), 'utf8'),
    'map for identical'
  )
})

test('missing payload, sidecar and platform producer metadata fail closed', async (t) => {
  for (const [directory, name, expected] of [
    [
      DIR.wx,
      'open-webui-x64-setup.exe',
      /Blockmap has no application payload|Missing manifest asset/
    ],
    [DIR.ma, 'open-webui-arm64.dmg.blockmap', /Missing blockmap/],
    [DIR.wa, 'latest.yml', /Missing producer update manifest/],
    [DIR.la, 'latest-linux-arm64.yml', /Missing required update manifest/]
  ]) {
    const f = fullFixture(t)
    unlinkSync(join(f.root, directory, name))
    await assert.rejects(prepareReleaseAssets(f.root, { version: VERSION }), expected)
  }
})

test('every producer manifest must match the release version', async (t) => {
  const f = fullFixture(t)
  const name = 'open-webui-arm64-setup.exe'
  f.manifest(DIR.wa, 'latest.yml', [f.entry(name)], name, '0.0.20-services.28')
  await assert.rejects(
    prepareReleaseAssets(f.root, { version: VERSION }),
    /Manifest version mismatch/
  )
})

test('unsafe references, missing references and invalid update paths are rejected', async (t) => {
  for (const [url, expected] of [
    ['../outside.exe', /Unsafe release asset name/],
    ['https://invalid.example/setup.exe', /Unsafe release asset name/],
    ['missing.exe', /Missing manifest asset/]
  ]) {
    const f = fullFixture(t)
    f.manifest(DIR.wx, 'latest.yml', [f.entry(url)])
    await assert.rejects(prepareReleaseAssets(f.root, { version: VERSION }), expected)
  }
  const f = fullFixture(t)
  f.manifest(DIR.wx, 'latest.yml', [f.entry('open-webui-x64-setup.exe')], 'missing.exe')
  await assert.rejects(
    prepareReleaseAssets(f.root, { version: VERSION }),
    /update path is not listed/
  )
})

test('unknown artifact directories cannot introduce a competing release source', async (t) => {
  const f = fixture(t)
  f.payload('macos-untrusted-x64', 'open-webui-x64-mac.zip', 'unexpected')
  await assert.rejects(
    prepareReleaseAssets(f.root, { version: VERSION, requiredManifests: [] }),
    /Unknown release artifact directory/
  )
})

test('existing output and paths outside the staging directory are never overwritten', async (t) => {
  const f = fullFixture(t)
  f.write('release-assets', 'keep.txt', 'keep')
  await assert.rejects(prepareReleaseAssets(f.root, { version: VERSION }), /already exists/)
  assert.equal(readFileSync(join(f.root, 'release-assets', 'keep.txt'), 'utf8'), 'keep')
  await assert.rejects(
    prepareReleaseAssets(f.root, { version: VERSION, outputName: '../outside' }),
    /Unsafe release asset name/
  )
})

test('release workflow publishes only the unique staging directory and checks out its helper', () => {
  const source = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.ok(source.includes('                      .github/scripts/prepare-release-assets.mjs'))
  assert.ok(source.includes('run: node .github/scripts/prepare-release-assets.mjs'))
  assert.ok(
    source.indexOf('run: node .github/scripts/prepare-release-assets.mjs') <
      source.indexOf('- name: Create Release')
  )
  const publish = source.slice(source.lastIndexOf('- name: Create Release'))
  assert.match(publish, /files: release-assets\/\*/)
  assert.doesNotMatch(publish, /macos-latest-\*|windows-\*|ubuntu-\*/)
  assert.ok(!source.includes('Reconcile update manifest hashes'))
  assert.ok(!source.includes('Merge macOS latest-mac.yml'))
})
