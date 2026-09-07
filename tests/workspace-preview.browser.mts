/**
 * Real Chromium regression, isolated from the installed application and its data.
 * Run: node --experimental-strip-types --test tests/workspace-preview.browser.mts
 * Uses the existing Electron devDependency; no browser/package downloads or CU.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { WorkspacePreviewManager } from '../src/main/services/workspace-preview.ts'
import {
  isWorkspacePreviewNavigationAllowed,
  getWorkspacePreviewRequestHeaders
} from '../src/shared/workspace-preview.ts'

const require = createRequire(import.meta.url)

test(
  'real Chromium renders sandboxed assets and blocks privileged access, network and stale roots',
  {
    timeout: 240_000,
    skip:
      process.platform === 'linux' && !process.env.DISPLAY
        ? 'Requires a graphical test session (or Xvfb)'
        : false
  },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-workspace-preview-browser-'))
    const firstRoot = path.join(directory, 'first')
    const secondRoot = path.join(directory, 'second')
    const manager = new WorkspacePreviewManager()
    let parentHtml = ''
    let activeUrl = ''
    let trapRequests = 0
    const server = createServer((request, response) => {
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html')
        response.end(parentHtml)
      } else if (request.url === '/switch') {
        void manager
          .open({ workspacePath: secondRoot })
          .then((preview) => {
            activeUrl = preview.url
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify({ url: preview.url }))
          })
          .catch((error) => {
            response.writeHead(500)
            response.end(String(error))
          })
      } else if (request.url?.startsWith('/trap')) {
        trapRequests++
        response.end('Unexpected preview egress')
      } else {
        response.writeHead(404)
        response.end()
      }
    })
    try {
      await Promise.all([
        mkdir(path.join(firstRoot, 'assets', 'nested'), { recursive: true }),
        mkdir(secondRoot)
      ])
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const parentOrigin = `http://127.0.0.1:${address.port}`
      // A system font is copied only into the ephemeral test root; it is not shipped
      // or added to repository fixtures. No user documents or profiles are opened.
      const windowsFonts = path.join(
        process.env.SystemRoot || process.env.WINDIR || 'C:/Windows',
        'Fonts'
      )
      const fontSource = [
        ...['arial.ttf', 'segoeui.ttf', 'tahoma.ttf'].map((font) => path.join(windowsFonts, font)),
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/System/Library/Fonts/Supplemental/Arial.ttf'
      ].find(existsSync)
      assert.ok(fontSource, 'A local system test font is required to exercise actual font loading')
      await copyFile(fontSource, path.join(firstRoot, 'assets', 'preview.ttf'))
      await writeFile(
        path.join(firstRoot, 'assets', 'style.css'),
        `
      @font-face {font-family: PreviewTest; src:url('/assets/preview.ttf') format('truetype')}
      h1 {color:rgb(1, 2, 3);font-family:PreviewTest}
    `
      )
      await writeFile(
        path.join(firstRoot, 'assets', 'nested', 'value.mjs'),
        'export const value = "nested module loaded";'
      )
      await writeFile(
        path.join(firstRoot, 'assets', 'module.mjs'),
        'import {value} from "./nested/value.mjs"; document.body.dataset.module = value;'
      )
      await writeFile(
        path.join(firstRoot, 'index.html'),
        `<!doctype html>
      <link rel="stylesheet" href="/assets/style.css"><h1>First synthetic website</h1>
      <script type="module" src="/assets/module.mjs"></script>
      <script>
        const blocked = {};
        try { blocked.parent = parent.__privateParent === undefined ? false : false; } catch { blocked.parent = true; }
        try { document.cookie; blocked.cookie = false; } catch { blocked.cookie = true; }
        try { localStorage.getItem('test'); blocked.storage = false; } catch { blocked.storage = true; }
        blocked.require = typeof require === 'undefined';
        blocked.process = typeof process === 'undefined';
        blocked.electron = typeof electronAPI === 'undefined' && typeof api === 'undefined';
        blocked.popup = window.open(${JSON.stringify(`${parentOrigin}/trap/popup`)}) === null;
        const networkProbe = fetch(${JSON.stringify(`${parentOrigin}/trap/fetch`)}).then(() => blocked.fetch = false).catch(() => blocked.fetch = true);
        new Image().src = ${JSON.stringify(`${parentOrigin}/trap/image`)};
        const form = document.createElement('form'); form.action = ${JSON.stringify(`${parentOrigin}/trap/form`)};
        document.body.append(form); form.submit();
        const moduleReady = new Promise((resolve, reject) => {
          const module = document.querySelector('script[type="module"]');
          module.addEventListener('load', resolve, {once:true});
          module.addEventListener('error', () => reject(new Error('Local module assets failed to load')), {once:true});
        });
        Promise.all([document.fonts.load('16px PreviewTest'), moduleReady, networkProbe])
          .then(([fonts]) => parent.postMessage({kind:'preview-probe', blocked,
            color:getComputedStyle(document.querySelector('h1')).color,
            module:document.body.dataset.module, fontLoaded: fonts.length > 0 && fonts.every(font => font.status === 'loaded')}, '*'))
          .catch(error => parent.postMessage({kind:'preview-probe', error:String(error), blocked,
            color:getComputedStyle(document.querySelector('h1')).color,module:document.body.dataset.module}, '*'));
        addEventListener('message', event => {
          const action = event.data?.action;
          if(action === 'location') location.href = ${JSON.stringify(`${parentOrigin}/trap/location`)};
          if(action === 'data') location.href = 'data:text/html,<img src=${parentOrigin}/trap/data>';
          if(action === 'link') {const link=document.createElement('a');link.href=${JSON.stringify(`${parentOrigin}/trap/link`)};document.body.append(link);link.click();}
          if(action === 'meta') {const meta=document.createElement('meta');meta.httpEquiv='refresh';meta.content='0;url=${parentOrigin}/trap/meta';document.head.append(meta);}
        });
      </script>`
      )
      await writeFile(
        path.join(secondRoot, 'index.html'),
        `<!doctype html><h1>Second synthetic website</h1><script>parent.postMessage({kind:'second-preview'}, '*')</script>`
      )
      const first = await manager.open({ workspacePath: firstRoot })
      activeUrl = first.url
      parentHtml = `<!doctype html><title>Isolated preview browser regression</title><script>
      window.__privateParent = 'synthetic parent secret'; window.messages = [];
      addEventListener('message', event => window.messages.push({origin:event.origin,data:event.data}));
      </script><iframe id="preview" sandbox="allow-scripts" src="${first.url}"></iframe>`
      const runnerPath = path.join(directory, 'electron-runner.cjs')
      const preloadPath = path.join(directory, 'synthetic-preload.cjs')
      await writeFile(
        preloadPath,
        "require('electron').contextBridge.exposeInMainWorld('electronAPI', {syntheticTestOnly:true})"
      )
      await writeFile(
        runnerPath,
        `
      const {app, BrowserWindow} = require('electron');
      const allowNavigation = ${isWorkspacePreviewNavigationAllowed.toString()};
      const isWorkspacePreviewNavigationAllowed = allowNavigation;
      const previewHeaders = ${getWorkspacePreviewRequestHeaders.toString()};
      let activePreviewUrl = ${JSON.stringify(activeUrl)};
      const logs = [], blockedNavigations = [];
      app.setPath('userData', ${JSON.stringify(path.join(directory, 'electron-data'))});
      app.disableHardwareAcceleration();
      app.commandLine.appendSwitch('no-first-run');
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      async function until(read, test, label) {const deadline=Date.now()+60000;while(Date.now()<deadline){const value=await read();if(test(value))return value;await sleep(100);}throw new Error('Timed out: '+label);}
      app.whenReady().then(async () => {
        const win = new BrowserWindow({show:false,width:960,height:720,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(preloadPath)},backgroundThrottling:false,partition:'preview-browser-regression'}});
        win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
        win.webContents.session.webRequest.onBeforeSendHeaders((details,callback)=>{
          const headers=details.webContentsId===win.webContents.id ? previewHeaders(details.url,activePreviewUrl,details.requestHeaders) : details.requestHeaders;
          callback({requestHeaders:headers});
        });
        win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        win.webContents.on('console-message', (_event,_level,message)=>{if(logs.length<30)logs.push(message.replace(/__desktop_preview=[a-f0-9]+/g,'__desktop_preview=REDACTED'));});
        win.webContents.on('will-frame-navigate', event=>{if(!event.isMainFrame && !allowNavigation(event.url,activePreviewUrl)){blockedNavigations.push(event.url);event.preventDefault();}});
        await win.loadURL(${JSON.stringify(parentOrigin)});
        const parentHasSyntheticBridge=await win.webContents.executeJavaScript('window.electronAPI?.syntheticTestOnly === true');
        const readMessages=()=>win.webContents.executeJavaScript('window.messages');
        const messages=await until(readMessages,list=>list.some(item=>item.data.kind==='preview-probe'),'preview asset probe');
        const probe=messages.find(item=>item.data.kind==='preview-probe');
        for(const action of ['location','data','link','meta']){
          await win.webContents.executeJavaScript('document.querySelector("iframe").contentWindow.postMessage('+JSON.stringify({action})+',"*")');
          await sleep(350);
        }
        const next=await (await fetch(${JSON.stringify(`${parentOrigin}/switch`)})).json();
        activePreviewUrl=next.url;
        await win.webContents.executeJavaScript('document.querySelector("iframe").src='+JSON.stringify(next.url));
        await until(readMessages,list=>list.some(item=>item.data.kind==='second-preview'),'second workspace');
        let oldUrlClosed=false;try{await fetch(${JSON.stringify(first.url)});}catch{oldUrlClosed=true;}
        let staleRefererStatus=0;
        const staleResponse=await fetch(new URL('/index.html',next.url),{headers:{Referer:${JSON.stringify(first.url)}}});staleRefererStatus=staleResponse.status;
        console.log('PREVIEW_BROWSER_RESULT '+JSON.stringify({probe,parentHasSyntheticBridge,blockedNavigations,oldUrlClosed,staleRefererStatus,logs}));
        win.destroy();app.exit(0);
      }).catch(error=>{console.log('PREVIEW_BROWSER_FAILURE '+JSON.stringify({error:String(error),logs,blockedNavigations}));app.exit(1)});
    `
      )
      const executable = require('electron') as string
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          context.signal.throwIfAborted()
          const environment = { ...process.env }
          delete environment.ELECTRON_RUN_AS_NODE
          const child = spawn(executable, [runnerPath], {
            windowsHide: true,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe']
          })
          let output = ''
          let timedOut = false
          let stopTask: Promise<void> | undefined
          const stopOwnedProcess = (): void => {
            timedOut = true
            if (stopTask) return
            stopTask = (async () => {
              if (child.exitCode !== null || child.signalCode !== null) return
              // This PID is exclusively the child created above, never a process
              // name or discovered application. Wait for its close before cleanup.
              if (process.platform === 'win32' && child.pid && Number.isSafeInteger(child.pid)) {
                const taskkill = path.join(
                  process.env.SystemRoot || 'C:/Windows',
                  'System32',
                  'taskkill.exe'
                )
                await new Promise<void>((done) => {
                  const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
                    windowsHide: true,
                    stdio: 'ignore'
                  })
                  const killTimeout = setTimeout(() => killer.kill(), 10_000)
                  const finish = (): void => {
                    clearTimeout(killTimeout)
                    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
                    done()
                  }
                  killer.once('error', finish)
                  killer.once('close', finish)
                })
              } else {
                child.kill('SIGKILL')
              }
            })()
          }
          const timeout = setTimeout(stopOwnedProcess, 180_000)
          context.signal.addEventListener('abort', stopOwnedProcess, { once: true })
          child.stdout.on('data', (chunk) => {
            output += chunk
          })
          child.stderr.on('data', (chunk) => {
            output += chunk
          })
          child.once('error', (error) => {
            clearTimeout(timeout)
            context.signal.removeEventListener('abort', stopOwnedProcess)
            reject(error)
          })
          child.once('close', async (code) => {
            clearTimeout(timeout)
            context.signal.removeEventListener('abort', stopOwnedProcess)
            await stopTask
            if (timedOut)
              reject(new Error(`Electron preview test timed out or was aborted\n${output}`))
            else resolve({ code, output })
          })
        }
      )
      assert.equal(result.code, 0, result.output)
      const reportLine = result.output
        .split(/\r?\n/)
        .find((line) => line.startsWith('PREVIEW_BROWSER_RESULT '))
      assert.ok(reportLine, result.output)
      const report = JSON.parse(reportLine.slice('PREVIEW_BROWSER_RESULT '.length))
      assert.equal(report.probe.origin, 'null', JSON.stringify(report))
      assert.equal(report.probe.data.error, undefined, JSON.stringify(report))
      assert.equal(report.probe.data.color, 'rgb(1, 2, 3)', JSON.stringify(report))
      assert.equal(report.probe.data.module, 'nested module loaded', JSON.stringify(report))
      assert.equal(report.probe.data.fontLoaded, true, JSON.stringify(report))
      assert.equal(
        report.parentHasSyntheticBridge,
        true,
        'The trusted parent must have its synthetic preload bridge'
      )
      for (const key of [
        'parent',
        'cookie',
        'storage',
        'require',
        'process',
        'electron',
        'popup',
        'fetch'
      ]) {
        assert.equal(report.probe.data.blocked[key], true, `${key}: ${JSON.stringify(report)}`)
      }
      assert.ok(
        report.blockedNavigations.some((url: string) => url.includes('/trap/location')),
        JSON.stringify(report)
      )
      assert.ok(
        report.blockedNavigations.some((url: string) => url.startsWith('data:')),
        JSON.stringify(report)
      )
      assert.ok(
        report.blockedNavigations.some((url: string) => url.includes('/trap/link')),
        JSON.stringify(report)
      )
      assert.ok(
        report.blockedNavigations.some((url: string) => url.includes('/trap/meta')),
        JSON.stringify(report)
      )
      assert.equal(report.oldUrlClosed, true)
      assert.equal(report.staleRefererStatus, 403)
      assert.equal(
        trapRequests,
        0,
        'No external navigation/resource/form request may reach the synthetic trap server'
      )
      console.log(
        'Chromium verified: CSS + nested modules + font, opaque origin, blocked APIs/network/navigation, workspace switch.'
      )
    } finally {
      await manager.closeAll()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      const resolved = path.resolve(directory)
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
      assert.ok(path.basename(resolved).startsWith('desktop-workspace-preview-browser-'))
      await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
)
