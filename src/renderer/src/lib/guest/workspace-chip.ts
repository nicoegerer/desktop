import { applyWorkspaceToPayload } from '../../../../shared/services/chat-payload.ts'
import { createTerminalStoreBridge } from './terminal-store-bridge.ts'

/**
 * Source of the script injected into the embedded Open WebUI page.
 *
 * Open WebUI owns the chat interface, so the workspace control has to be added
 * from the outside. Two things are done there:
 *
 *  - `fetch` to `/api/chat/completions` is patched so the request carries the
 *    workspace picked for that conversation and always carries the desktop's
 *    connectors. The request body is a far more stable contract than the
 *    page's markup, so the behaviour does not depend on any DOM detail.
 *  - A chip is placed next to the message box, and the connector rows are
 *    hidden from the tools menu. Both are cosmetic: if Open WebUI changes its
 *    markup, the anchors are simply not found and the chat keeps working.
 */

export interface GuestScriptOptions {
  /** Connector tool ids that must be active in every conversation. */
  alwaysOnToolIds: string[]
  /** Connector names to hide from the tools menu. */
  hiddenToolNames: string[]
  german: boolean
}

export const buildWorkspaceChipScript = (options: GuestScriptOptions): string => `
(function () {
  var FLAG = '__desktopWorkspaceChip';
  if (window[FLAG]) { window[FLAG].configure(${JSON.stringify(options)}); return; }

  var opts = ${JSON.stringify(options)};
  var applyWorkspaceToPayload = ${applyWorkspaceToPayload.toString()};
  var createTerminalStoreBridge = ${createTerminalStoreBridge.toString()};

  var t = function (de, en) { return opts.german ? de : en; };

  // ── Per-conversation selection ──────────────────────
  var KEY = 'desktop:workspace-selection';
  var readAll = function () {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  };
  var writeAll = function (map) {
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* quota */ }
  };
  // A conversation has no id until its first reply, so drafts share one slot.
  var chatKey = function () {
    var m = /\\/c\\/([^/?#]+)/.exec(location.pathname);
    return m ? m[1] : 'draft';
  };
  // Injection can finish just after Open WebUI has already changed the URL.
  // A stored draft is evidence that this first render still needs a handover.
  var lastChatKey = readAll().draft ? 'draft' : chatKey();
  var pendingSelection = null;
  var pendingSourceKey = null;
  var selectionVersion = 0;
  var manualSelection = null;
  var temporaryChat = function (key) { return key === 'draft' || key === 'new'; };

  // Sending the first message turns the draft into a real conversation and the
  // URL gains its id. Without carrying the choice over, the workspace picked
  // before sending would be forgotten the moment it was used.
  var adoptDraft = function () {
    var key = chatKey();
    if (key === lastChatKey) return null;
    var all = readAll();
    var adopted = null;
    if (!all[key] && temporaryChat(lastChatKey) && !temporaryChat(key)) {
      adopted = pendingSelection || all.draft || null;
      if (adopted) all[key] = adopted;
    }
    if (pendingSourceKey && temporaryChat(pendingSourceKey) && pendingSourceKey !== key) delete all[pendingSourceKey];
    if (key !== 'draft') delete all.draft;
    if (adopted || pendingSourceKey) writeAll(all);
    lastChatKey = key;
    pendingSelection = null;
    pendingSourceKey = null;
    return adopted;
  };
  var selection = function () { return readAll()[chatKey()] || null; };

  /**
   * Tell the desktop which workspaces are still spoken for. Only the page knows
   * that, because the selections live per conversation in this store — and a
   * workspace nobody points at keeps a handle on its folder for nothing.
   */
  var reportLiveWorkspaces = function (extra) {
    var all = readAll();
    var ids = [];
    for (var key in all) {
      if (!Object.prototype.hasOwnProperty.call(all, key)) continue;
      var entry = all[key];
      if (entry && entry.terminalId && ids.indexOf(entry.terminalId) === -1) {
        ids.push(entry.terminalId);
      }
    }
    if (extra && extra.terminalId && ids.indexOf(extra.terminalId) === -1) {
      ids.push(extra.terminalId);
    }
    ask('workspaceKeepAlive', { ids: ids });
  };
  var saveSelection = function (value, key) {
    var all = readAll();
    key = key || chatKey();
    if (value) { all[key] = value; } else { delete all[key]; }
    writeAll(all);
  };
  var changeWorkspace = function (load) {
    var key = chatKey();
    var version = ++selectionVersion;
    var current = function () { return key === chatKey() && version === selectionVersion; };
    // Reserve a newly started terminal while the live Open WebUI stores are
    // updated. Persist and render the chip only after that update succeeds, so
    // the chip can never claim a workspace while Files still shows another.
    selectionBeingApplied = 'manual:' + version;
    busy = true;
    reportPreviewState(true);
    note = t('Arbeitsbereich wird aktiviert …', 'Activating workspace …');
    renderPanel();
    var task = Promise.resolve().then(load).then(function (value) {
      if (!current()) return null;
      reportLiveWorkspaces(value);
      return ensureWorkspaceReady(value);
    }).then(function (ready) {
      if (!current()) return false;
      reportLiveWorkspaces(ready);
      return applySelectionAsync(ready, current).then(function (ok) {
        if (!current()) return false;
        selectionBeingApplied = '';
        busy = false;
        if (!ok) {
          appliedSelection = '';
          note = t(
            'Arbeitsbereich konnte nicht in Open WebUI aktiviert werden.',
            'The workspace could not be activated in Open WebUI.'
          );
          reportLiveWorkspaces();
          renderPanel();
          scheduleRender();
          return false;
        }
        saveSelection(ready, key);
        appliedSelection = chatKey() + ':' + ((ready && ready.terminalId) || 'none');
        reportLiveWorkspaces();
        closePanel();
        scheduleRender();
        return true;
      });
    }).catch(function (error) {
      if (!current()) return false;
      selectionBeingApplied = '';
      busy = false;
      note = error && error.message ? error.message : String(error);
      reportLiveWorkspaces();
      renderPanel();
      scheduleRender();
      return false;
    });
    manualSelection = { key: key, promise: task };
    task.then(function () { if (manualSelection && manualSelection.promise === task) manualSelection = null; });
    return task;
  };
  var select = function (value) { return changeWorkspace(function () { return value; }); };

  // ── Request rewriting ───────────────────────────────
  var originalFetch = window.fetch;
  var customToolCount = null;
  var customToolNames = [];
  var managedTool = function (tool) {
    return tool && typeof tool.id === 'string' && (
      opts.alwaysOnToolIds.indexOf(tool.id) !== -1 || tool.id.indexOf('server:desktop-workspace-') === 0
    );
  };
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      // The chat picker lists optional tools. Desktop-managed tools are not
      // optional per chat. Filter only the chat catalog, not the registry or
      // admin pages; completion requests still include these tools below.
      if (String(method).toUpperCase() === 'GET' &&
          /^\\/(?:c\\/[^/]+\\/?)?$/.test(location.pathname) &&
          /^\\/api\\/v1\\/tools\\/?(?:\\?|$)/.test(url)) {
        return originalFetch.call(window, input, init).then(async function (response) {
          if (!response.ok) return response;
          try {
            var catalog = await response.clone().json();
            if (!Array.isArray(catalog)) return response;
            var visible = catalog.filter(function (tool) { return !managedTool(tool); });
            customToolNames = visible.map(function (tool) { return tool.name; });
            if (url.indexOf('?') === -1 || !/[?&]query=./.test(url)) customToolCount = visible.length;
            scheduleRender();
            if (visible.length === catalog.length) return response;
            var headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            return new Response(JSON.stringify(visible), { status: response.status, headers: headers });
          } catch (error) { return response; }
        });
      }
      if (
        String(method).toUpperCase() === 'POST' &&
        url.indexOf('/api/chat/completions') !== -1 &&
        init && typeof init.body === 'string'
      ) {
        // Keep the exact selection used for the request. Open WebUI assigns the
        // permanent conversation id asynchronously after this fetch starts.
        var requestKey = chatKey();
        var pendingChange = manualSelection && manualSelection.key === requestKey ? manualSelection.promise : null;
        var originalBody = JSON.parse(init.body);
        return Promise.resolve(pendingChange).then(function (ok) {
          if (pendingChange && !ok) throw new Error('Workspace activation failed. Select the workspace again before sending.');
          if (requestKey !== chatKey()) throw new Error('The conversation changed before sending. Please send again.');
          var requested = selection();
          var requestVersion = selectionVersion;
          var current = function () { return requestKey === chatKey() && requestVersion === selectionVersion; };
          return ensureWorkspaceReady(requested).then(function (readySelection) {
          if (!current()) throw new Error('The workspace changed before sending. Please send again.');
          reportLiveWorkspaces(readySelection);
          return applySelectionAsync(readySelection, current).then(function (selectedInComposer) {
            if (!current()) throw new Error('The workspace changed before sending. Please send again.');
            if (readySelection && readySelection.terminalId && !selectedInComposer) {
              throw new Error('The selected workspace could not be applied to Open WebUI.');
            }
            saveSelection(readySelection, requestKey);
            if (temporaryChat(requestKey)) {
              pendingSelection = readySelection;
              pendingSourceKey = requestKey;
            }
            reportLiveWorkspaces();
            var patched = applyWorkspaceToPayload(originalBody, {
              selection: readySelection,
              alwaysOnToolIds: opts.alwaysOnToolIds
            });
            var nextInit = Object.assign({}, init, { body: JSON.stringify(patched) });
            return originalFetch.call(window, input, nextInit);
          });
          });
        });
      }
    } catch (e) {
      // Never let the workspace layer break sending a message.
      console.warn('[desktop] workspace payload untouched:', e);
    }
    // Always bound to window: the page calls fetch as a bare function inside
    // strict-mode modules, where forwarding \`this\` would be undefined and the
    // browser rejects the call outright.
    return originalFetch.call(window, input, init);
  };

  // ── Desktop bridge ──────────────────────────────────
  var ask = function (type, data) {
    if (!window.electronAPI || !window.electronAPI.send) return Promise.resolve(null);
    return window.electronAPI.send(Object.assign({ type: type }, data || {}));
  };
  var readyTerminals = {};
  var terminalStarts = {};
  var ensureWorkspaceReady = function (selected) {
    if (!selected || !selected.terminalId) {
      return Promise.resolve(selected);
    }
    if (readyTerminals[selected.terminalId]) return Promise.resolve(selected);
    if (terminalStarts[selected.terminalId]) return terminalStarts[selected.terminalId];

    var requestedId = selected.terminalId;
    var requestType = selected.mode === 'cloud' ? 'workspaceMountRepo' : 'workspaceEnsure';
    var request = selected.mode === 'cloud'
      ? { repoFullName: selected.repoFullName || '', branch: selected.branch || '' }
      : { path: selected.path || '', terminalId: requestedId };
    terminalStarts[requestedId] = ask(requestType, request).then(function (result) {
      delete terminalStarts[requestedId];
      if (result && !result.ok) throw new Error(result.error || 'Workspace startup failed.');
      if (!result || !result.terminal) return selected;
      var restored = Object.assign({}, selected, {
        path: result.path || selected.path,
        terminalId: result.terminal.id,
        label: result.terminal.name || selected.label
      });
      readyTerminals[restored.terminalId] = true;
      return restored;
    }).catch(function (error) { delete terminalStarts[requestedId]; throw error; });
    return terminalStarts[requestedId];
  };

  // ── Open WebUI chrome ───────────────────────────────
  // The connectors are active in every conversation, so Open WebUI's count of
  // "available tools" only ever reports them. It is hidden while that is all it
  // would show; adding a tool of your own brings it back.
  var STYLE_ID = 'desktop-workspace-style';
  var ensureStyle = function () {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      'html.desktop-hide-terminal-menu [data-desktop-terminal-menu-wrapper],' +
      'html.desktop-hide-terminal-menu [data-desktop-terminal-menu] {' +
      'display:none !important;}' +
      '[data-desktop-automatic-tool]{display:none !important;}' +
      'html.desktop-hide-tool-count button[aria-label="Available Tools"]{display:none !important;}';
    style.textContent += '[data-desktop-preview]:focus-visible{outline:2px solid currentColor;outline-offset:2px;}';
    (document.head || document.documentElement).appendChild(style);
  };

  var tidyOpenWebUIChrome = function () {
    ensureStyle();

    var counter = document.querySelector('button[aria-label="Available Tools"]');
    var shown = counter ? parseInt((counter.textContent || '').replace(/[^0-9]+/g, ''), 10) : 0;
    var onlyOurs = customToolCount !== null
      ? customToolCount === 0 && (!counter || !(shown > 0))
      : !counter || !(shown > opts.alwaysOnToolIds.length);
    document.documentElement.classList.toggle('desktop-hide-tool-count', onlyOurs);

    // If a tool of the user's own is active the panel stays reachable, so the
    // connector rows in it are hidden individually.
    {
      var labels = document.querySelectorAll('div, span');
      for (var i = 0; i < labels.length; i++) {
        var node = labels[i];
        if (node.children && node.children.length) continue;
        var text = (node.textContent || '').trim();
        var row = node.closest ? node.closest('button[aria-pressed], [role="menuitemcheckbox"]') : null;
        if (!row) continue;
        var automatic = customToolNames.indexOf(text) === -1 &&
          (opts.hiddenToolNames.indexOf(text) !== -1 || text.indexOf('Open Terminal · ') === 0);
        if (automatic) row.setAttribute('data-desktop-automatic-tool', '1');
        else if (customToolNames.indexOf(text) !== -1) row.removeAttribute('data-desktop-automatic-tool');
      }
    }
  };

  // ── Chip ────────────────────────────────────────────
  var chip = null;
  var chipIcon = null;
  var chipLabel = null;
  var previewButton = null;
  var previewContext = '';
  var reportPreviewState = function (pending) {
    var s = selection();
    var data = { chatKey: chatKey(), terminalId: s && s.terminalId || '',
      mode: s && s.mode || '', label: s && s.label || '', pending: !!pending };
    var key = JSON.stringify(data);
    if (key === previewContext) return;
    previewContext = key;
    ask('workspacePreviewState', data);
  };
  var panel = null;
  var mode = 'local';
  var repos = null;
  var recent = [];
  var busy = false;
  var note = '';

  var findRow = function () {
    var anchor = document.getElementById('input-menu-button');
    if (!anchor) return null;
    var other = document.getElementById('integration-menu-button');
    var node = anchor.parentElement;
    while (node && other && !node.contains(other)) node = node.parentElement;
    return node || anchor.parentElement;
  };

  var closePanel = function () {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  };

  // ── Explicit Open WebUI terminal-store bridge ────────
  //
  // Open WebUI 0.11 keeps the terminal list and selected id in Svelte stores,
  // but exposes no public setter outside its bundle. The bridge below locates
  // that already-loaded store module through its shipped source map, imports
  // the same module instance, refreshes the system terminals through Open
  // WebUI's API, and updates both stores. No page reload or DOM click is used.
  // The resolved bridge is deliberately published under a named window key so
  // the unsupported boundary is explicit, inspectable, and replaceable.
  var selectionBeingApplied = '';
  var appliedSelection = '';
  var selectionApplyAttempts = {};
  var STORE_BRIDGE_KEY = '__openWebUIDesktopTerminalBridge';
  var storeBridgePromise = null;

  var readStore = function (store) {
    var value;
    var unsubscribe = store.subscribe(function (next) { value = next; });
    if (typeof unsubscribe === 'function') unsubscribe();
    return value;
  };

  var decodeVlq = function (segment) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var values = [];
    var value = 0;
    var shift = 0;
    for (var i = 0; i < segment.length; i++) {
      var digit = alphabet.indexOf(segment.charAt(i));
      if (digit < 0) continue;
      var more = digit & 32;
      value += (digit & 31) << shift;
      if (more) {
        shift += 5;
        continue;
      }
      values.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
    return values;
  };

  var generatedLocalName = function (map, code, sourceIndex, originalName) {
    var source = 0;
    var originalLine = 0;
    var originalColumn = 0;
    var nameIndex = 0;
    var mappingLines = String(map.mappings || '').split(';');
    var generatedLines = String(code || '').split('\\n');
    for (var lineIndex = 0; lineIndex < mappingLines.length; lineIndex++) {
      var generatedColumn = 0;
      var segments = mappingLines[lineIndex].split(',');
      for (var segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        if (!segments[segmentIndex]) continue;
        var fields = decodeVlq(segments[segmentIndex]);
        generatedColumn += fields[0] || 0;
        if (fields.length < 4) continue;
        source += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];
        if (fields.length < 5) continue;
        nameIndex += fields[4];
        if (source !== sourceIndex || map.names[nameIndex] !== originalName) continue;
        var line = generatedLines[lineIndex] || '';
        var start = generatedColumn;
        var end = generatedColumn;
        while (start > 0 && /[A-Za-z0-9_$]/.test(line.charAt(start - 1))) start--;
        while (end < line.length && /[A-Za-z0-9_$]/.test(line.charAt(end))) end++;
        var local = line.slice(start, end);
        if (local) return local;
      }
    }
    return null;
  };

  var exportedAlias = function (code, local) {
    var start = code.lastIndexOf('export{');
    if (start < 0) return null;
    var end = code.indexOf('}', start);
    if (end < 0) return null;
    var pairs = code.slice(start + 7, end).split(',');
    for (var i = 0; i < pairs.length; i++) {
      var sides = pairs[i].trim().split(/\\s+as\\s+/);
      if (sides[0] === local && sides[1]) return sides[1];
    }
    return null;
  };

  var bridgeFromModule = function (module, aliases) {
    var terminalServersStore = module[aliases.terminalServers];
    var selectedTerminalIdStore = module[aliases.selectedTerminalId];
    if (
      !terminalServersStore || typeof terminalServersStore.set !== 'function' ||
      !selectedTerminalIdStore || typeof selectedTerminalIdStore.set !== 'function'
    ) return null;

    // The initial catalog may have loaded before injection. Only the chat
    // cache is filtered; no tool configuration or credentials are removed.
    var toolsStore = module[aliases.tools];
    if (toolsStore && typeof toolsStore.set === 'function') {
      var catalog = readStore(toolsStore);
      if (Array.isArray(catalog)) {
        var visible = catalog.filter(function (tool) { return !managedTool(tool); });
        customToolNames = visible.map(function (tool) { return tool.name; });
        customToolCount = visible.length;
        if (visible.length !== catalog.length) toolsStore.set(visible);
      }
    }

    return createTerminalStoreBridge({
      terminalServers: terminalServersStore,
      selectedTerminalId: selectedTerminalIdStore,
      showControls: module[aliases.showControls],
      showSettings: module[aliases.showSettings],
      showFileNavPath: module[aliases.showFileNavPath],
      showFileNavDir: module[aliases.showFileNavDir]
    }, originalFetch.bind(window), function () { return localStorage.getItem('token') || ''; });
  };

  var discoverStoreBridge = function () {
    var existing = window[STORE_BRIDGE_KEY];
    if (existing && typeof existing.select === 'function') return Promise.resolve(existing);
    if (storeBridgePromise) return storeBridgePromise;

    storeBridgePromise = Promise.resolve().then(function () {
      var urls = [];
      if (window.performance && typeof window.performance.getEntriesByType === 'function') {
        var resources = window.performance.getEntriesByType('resource');
        for (var i = 0; i < resources.length; i++) {
          var url = String(resources[i].name || '');
          if (url.indexOf('/_app/immutable/') !== -1 && /\\.js(?:\\?|$)/.test(url)) urls.push(url.split('?')[0]);
        }
      }
      var scripts = document.querySelectorAll('script[src]');
      for (var j = 0; j < scripts.length; j++) {
        var src = scripts[j].src || scripts[j].getAttribute('src') || '';
        if (src && /\\.js(?:\\?|$)/.test(src)) urls.push(String(src).split('?')[0]);
      }
      urls = urls.filter(function (url, index, all) { return all.indexOf(url) === index; });

      var inspect = function (index) {
        if (index >= urls.length) return Promise.resolve(null);
        var moduleUrl = urls[index];
        return Promise.all([
          originalFetch.call(window, moduleUrl).then(function (response) {
            return response.ok ? response.text() : '';
          }),
          originalFetch.call(window, moduleUrl + '.map').then(function (response) {
            return response.ok ? response.json() : null;
          })
        ]).then(function (parts) {
          var code = parts[0];
          var map = parts[1];
          if (!code || !map || !Array.isArray(map.sources) || !Array.isArray(map.names)) {
            return inspect(index + 1);
          }
          var sourceIndex = -1;
          for (var k = 0; k < map.sources.length; k++) {
            var sourcePath = String(map.sources[k]).split(String.fromCharCode(92)).join('/');
            if (sourcePath.endsWith('src/lib/stores/index.ts')) {
              sourceIndex = k;
              break;
            }
          }
          if (sourceIndex < 0) return inspect(index + 1);

          var names = ['terminalServers', 'selectedTerminalId', 'showControls', 'showFileNavPath', 'showFileNavDir', 'tools', 'showSettings'];
          var aliases = {};
          for (var n = 0; n < names.length; n++) {
            var local = generatedLocalName(map, code, sourceIndex, names[n]);
            if (local) aliases[names[n]] = exportedAlias(code, local);
          }
          if (!aliases.terminalServers || !aliases.selectedTerminalId) return inspect(index + 1);
          return import(moduleUrl).then(function (module) {
            return bridgeFromModule(module, aliases);
          });
        }).catch(function () { return inspect(index + 1); });
      };

      return inspect(0).then(function (bridge) {
        if (bridge) window[STORE_BRIDGE_KEY] = bridge;
        return bridge;
      });
    });
    return storeBridgePromise;
  };

  var selectTerminalInComposer = function (selected, current) {
    var key = chatKey();
    return discoverStoreBridge().then(function (bridge) {
      return bridge && typeof bridge.select === 'function'
        ? bridge.select((selected && selected.terminalId) || null, current, {
            path: selected && selected.mode === 'local' ? selected.path : undefined,
            chatId: temporaryChat(key) ? undefined : key,
            context: key
          })
        : false;
    }).then(function (ok) { return ok === true; });
  };

  // The native picker stays hidden. It is identified only by the semantic
  // tooltip Open WebUI attaches to TerminalMenu; ids belonging to More,
  // Integrations and Available Tools are rejected explicitly. This function
  // never clicks anything and is not involved in changing composer state.
  var terminalMenuTrigger = function (button) {
    var node = button;
    while (node) {
      if (
        node.getAttribute && node.getAttribute('role') === 'button' &&
        node.getAttribute('aria-haspopup') === 'true'
      ) return node;
      node = node.parentElement;
    }
    return null;
  };

  var findTerminalMenuButton = function () {
    var row = findRow();
    if (!row) return null;
    var buttons = row.querySelectorAll('button[type="button"]');
    var found = null;
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b === chip) continue;
      var id = b.id || (b.getAttribute && b.getAttribute('id')) || '';
      var aria = (b.getAttribute && b.getAttribute('aria-label')) || '';
      if (
        id === 'input-menu-button' || id === 'integration-menu-button' ||
        aria === 'Available Tools' || aria === 'Integrations' || aria === 'More'
      ) continue;
      var tooltip = b.parentElement && b.parentElement._tippy;
      var content = tooltip && tooltip.props ? tooltip.props.content : '';
      var semanticName = typeof content === 'string'
        ? content.replace(/<[^>]*>/g, '').trim()
        : (content && content.textContent ? String(content.textContent).trim() : '');
      if (semanticName !== 'Terminal' || !terminalMenuTrigger(b)) continue;
      if (found) return null;
      found = b;
    }
    return found;
  };

  var markTerminalMenu = function () {
    var button = findTerminalMenuButton();
    if (!button) return null;
    button.setAttribute('data-desktop-terminal-menu', '1');
    var trigger = terminalMenuTrigger(button);
    if (trigger) trigger.setAttribute('data-desktop-terminal-menu-wrapper', '1');
    return button;
  };

  var setMenuHidden = function (hidden) {
    document.documentElement.classList.toggle('desktop-hide-terminal-menu', !!hidden);
  };

  var applySelection = function (selected, done, current) {
    markTerminalMenu();
    setMenuHidden(true);
    selectTerminalInComposer(selected, current).then(function (ok) {
      setMenuHidden(true);
      scheduleRender();
      if (done) done(ok);
    }).catch(function (error) {
      console.warn('[desktop] terminal store bridge:', error);
      if (done) done(false);
    });
  };
  var applySelectionAsync = function (selected, current) {
    return new Promise(function (resolve) { applySelection(selected, resolve, current); });
  };

  // Open WebUI rebuilds its composer state on route changes. Reconcile once per
  // conversation/terminal combination; ensureWorkspaceReady also restarts a
  // workspace process after an app launch.
  var reconcileSelection = function (selected) {
    var selectedId = (selected && selected.terminalId) || '';
    var sourceKey = chatKey();
    var version = selectionVersion;
    var key = chatKey() + ':' + (selectedId || 'none');
    var isCurrent = function () { return sourceKey === chatKey() && version === selectionVersion; };
    if (selectionBeingApplied || appliedSelection === key) return;
    selectionBeingApplied = key;
    ensureWorkspaceReady(selected).then(function (ready) {
      if (!isCurrent()) return;
      var current = selection();
      var currentId = (current && current.terminalId) || '';
      if (currentId !== selectedId) {
        selectionBeingApplied = '';
        return;
      }
      var restoredId = (ready && ready.terminalId) || '';
      if (restoredId && restoredId !== selectedId) reportLiveWorkspaces(ready);
      applySelection(ready, function (ok) {
        if (!isCurrent()) return;
        selectionBeingApplied = '';
        if (ok) {
          saveSelection(ready);
          appliedSelection = chatKey() + ':' + ((ready && ready.terminalId) || 'none');
          delete selectionApplyAttempts[key];
          if (restoredId !== selectedId) reportLiveWorkspaces();
          return;
        }
        selectionApplyAttempts[key] = (selectionApplyAttempts[key] || 0) + 1;
        if (selectionApplyAttempts[key] < 4) setTimeout(scheduleRender, 500);
        else appliedSelection = key;
      }, isCurrent);
    }).catch(function (error) {
      if (!isCurrent()) return;
      selectionBeingApplied = '';
      console.warn('[desktop] workspace restore:', error);
      selectionApplyAttempts[key] = (selectionApplyAttempts[key] || 0) + 1;
      if (selectionApplyAttempts[key] < 4) setTimeout(scheduleRender, 500);
      else appliedSelection = key;
    });
  };

  var label = function () {
    var s = selection();
    if (!s) return t('Arbeitsbereich', 'Workspace');
    if (s.mode === 'cloud') return (s.repoFullName || '').split('/').pop() || 'cloud';
    return s.label || t('Lokal', 'Local');
  };

  var button = function (text, onClick, active) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText =
      'all:unset;box-sizing:border-box;display:flex;align-items:center;gap:7px;width:100%;' +
      'padding:6px 10px;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;' +
      (active ? 'background:rgba(127,127,127,.18);' : '');
    b.onmouseenter = function () { b.style.background = 'rgba(127,127,127,.14)'; };
    b.onmouseleave = function () { b.style.background = active ? 'rgba(127,127,127,.18)' : 'transparent'; };
    b.onclick = function (event) { event.preventDefault(); event.stopPropagation(); onClick(); };
    return b;
  };

  var heading = function (text) {
    var h = document.createElement('div');
    h.textContent = text;
    h.style.cssText =
      'padding:6px 10px 2px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;opacity:.4;';
    return h;
  };

  var openLocal = function (path, name) {
    return changeWorkspace(function () { return ask('workspaceOpenLocal', { path: path }).then(function (result) {
      if (!result || !result.ok) {
        throw new Error((result && result.error) || t('Start fehlgeschlagen.', 'Could not start.'));
      }
      readyTerminals[result.terminal.id] = true;
      return {
        mode: 'local',
        path: path,
        terminalId: result.terminal.id,
        label: name || result.terminal.name
      };
    }); });
  };

  var renderPanel = function () {
    if (!panel) return;
    panel.innerHTML = '';

    var tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:4px;padding:6px 8px 4px;';
    [['local', t('Lokal', 'Local')], ['cloud', t('Cloud', 'Cloud')]].forEach(function (entry) {
      var b = button(entry[1], function () {
        mode = entry[0];
        if (mode === 'cloud' && repos === null) {
          busy = true; renderPanel();
          ask('workspaceListRepos').then(function (result) {
            busy = false;
            repos = (result && result.ok && result.repos) || [];
            if (result && !result.ok) note = result.error || '';
            renderPanel();
          });
        }
        renderPanel();
      }, mode === entry[0]);
      b.style.width = 'auto';
      b.style.flex = '1';
      b.style.textAlign = 'center';
      tabs.appendChild(b);
    });
    panel.appendChild(tabs);

    if (note && !busy) {
      var status = document.createElement('div');
      status.setAttribute('role', 'status');
      status.textContent = note;
      status.style.cssText = 'padding:6px 12px;font-size:12px;max-width:320px;';
      panel.appendChild(status);
    }

    var list = document.createElement('div');
    list.style.cssText = 'max-height:260px;overflow:auto;padding:2px 6px 6px;';

    if (busy) {
      var wait = document.createElement('div');
      wait.textContent = t('Einen Moment …', 'One moment …');
      wait.style.cssText = 'padding:10px;font-size:12px;opacity:.5;';
      list.appendChild(wait);
    } else if (mode === 'local') {
      list.appendChild(button(t('Ordner öffnen …', 'Open a folder …'), function () {
        var sourceKey = chatKey();
        var sourceVersion = selectionVersion;
        ask('workspaceChooseFolder').then(function (result) {
          if (sourceKey === chatKey() && sourceVersion === selectionVersion && result && result.ok && result.path) {
            openLocal(result.path, result.name);
          }
        });
      }));
      if (recent.length) {
        list.appendChild(heading(t('Zuletzt verwendet', 'Recently used')));
        recent.forEach(function (entry) {
          var s = selection();
          list.appendChild(button(entry.name, function () { openLocal(entry.path, entry.name); },
            !!s && s.mode === 'local' && s.label === entry.name));
        });
      }
    } else {
      if (!repos || !repos.length) {
        var empty = document.createElement('div');
        empty.textContent = note || t('Keine Repositories.', 'No repositories.');
        empty.style.cssText = 'padding:10px;font-size:12px;opacity:.5;';
        list.appendChild(empty);
      } else {
        var search = document.createElement('input');
        search.placeholder = t('Repos durchsuchen …', 'Search repos …');
        search.style.cssText =
          'all:unset;box-sizing:border-box;display:block;width:100%;margin:2px 0 6px;padding:6px 10px;' +
          'border-radius:8px;font-size:12px;background:rgba(127,127,127,.12);';
        var results = document.createElement('div');
        var paint = function () {
          results.innerHTML = '';
          var q = search.value.trim().toLowerCase();
          var s = selection();
          repos
            .filter(function (r) { return !q || r.fullName.toLowerCase().indexOf(q) !== -1; })
            .slice(0, 60)
            .forEach(function (r) {
              results.appendChild(button(r.fullName, function () {
                // Mounting the repository read-only gives the file panel
                // something to show; writing stays with the GitHub tools.
                changeWorkspace(function () { return ask('workspaceMountRepo', {
                  repoFullName: r.fullName,
                  branch: r.defaultBranch
                }).then(function (result) {
                  if (!result || !result.ok) {
                    throw new Error((result && result.error) ||
                      t('Repository konnte nicht geöffnet werden.', 'Could not open the repository.'));
                  }
                  return {
                    mode: 'cloud',
                    repoFullName: r.fullName,
                    branch: r.defaultBranch,
                    terminalId: result.terminal.id,
                    label: result.terminal.name
                  };
                }); });
              }, !!s && s.mode === 'cloud' && s.repoFullName === r.fullName));
            });
        };
        search.oninput = paint;
        list.appendChild(search);
        list.appendChild(results);
        paint();
        setTimeout(function () { search.focus(); }, 0);
      }
    }
    panel.appendChild(list);

    if (selection()) {
      var clear = button(t('Arbeitsbereich lösen', 'Clear workspace'), function () {
        select(null);
        closePanel();
      });
      clear.style.opacity = '.55';
      clear.style.borderTop = '1px solid rgba(127,127,127,.18)';
      clear.style.borderRadius = '0';
      panel.appendChild(clear);
    }
  };

  var openPanel = function () {
    if (panel) { closePanel(); return; }
    note = '';
    var s = selection();
    if (s && s.mode === 'local') ensureWorkspaceReady(s);
    mode = s && s.mode === 'cloud' ? 'cloud' : 'local';

    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;z-index:2147483000;min-width:260px;max-width:340px;border-radius:12px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);backdrop-filter:blur(12px);' +
      'background:var(--color-gray-850,#1b1b1b);color:inherit;' +
      'border:1px solid rgba(127,127,127,.22);';
    panel.onclick = function (e) { e.stopPropagation(); };
    document.body.appendChild(panel);

    var box = chip.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(box.left, window.innerWidth - 348)) + 'px';
    panel.style.bottom = (window.innerHeight - box.top + 8) + 'px';

    busy = true; renderPanel();
    ask('workspaceRecent').then(function (result) {
      busy = false;
      recent = (result && result.ok && result.workspaces) || [];
      if (mode === 'cloud' && repos === null) {
        busy = true; renderPanel();
        ask('workspaceListRepos').then(function (r) {
          busy = false;
          repos = (r && r.ok && r.repos) || [];
          if (r && !r.ok) note = r.error || '';
          renderPanel();
        });
      } else {
        renderPanel();
      }
    });
  };

  var CHIP_STYLE =
    'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;margin-left:2px;' +
    'padding:2px 8px;border-radius:8px;font-size:13px;cursor:pointer;max-width:170px;' +
    'white-space:nowrap;overflow:hidden;transition:background .15s;';

  // Line icons that inherit the surrounding text colour, so they sit with Open
  // WebUI's own controls instead of dropping a coloured emoji into the row.
  var svg = function (body) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
      'stroke-linejoin="round" style="width:14px;height:14px;display:block;">' +
      body +
      '</svg>'
    );
  };
  var ICON_FOLDER = svg('<path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');
  var ICON_CLOUD = svg('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h.79a4.5 4.5 0 1 1 1 9Z"/>');
  var ICON_EMPTY = svg('<path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke-dasharray="3 2"/>');

  // Writes only what actually differs. The observer below reacts to DOM
  // changes, so an unconditional write here would retrigger itself forever.
  var render = function () {
    // The chat id only appears after a pushState, which raises no event, so the
    // handover is checked whenever the page changes.
    var adopted = adoptDraft();
    reportPreviewState(busy);
    tidyOpenWebUIChrome();
    var row = findRow();
    if (!row) return;
    if (!chip || !chip.isConnected) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.setAttribute('data-desktop-workspace', '1');
      chip.style.cssText = CHIP_STYLE;
      chip.onclick = function (event) { event.preventDefault(); event.stopPropagation(); openPanel(); };
      chip.onmouseenter = function () { chip.style.background = 'rgba(127,127,127,.14)'; };
      chip.onmouseleave = function () { chip.style.background = 'transparent'; };
      chipIcon = document.createElement('span');
      chipIcon.style.cssText = 'display:inline-flex;flex:0 0 auto;';
      chipLabel = document.createElement('span');
      chipLabel.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      chip.appendChild(chipIcon);
      chip.appendChild(chipLabel);
      row.appendChild(chip);
    }
    if (!previewButton || !previewButton.isConnected) {
      previewButton = document.createElement('button');
      previewButton.type = 'button';
      previewButton.setAttribute('data-desktop-preview', '1');
      previewButton.style.cssText = CHIP_STYLE;
      previewButton.onclick = function (event) {
        event.preventDefault(); event.stopPropagation();
        var s = selection();
        if (busy || !s || s.mode !== 'local') return;
        var context = chatKey() + ':' + s.terminalId;
        discoverStoreBridge().then(function (bridge) {
          var current = selection();
          if (busy || !current || context !== chatKey() + ':' + current.terminalId) return;
          if (bridge && bridge.hideFiles) bridge.hideFiles();
          ask('workspacePreviewShow', { terminalId: current.terminalId, chatKey: chatKey() });
        });
      };
      row.appendChild(previewButton);
    }
    markTerminalMenu();
    setMenuHidden(true);

    var s = selection();
    var previewText = t('Vorschau', 'Preview');
    if (previewButton.textContent !== previewText) previewButton.textContent = previewText;
    previewButton.disabled = busy || !s || s.mode !== 'local';
    previewButton.style.opacity = previewButton.disabled ? '0.4' : '0.85';
    previewButton.title = s && s.mode === 'cloud'
      ? t('Vorschau benötigt einen lokalen Arbeitsbereich', 'Preview requires a local workspace')
      : t('Website aus dem ausgewählten Arbeitsbereich anzeigen', 'Preview the selected workspace website');
    reconcileSelection(s);
    var icon = s && s.mode === 'cloud' ? ICON_CLOUD : s ? ICON_FOLDER : ICON_EMPTY;
    if (chipIcon.innerHTML !== icon) chipIcon.innerHTML = icon;
    var text = label();
    if (chipLabel.textContent !== text) chipLabel.textContent = text;
    var title = s
      ? t('Arbeitsbereich dieses Chats ändern', 'Change this conversation’s workspace')
      : t('Arbeitsbereich für diesen Chat wählen', 'Choose a workspace for this conversation');
    if (chip.title !== title) chip.title = title;
    var opacity = s ? '0.85' : '0.5';
    if (chip.style.opacity !== opacity) chip.style.opacity = opacity;
    if (adopted) {
      // The next reconciliation applies the handed-over terminal to the live
      // stores; keep it reserved while that asynchronous bridge completes.
      reportLiveWorkspaces(adopted);
    }
  };

  // Rendering mutates the DOM, which the observer would see as new work. The
  // flag drops those self-inflicted rounds and the frame keeps a burst of page
  // updates down to one render.
  var rendering = false;
  var scheduled = false;
  var scheduleRender = function () {
    if (rendering || scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      rendering = true;
      try { render(); } catch (e) { console.warn('[desktop] workspace chip:', e); }
      rendering = false;
    });
  };

  // pushState/replaceState do not emit popstate, and a URL transition does not
  // always mutate the composer DOM. Observe them explicitly so draft handover
  // cannot depend on incidental rendering work in Open WebUI.
  if (window.history) {
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = window.history[name];
      if (typeof original !== 'function') return;
      window.history[name] = function () {
        var oldKey = chatKey();
        var result = original.apply(window.history, arguments);
        if (oldKey !== chatKey()) {
          reportPreviewState(true);
          selectionVersion++;
          selectionBeingApplied = '';
          busy = false;
          closePanel();
        }
        scheduleRender();
        return result;
      };
    });
  }

  // Everything past the request rewriting is presentation. If any of it throws
  // while wiring up, the page must be left exactly as Open WebUI built it — a
  // broken chip is a nuisance, a broken chat is not usable at all.
  try {
    document.addEventListener('click', function () { closePanel(); });
    window.addEventListener('popstate', function () {
      reportPreviewState(true);
      selectionVersion++;
      selectionBeingApplied = '';
      busy = false;
      closePanel();
      scheduleRender();
    });

    var observer = new MutationObserver(scheduleRender);
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleRender();
    // Release folders left open by conversations that no longer point at them.
    reportLiveWorkspaces();

    window[FLAG] = {
      openIntegrations: function () { return discoverStoreBridge().then(function (bridge) {
        return !!(bridge && bridge.openIntegrations && bridge.openIntegrations());
      }); },
      configure: function (next) { opts = next; repos = null; scheduleRender(); }
    };
  } catch (e) {
    console.warn('[desktop] workspace chip disabled:', e);
    window[FLAG] = { configure: function () {} };
  }
})();
`
