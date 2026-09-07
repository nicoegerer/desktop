import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build as viteBuild } from 'vite'
import { build as esbuild } from 'esbuild'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

const directory = path.dirname(fileURLToPath(import.meta.url))
const output = path.join(directory, '.out')
const require = createRequire(import.meta.url)
await Promise.all([
  viteBuild({
    configFile: false,
    root: directory,
    base: './',
    logLevel: 'warn',
    plugins: [tailwindcss(), svelte()],
    build: { outDir: path.join(output, 'renderer'), emptyOutDir: false }
  }),
  esbuild({
    entryPoints: [path.join(directory, 'main.ts'), path.join(directory, 'preload.ts')],
    outdir: output,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'warning'
  })
])
console.log('UI_TEST_BUILD_OK: real Services and WorkspacePreview components compiled.')
if (!process.argv.includes('--build-only')) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [path.join(output, 'main.cjs')], {
    stdio: 'inherit',
    // This window is intentionally visible for the explicitly requested UI test.
    windowsHide: false,
    env
  })
  console.log(`UI_TEST_PID=${child.pid}`)
  child.on('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
}
