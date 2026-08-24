import { applyWorkspaceToPayload } from '../../../../shared/services/chat-payload.ts'

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

  var t = function (de, en) { return opts.german ? de : en; };

  // ── Per-conversation selection ──────────────────────
  var KEY = 'desktop:workspace-selection';
  var readAll = function () {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  };
  var writeAll = function (map) {
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* quota */ }
  };
  // A conversation has no id until its first reply, so drafts share one slot
  // and inherit it when the chat is saved.
  var chatKey = function () {
    var m = /\\/c\\/([^/?#]+)/.exec(location.pathname);
    return m ? m[1] : 'draft';
  };
  var selection = function () { return readAll()[chatKey()] || null; };
  var select = function (value) {
    var all = readAll();
    if (value) { all[chatKey()] = value; } else { delete all[chatKey()]; }
    writeAll(all);
    render();
  };

  // ── Request rewriting ───────────────────────────────
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      if (
        String(method).toUpperCase() === 'POST' &&
        url.indexOf('/api/chat/completions') !== -1 &&
        init && typeof init.body === 'string'
      ) {
        var patched = applyWorkspaceToPayload(JSON.parse(init.body), {
          selection: selection(),
          alwaysOnToolIds: opts.alwaysOnToolIds
        });
        init = Object.assign({}, init, { body: JSON.stringify(patched) });
      }
    } catch (e) {
      // Never let the workspace layer break sending a message.
      console.warn('[desktop] workspace payload untouched:', e);
    }
    return originalFetch.call(this, input, init);
  };

  // ── Desktop bridge ──────────────────────────────────
  var ask = function (type, data) {
    if (!window.electronAPI || !window.electronAPI.send) return Promise.resolve(null);
    return window.electronAPI.send(Object.assign({ type: type }, data || {}));
  };

  // ── Tools menu ──────────────────────────────────────
  // The rows carry no identifying attribute, so they are matched by the
  // connector name the desktop registered them under.
  var hideConnectorRows = function () {
    if (!opts.hiddenToolNames.length) return;
    var candidates = document.querySelectorAll('button, [role="menuitem"], [role="option"]');
    for (var i = 0; i < candidates.length; i++) {
      var row = candidates[i];
      if (row.dataset && row.dataset.desktopHidden) continue;
      var label = (row.textContent || '').trim();
      if (!label) continue;
      for (var j = 0; j < opts.hiddenToolNames.length; j++) {
        if (label === opts.hiddenToolNames[j]) {
          row.dataset.desktopHidden = '1';
          row.style.display = 'none';
          break;
        }
      }
    }
  };

  // ── Chip ────────────────────────────────────────────
  var chip = null;
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
      'all:unset;box-sizing:border-box;display:block;width:100%;padding:6px 10px;border-radius:8px;' +
      'font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
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
    busy = true; note = t('Terminal wird gestartet …', 'Starting terminal …'); renderPanel();
    ask('workspaceOpenLocal', { path: path }).then(function (result) {
      busy = false;
      if (!result || !result.ok) {
        note = (result && result.error) || t('Start fehlgeschlagen.', 'Could not start.');
        renderPanel();
        return;
      }
      select({ mode: 'local', terminalId: result.terminal.id, label: name || result.terminal.name });
      closePanel();
    });
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

    var list = document.createElement('div');
    list.style.cssText = 'max-height:260px;overflow:auto;padding:2px 6px 6px;';

    if (busy) {
      var wait = document.createElement('div');
      wait.textContent = t('Einen Moment …', 'One moment …');
      wait.style.cssText = 'padding:10px;font-size:12px;opacity:.5;';
      list.appendChild(wait);
    } else if (mode === 'local') {
      list.appendChild(button('📁  ' + t('Ordner öffnen …', 'Open a folder …'), function () {
        ask('workspaceChooseFolder').then(function (result) {
          if (result && result.ok && result.path) openLocal(result.path, result.name);
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
              results.appendChild(button('</>  ' + r.fullName, function () {
                select({ mode: 'cloud', repoFullName: r.fullName, branch: r.defaultBranch });
                closePanel();
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

  var render = function () {
    hideConnectorRows();
    var row = findRow();
    if (!row) return;
    if (!chip || !chip.isConnected) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.setAttribute('data-desktop-workspace', '1');
      chip.onclick = function (event) { event.preventDefault(); event.stopPropagation(); openPanel(); };
      row.appendChild(chip);
    }
    var s = selection();
    chip.textContent = (s && s.mode === 'cloud' ? '☁ ' : s ? '📁 ' : '⌁ ') + label();
    chip.title = s
      ? t('Arbeitsbereich dieses Chats ändern', 'Change this conversation’s workspace')
      : t('Arbeitsbereich für diesen Chat wählen', 'Choose a workspace for this conversation');
    chip.style.cssText =
      'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;margin-left:2px;' +
      'padding:2px 8px;border-radius:8px;font-size:13px;cursor:pointer;max-width:170px;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .15s;' +
      'opacity:' + (s ? '.85' : '.5') + ';';
    chip.onmouseenter = function () { chip.style.background = 'rgba(127,127,127,.14)'; };
    chip.onmouseleave = function () { chip.style.background = 'transparent'; };
  };

  document.addEventListener('click', function () { closePanel(); });
  window.addEventListener('popstate', render);

  var observer = new MutationObserver(function () { render(); });
  observer.observe(document.body, { childList: true, subtree: true });
  render();

  window[FLAG] = {
    configure: function (next) { opts = next; repos = null; render(); }
  };
})();
`
