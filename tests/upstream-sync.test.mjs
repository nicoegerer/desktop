/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript git fixtures. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { prepareSync, nextServicesVersion } from '../.github/scripts/prepare-upstream-sync.mjs'

const fixture = (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'desktop-sync-test-'))
  t.after(() => {
    assert.equal(dirname(resolve(cwd)), resolve(tmpdir()))
    assert.ok(basename(cwd).startsWith('desktop-sync-test-'))
    rmSync(cwd, { recursive: true, force: true })
  })
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (file, data) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true })
    writeFileSync(join(cwd, file), typeof data === 'string' ? data : JSON.stringify(data) + '\n')
  }
  const commit = (message) => {
    git('add', '.')
    git('commit', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-b', 'main')
  git('config', 'user.name', 'Sync fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'core.autocrlf', 'false')
  write('package.json', { name: 'fixture', version: '0.0.20' })
  write('package-lock.json', { version: '0.0.20', packages: { '': { version: '0.0.20' } } })
  write('CHANGELOG.md', '# Changelog\n\n## [0.0.20]\n\nOfficial release\n')
  write('shared.txt', 'original\n')
  const upstream = commit('upstream')
  for (const ref of ['origin/main', 'upstream/main'])
    git('update-ref', `refs/remotes/${ref}`, upstream)
  git('checkout', '-b', 'release')
  write('package.json', { name: 'fixture', version: '0.0.20-services.25' })
  write('src/shared/runtime-versions.json', { openWebUI: '0.11.1', openTerminal: '0.11.34' })
  const feature = commit('feature')
  git('update-ref', 'refs/remotes/origin/managed-services', feature)
  write('release-only-fix.txt', 'must survive\n')
  commit('release-only fix')
  return { cwd, git, write, commit, upstream }
}

test('backend-only update produces one release and preserves release-only fixes', (t) => {
  const f = fixture(t)
  assert.deepEqual(prepareSync(f.cwd, 'v0.11.3'), {
    changed: true,
    version: '0.0.20-services.26',
    backend: '0.11.3'
  })
  assert.equal(readFileSync(join(f.cwd, 'release-only-fix.txt'), 'utf8'), 'must survive\n')
  assert.equal(
    JSON.parse(readFileSync(join(f.cwd, 'package-lock.json'))).packages[''].version,
    '0.0.20-services.26'
  )
  assert.equal(
    prepareSync(f.cwd, 'v0.11.3').changed,
    false,
    'same upstream must not release forever'
  )
  assert.equal(prepareSync(f.cwd, 'v0.11.2').changed, false, 'no runtime downgrade')
})

test('upstream-only update merges all official changes and keeps fork fixes', (t) => {
  const f = fixture(t)
  f.git('checkout', 'main')
  f.write('official-new.txt', 'upstream change\n')
  f.git('update-ref', 'refs/remotes/upstream/main', f.commit('new upstream'))
  f.git('checkout', 'release')
  assert.equal(prepareSync(f.cwd, 'v0.11.1').version, '0.0.20-services.26')
  assert.ok(readFileSync(join(f.cwd, 'official-new.txt'), 'utf8').includes('upstream'))
  f.git('merge-base', '--is-ancestor', 'upstream/main', 'HEAD')
  f.git('merge-base', '--is-ancestor', 'origin/managed-services', 'HEAD')
})

test('merge conflicts and a diverged mirror fail closed without rewriting refs', (t) => {
  const f = fixture(t)
  f.write('shared.txt', 'fork\n')
  const before = f.commit('fork change')
  f.git('checkout', 'main')
  f.write('shared.txt', 'upstream\n')
  f.git('update-ref', 'refs/remotes/upstream/main', f.commit('conflict'))
  f.git('checkout', 'release')
  assert.throws(() => prepareSync(f.cwd, 'v0.11.3'), /merge conflict/)
  assert.equal(f.git('rev-parse', 'HEAD'), before)
  assert.equal(f.git('status', '--porcelain'), '')
  f.git('update-ref', 'refs/remotes/origin/main', before)
  assert.throws(() => prepareSync(f.cwd, 'v0.11.3'))
  assert.equal(f.git('rev-parse', 'HEAD'), before)
})

test('versioning is monotonic and rejects malformed release data', () => {
  assert.equal(nextServicesVersion('0.0.20-services.25', '0.0.20'), '0.0.20-services.26')
  assert.equal(nextServicesVersion('0.0.20-services.25', '0.0.21'), '0.0.21-services.1')
  assert.equal(nextServicesVersion('0.0.20-services.25', '0.0.19'), '0.0.20-services.26')
  assert.throws(() => nextServicesVersion('0.0.20-services.25', '0.0.21rc1'))
})

test('workflow explicitly dispatches releases and keeps the default branch current', () => {
  const source = readFileSync(
    new URL('../.github/workflows/sync-upstream.yml', import.meta.url),
    'utf8'
  )
  assert.ok(source.includes('actions: write'))
  assert.ok(source.includes('gh workflow run release.yml --ref release'))
  assert.ok(source.includes('HEAD:managed-services HEAD:release'))
  assert.ok(source.includes('--atomic'))
  assert.ok(source.includes('--repo open-webui/open-webui'))
  assert.ok(source.indexOf('npm run test:ipc') < source.indexOf('git push --atomic'))
})

test('every gh operation targets an explicit repository after adding upstream', () => {
  const source = readFileSync(
    new URL('../.github/workflows/sync-upstream.yml', import.meta.url),
    'utf8'
  )
  const commands = source.split('\n').filter((line) => /\bgh (release|workflow|run) /.test(line))
  assert.equal(commands.length, 5)
  for (const command of commands) {
    assert.ok(
      command.includes('--repo open-webui/open-webui') ||
        command.includes('--repo "$GITHUB_REPOSITORY"'),
      `GitHub command may select the upstream repository: ${command}`
    )
  }
})
