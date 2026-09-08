/** Actual shipped ChatControls + FileNav, not a reimplementation of their lifecycle. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { patchWorkspaceFileNav } from '../src/main/services/workspace-frontend.ts'
import { createTerminalStoreBridge } from '../src/renderer/src/lib/guest/terminal-store-bridge.ts'
import { createWorkspacePreviewTab } from '../src/renderer/src/lib/guest/workspace-preview-tab.ts'

const require = createRequire(import.meta.url)
const { TraceMap, eachMapping } = require('@jridgewell/trace-mapping')
const frontend = process.env.OPEN_WEBUI_FRONTEND

test(
  'published FileNav changes real folders in draft and existing chats; preview lives in its tab bar',
  { skip: !frontend, timeout: 240_000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workspace-real-frontend-'))
    const chunks = path.join(frontend!, '_app', 'immutable', 'chunks')
    const exports: Record<string, { file: string; alias: string }> = {}
    let controlsFile = '',
      controlsName = '',
      patchedCode = ''
    for (const filename of await readdir(chunks)) {
      if (!filename.endsWith('.js.map')) continue
      const map = JSON.parse(await readFile(path.join(chunks, filename), 'utf8'))
      const file = filename.slice(0, -4)
      const code = await readFile(path.join(chunks, file), 'utf8')
      const lines = code.split('\n')
      const pairs = code
        .slice(code.lastIndexOf('export{') + 7)
        .split('}')[0]
        .split(',')
      const controls = map.sources.findIndex((s: string) => s.endsWith('/ChatControls.svelte'))
      const contextLine =
        controls < 0
          ? -1
          : map.sourcesContent[controls]
              .split('\n')
              .findIndex((s: string) => s.includes('const i18n')) + 1
      eachMapping(
        new TraceMap(map),
        (mapping: {
          source: string
          originalLine: number
          generatedLine: number
          generatedColumn: number
          name: string | null
        }) => {
          if (
            controls >= 0 &&
            !controlsName &&
            mapping.source.endsWith('/ChatControls.svelte') &&
            mapping.originalLine === contextLine
          ) {
            const offset =
              lines
                .slice(0, mapping.generatedLine - 1)
                .reduce((n, line) => n + line.length + 1, 0) + mapping.generatedColumn
            controlsName = [...code.slice(0, offset).matchAll(/function ([\w$]+)\([^)]*\)\{/g)].at(
              -1
            )![1]
            controlsFile = file
            patchedCode =
              (process.env.WORKSPACE_TEST_UNPATCHED ? code : patchWorkspaceFileNav(code, map)!) +
              '\nexport {' +
              controlsName +
              ' as TestControls};'
          }
          const name = mapping.name
          if (!name || exports[name]) return
          const isMount =
            name === 'mount' && mapping.source.endsWith('/svelte/src/internal/client/render.js')
          const isStore =
            [
              'config',
              'user',
              'settings',
              'terminalServers',
              'selectedTerminalId',
              'showControls'
            ].includes(name) && mapping.source.endsWith('/src/lib/stores/index.ts')
          if (!isMount && !isStore) return
          const line = lines[mapping.generatedLine - 1]
          let start = mapping.generatedColumn,
            end = start
          while (start > 0 && /[\w$]/.test(line[start - 1])) start--
          while (/[\w$]/.test(line[end] ?? '')) end++
          const local = line.slice(start, end)
          const pair = pairs.find((pair) => pair.split(' as ')[0] === local)
          if (pair) exports[name] = { file, alias: pair.split(' as ')[1] }
        }
      )
    }
    assert.ok(controlsFile && patchedCode && exports.mount && exports.selectedTerminalId)
    const first = path.join(directory, 'first'),
      second = path.join(directory, 'second')
    await mkdir(first)
    await mkdir(second)
    await writeFile(path.join(first, 'first.html'), '<h1>First</h1>')
    await writeFile(path.join(second, 'second.html'), '<h1>Second</h1>')
    const terminals = [
      { id: 'desktop-first', cwd: first },
      { id: 'desktop-second', cwd: second }
    ]
    let finish!: (value: { ok: boolean; error?: string; checks?: string[] }) => void
    const result = new Promise<{ ok: boolean; error?: string; checks?: string[] }>((resolve) => {
      finish = resolve
    })
    const imports = Object.entries(exports)
      .map(
        ([name, entry]) =>
          `import {${entry.alias} as ${name}} from '/_app/immutable/chunks/${entry.file}';`
      )
      .join('\n')
    const styles = (await readdir(path.join(frontend!, '_app', 'immutable', 'assets')))
      .filter((name) => name.endsWith('.css'))
      .map((name) => `<link rel="stylesheet" href="/_app/immutable/assets/${name}">`)
      .join('')
    const html = `<!doctype html><html class="dark">${styles}<style>
      html,body{margin:0;background:#151515;color:#ddd;font:14px system-ui;height:100%}button{cursor:pointer;background:none;color:inherit;border:0;padding:8px;border-radius:8px}
      #controls-container{height:85vh;width:520px}#fixture{position:absolute;right:0;top:10vh;bottom:0}
      .flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.h-full{height:100%}.min-h-0{min-height:0}.min-w-0{min-width:0}.shrink-0{flex-shrink:0}.items-center{align-items:center}.justify-between{justify-content:space-between}.overflow-y-auto{overflow-y:auto}.w-full{width:100%}svg{width:16px;height:16px}
      #test-controls{padding:30px;width:40%}#result{white-space:pre-wrap}
    </style><div id="test-controls"><h1>Workspace lifecycle test</h1><button id="first">First folder</button><button id="second">Second folder</button><pre id="result"></pre></div><div id="fixture"></div>
    <script type="module">
      ${imports}
      import {TestControls} from '/_app/immutable/chunks/${controlsFile}';
      const delay=ms=>new Promise(r=>setTimeout(r,ms)); const checks=[];
      const waitFor=async(fn,label)=>{for(let i=0;i<100;i++){if(fn())return;await delay(50)}throw new Error(label+'; fixture: '+document.getElementById('fixture').innerText.slice(-1200))};
      const i18n={subscribe(fn){fn({t:v=>v});return ()=>{}}};
      localStorage.token='test-only';
      const saved=location.search.includes('saved');
      const props={history:{messages:{}},chatId:saved?'existing-chat':null,models:[],params:{},chatFiles:[]};
      user.set({role:'admin',permissions:{}});config.set({features:{},code:{interpreter_engine:'pyodide'}});settings.set({});
      terminalServers.set(${JSON.stringify(terminals.map((t) => ({ id: t.id, url: '/api/v1/terminals/' + t.id })))});
      const app=mount(TestControls,{target:document.getElementById('fixture'),props,context:new Map([['i18n',i18n]])});
      const bridge=(${createTerminalStoreBridge.toString()})({terminalServers,selectedTerminalId,showControls},fetch,()=> 'test-only');
      let selection={terminalId:'',chatKey:'draft',mode:'local',pending:false};let available=true;
      const tab=(${createWorkspacePreviewTab.toString()})(async(type,data)=>{
        if(type==='workspacePreviewInspect')return {available,entryPath:selection.terminalId==='desktop-first'?'first.html':'second.html'};
        if(type==='workspacePreviewShow'){document.getElementById('result').textContent='Preview: '+data.entryPath;return {ok:true}}
        return {ok:true};
      },(_de,en)=>en,()=>tab.update(selection));
      const choose=async(id,context=saved?'existing-chat':'draft')=>{selection={...selection,pending:true};tab.update(selection);await bridge.select(id,()=>true,{path:id==='desktop-first'?${JSON.stringify(first)}:${JSON.stringify(second)},chatId:props.chatId??undefined,context});selection={terminalId:id,chatKey:context,mode:'local',pending:false};tab.update(selection);};
      document.getElementById('first').onclick=()=>choose('desktop-first');document.getElementById('second').onclick=()=>choose('desktop-second');
      window.addEventListener('error',e=>fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:e.message})}));
      try{
        await delay(300); await choose('desktop-first');
        const text=()=>document.getElementById('controls-container')?.textContent||'';
        await waitFor(()=>text().includes('first.html'),'First directory did not render');checks.push('First original folder');
        await choose('desktop-second');
        await waitFor(()=>text().includes('second.html')&&!text().includes('first.html'),'Draft kept first directory after folder switch');checks.push('Draft switches to second folder');
        await choose('desktop-first','existing-chat');await waitFor(()=>text().includes('first.html')&&!text().includes('second.html'),'Existing chat failed switch');
        await choose('desktop-second','existing-chat');await waitFor(()=>text().includes('second.html')&&!text().includes('first.html'),'Existing chat kept old folder');checks.push('Same chat switches both ways');
        await waitFor(()=>document.querySelector('[data-desktop-preview-tab]'),'Available HTML has no preview tab');
        const preview=document.querySelector('[data-desktop-preview-tab]');
        if(preview.previousElementSibling.textContent.trim()!=='Files')throw new Error('Preview not beside Files');
        preview.click();await delay(100);
        if(preview.getAttribute('aria-pressed')!=='true')throw new Error('Preview not selected');
        preview.previousElementSibling.click();if(preview.getAttribute('aria-pressed')!=='false')throw new Error('Files did not close preview');
        checks.push('Preview beside Files, tab switching works');
        available=false;selection={...selection,chatKey:'no-preview'};tab.update(selection);await delay(100);
        if(document.querySelector('[data-desktop-preview-tab]'))throw new Error('Unavailable preview was not hidden');checks.push('Unavailable preview hidden');
        available=true;await choose('desktop-first');await waitFor(()=>text().includes('first.html'),'Final folder failed');
        document.getElementById('result').textContent=checks.join('\\n');
        if(!saved){await fetch('/phase',{method:'POST',body:JSON.stringify(checks)});location.search='?saved=1'}
        else await fetch('/result',{method:'POST',body:JSON.stringify({ok:true,checks})});
      }catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:String(error.stack||error)})})}
    </script></html>`
    let draftChecks: string[] = []
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, 'http://127.0.0.1')
        const json = (value: unknown): void => {
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify(value))
        }
        if (url.pathname === '/') {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
          return
        }
        if (url.pathname === '/phase') {
          let body = ''
          for await (const part of request) body += part
          draftChecks = JSON.parse(body)
          json({})
          return
        }
        if (url.pathname === '/result') {
          let body = ''
          for await (const part of request) body += part
          const outcome = JSON.parse(body)
          if (outcome.ok)
            outcome.checks = [
              ...draftChecks.map((c) => 'Draft: ' + c),
              ...outcome.checks.map((c) => 'Saved chat: ' + c)
            ]
          finish(outcome)
          json({})
          return
        }
        if (url.pathname === '/api/v1/terminals/') {
          json(terminals)
          return
        }
        const terminal = terminals.find((t) =>
          url.pathname.startsWith('/api/v1/terminals/' + t.id + '/')
        )
        if (terminal) {
          if (url.pathname.endsWith('/files/cwd')) {
            json({ cwd: terminal.cwd })
            return
          }
          if (url.pathname.endsWith('/files/list')) {
            const directoryPath = url.searchParams.get('directory')!
            assert.ok(terminals.some((t) => path.resolve(t.cwd) === path.resolve(directoryPath)))
            json({
              entries: (await readdir(directoryPath)).map((name) => ({
                name,
                type: 'file',
                size: 20
              })),
              writable: true
            })
            return
          }
          if (url.pathname.endsWith('/api/config')) {
            json({ features: { terminal: false } })
            return
          }
          json([])
          return
        }
        if (url.pathname.startsWith('/_app/immutable/')) {
          response.setHeader(
            'Content-Type',
            url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'
          )
          response.end(
            url.pathname.endsWith('/' + controlsFile)
              ? patchedCode
              : await readFile(path.join(frontend!, url.pathname))
          )
          return
        }
        response.writeHead(404)
        response.end()
      } catch (error) {
        response.writeHead(500)
        response.end('Fixture failed')
        finish({ ok: false, error: String(error) })
      }
    })
    let child: ReturnType<typeof spawn> | undefined
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const runner = path.join(directory, 'runner.cjs')
      await writeFile(
        runner,
        "const {app,BrowserWindow}=require('electron');" +
          `app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});app.whenReady().then(async()=>{const w=new BrowserWindow({width:1280,height:900,show:${!!process.env.WORKSPACE_BROWSER_VISIBLE},title:'Open WebUI – Workspace Regression',webPreferences:{contextIsolation:true,nodeIntegration:false}});w.webContents.on('console-message',(_e,_l,message)=>{if(/Error|error/.test(message))console.log(message.slice(0,400))});await w.loadURL('http://127.0.0.1:${address.port}/');});app.on('window-all-closed',()=>app.quit());`
      )
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      child = spawn(require('electron'), [runner], {
        env,
        windowsHide: !process.env.WORKSPACE_BROWSER_VISIBLE,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      child.stdout?.on('data', (data) => {
        output += data
      })
      child.stderr?.on('data', (data) => {
        output += data
      })
      const timeout = setTimeout(
        () => finish({ ok: false, error: 'Browser timed out. ' + output.slice(-2000) }),
        90_000
      )
      const outcome = await result
      clearTimeout(timeout)
      if (!outcome.ok) console.log(output.slice(-2000))
      assert.ok(outcome.ok, outcome.error)
      console.log(outcome.checks?.join('; '))
      if (process.env.WORKSPACE_BROWSER_VISIBLE)
        await new Promise((resolve) => child!.on('exit', resolve))
    } finally {
      child?.kill()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // Only this uniquely created fixture directory, never user workspaces.
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
)
