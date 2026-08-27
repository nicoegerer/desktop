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

  // Sending the first message turns the draft into a real conversation and the
  // URL gains its id. Without carrying the choice over, the workspace picked
  // before sending would be forgotten the moment it was used.
  var adoptDraft = function () {
    var key = chatKey();
    if (key === lastChatKey) return null;
    var all = readAll();
    var adopted = null;
    if (!all[key]) {
      adopted = pendingSelection || all.draft || null;
      if (adopted) all[key] = adopted;
    }
    if (pendingSourceKey && pendingSourceKey !== key) delete all[pendingSourceKey];
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
  var reportLiveWorkspaces = function () {
    var all = readAll();
    var ids = [];
    for (var key in all) {
      if (!Object.prototype.hasOwnProperty.call(all, key)) continue;
      var entry = all[key];
      if (entry && entry.terminalId && ids.indexOf(entry.terminalId) === -1) {
        ids.push(entry.terminalId);
      }
    }
    ask('workspaceKeepAlive', { ids: ids });
  };
  var select = function (value) {
    var all = readAll();
    if (value) { all[chatKey()] = value; } else { delete all[chatKey()]; }
    writeAll(all);
    // Claim a newly started terminal immediately. Driving Open WebUI's menu can
    // take more than a second; waiting for it used to let an older cleanup
    // request stop the terminal before the first message reached it.
    reportLiveWorkspaces();
    // The page has to follow, otherwise the file browser and the terminal panel
    // would keep pointing at whatever was selected before.
    applySelection(value);
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
        // Keep the exact selection used for the request. Open WebUI assigns the
        // permanent conversation id asynchronously after this fetch starts.
        pendingSelection = selection();
        pendingSourceKey = chatKey();
        var originalBody = JSON.parse(init.body);
        return ensureWorkspaceReady(pendingSelection).then(function (readySelection) {
          var patched = applyWorkspaceToPayload(originalBody, {
            selection: readySelection,
            alwaysOnToolIds: opts.alwaysOnToolIds
          });
          var nextInit = Object.assign({}, init, { body: JSON.stringify(patched) });
          return originalFetch.call(window, input, nextInit);
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
    if (!selected || selected.mode !== 'local' || !selected.terminalId) {
      return Promise.resolve(selected);
    }
    if (readyTerminals[selected.terminalId]) return Promise.resolve(selected);
    if (terminalStarts[selected.terminalId]) return terminalStarts[selected.terminalId];

    var requestedId = selected.terminalId;
    terminalStarts[requestedId] = ask('workspaceEnsure', {
      path: selected.path || '',
      terminalId: requestedId
    }).then(function (result) {
      delete terminalStarts[requestedId];
      if (!result || !result.ok || !result.terminal) return selected;
      var restored = Object.assign({}, selected, {
        path: result.path,
        terminalId: result.terminal.id,
        label: result.terminal.name || selected.label
      });
      var all = readAll();
      all[chatKey()] = restored;
      writeAll(all);
      readyTerminals[restored.terminalId] = true;
      reportLiveWorkspaces();
      scheduleRender();
      return restored;
    });
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
      'html.desktop-hide-terminal-menu [data-desktop-terminal-menu] {' +
      'position:absolute !important;width:1px;height:1px;overflow:hidden;' +
      'clip:rect(0 0 0 0);white-space:nowrap;}' +
      'html.desktop-hide-tool-count button[aria-label="Available Tools"]{display:none !important;}';
    (document.head || document.documentElement).appendChild(style);
  };

  var tidyOpenWebUIChrome = function () {
    ensureStyle();

    var counter = document.querySelector('button[aria-label="Available Tools"]');
    var shown = counter ? parseInt((counter.textContent || '').replace(/[^0-9]+/g, ''), 10) : 0;
    var onlyOurs = !counter || !(shown > opts.alwaysOnToolIds.length);
    document.documentElement.classList.toggle('desktop-hide-tool-count', onlyOurs);

    // If a tool of the user's own is active the panel stays reachable, so the
    // connector rows in it are hidden individually.
    if (!onlyOurs && opts.hiddenToolNames.length) {
      var labels = document.querySelectorAll('div, span');
      for (var i = 0; i < labels.length; i++) {
        var node = labels[i];
        if (node.dataset && node.dataset.desktopHidden) continue;
        if (node.children && node.children.length) continue;
        var text = (node.textContent || '').trim();
        if (opts.hiddenToolNames.indexOf(text) === -1) continue;
        var row = node.closest ? node.closest('button, [role="button"]') : null;
        if (!row) continue;
        node.dataset.desktopHidden = '1';
        row.style.display = 'none';
      }
    }
  };

  // ── Chip ────────────────────────────────────────────
  var chip = null;
  var chipIcon = null;
  var chipLabel = null;
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

  // ── Driving Open WebUI's own selection ──────────────
  //
  // Which folder a conversation works in lives in a store inside Open WebUI's
  // bundle, and the file browser and terminal panel read it. Nothing outside
  // the page can write it, so the chip operates Open WebUI's own terminal menu
  // instead — its click is the page's click, and everything follows.
  //
  // If that ever stops working, the menu is shown again rather than leaving a
  // chip that looks authoritative but selects nothing.
  var remoteControlBroken = false;

  var findTerminalMenuButton = function () {
    var buttons = document.querySelectorAll('button[type="button"]');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b === chip) continue;
      var cls = b.getAttribute('class') || '';
      if (cls.indexOf('translate-y-[1px]') === -1) continue;
      if (cls.indexOf('text-[13px]') === -1) continue;
      if (!b.querySelector('svg')) continue;
      return b;
    }
    return null;
  };

  var markTerminalMenu = function () {
    var button = findTerminalMenuButton();
    if (!button) return null;
    var host = button.parentElement;
    while (host && host.querySelectorAll('button').length < 2 && host.parentElement) {
      if (host.getAttribute('class') && host.contains(button)) break;
      host = host.parentElement;
    }
    (host || button).setAttribute('data-desktop-terminal-menu', '1');
    return button;
  };

  var setMenuHidden = function (hidden) {
    document.documentElement.classList.toggle('desktop-hide-terminal-menu', !!hidden);
  };

  var entryWithText = function (text, skip) {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (b === chip || b === skip) continue;
      if ((b.textContent || '').trim() === text) return b;
    }
    return null;
  };

  /**
   * Select \`wanted\` in Open WebUI's terminal menu, or clear the selection when
   * it is null. Reports whether the page ended up in the requested state.
   */
  var driveSelection = function (wanted, done) {
    // Our own panel carries entries with the same names, so it is closed first
    // — otherwise the search below could find one of those instead.
    closePanel();

    var button = markTerminalMenu();
    if (!button) { done(false); return; }

    var current = (button.textContent || '').trim();
    if (wanted && current === wanted) { done(true); return; }
    if (!wanted && !current) { done(true); return; }

    button.click();

    // The menu content is rendered by the page, so it may take a few frames to
    // appear. Poll rather than guess a delay.
    var attempts = 0;
    var tryPick = function () {
      // Clearing works by toggling off whatever is selected right now.
      var target = entryWithText(wanted || current, button);
      if (target) {
        target.click();
        setTimeout(function () {
          var now = (button.textContent || '').trim();
          done(wanted ? now === wanted : !now);
        }, 120);
        return;
      }
      if (++attempts > 20) {
        button.click(); // leave the menu as we found it
        done(false);
        return;
      }
      setTimeout(tryPick, 50);
    };
    setTimeout(tryPick, 50);
  };

  var applySelection = function (selected, done) {
    driveSelection(selected && selected.label ? selected.label : null, function (ok) {
      remoteControlBroken = !ok;
      setMenuHidden(!remoteControlBroken);
      scheduleRender();
      if (done) done(ok);
    });
  };

  var label = function () {
    var s = selection();
    if (!s) return t('Arbeitsbereich', 'Workspace');
    if (s.mode === 'cloud') return (s.repoFullName || '').split('/').pop() || 'cloud';
    return s.label || t('Lokal', 'Local');
  };

  var button = function (text, onClick, active, icon) {
    var b = document.createElement('button');
    b.type = 'button';
    if (icon) {
      var slot = document.createElement('span');
      slot.style.cssText = 'display:inline-flex;flex:0 0 auto;opacity:.65;';
      slot.innerHTML = icon;
      var caption = document.createElement('span');
      caption.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      caption.textContent = text;
      b.appendChild(slot);
      b.appendChild(caption);
    } else {
      b.textContent = text;
    }
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
    busy = true; note = t('Terminal wird gestartet …', 'Starting terminal …'); renderPanel();
    ask('workspaceOpenLocal', { path: path }).then(function (result) {
      busy = false;
      if (!result || !result.ok) {
        note = (result && result.error) || t('Start fehlgeschlagen.', 'Could not start.');
        renderPanel();
        return;
      }
      readyTerminals[result.terminal.id] = true;
      select({
        mode: 'local',
        path: path,
        terminalId: result.terminal.id,
        label: name || result.terminal.name
      });
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
      list.appendChild(button(t('Ordner öffnen …', 'Open a folder …'), function () {
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
              results.appendChild(button(r.fullName, function () {
                // Mounting the repository read-only gives the file panel
                // something to show; writing stays with the GitHub tools.
                busy = true; note = ''; renderPanel();
                ask('workspaceMountRepo', {
                  repoFullName: r.fullName,
                  branch: r.defaultBranch
                }).then(function (result) {
                  busy = false;
                  if (!result || !result.ok) {
                    note = (result && result.error) ||
                      t('Repository konnte nicht geöffnet werden.', 'Could not open the repository.');
                    renderPanel();
                    return;
                  }
                  select({
                    mode: 'cloud',
                    repoFullName: r.fullName,
                    branch: r.defaultBranch,
                    terminalId: result.terminal.id,
                    label: result.terminal.name
                  });
                });
              }, !!s && s.mode === 'cloud' && s.repoFullName === r.fullName, ICON_CLOUD));
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
  var ICON_CLOUD = svg('<path d="M7 18a4 4 0 0 1-.4-8 6 6 0 0 1 11.6 1.5A3.5 3.5 0 0 1 17.5 18z"/>');
  var ICON_EMPTY = svg('<path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke-dasharray="3 2"/>');

  // Writes only what actually differs. The observer below reacts to DOM
  // changes, so an unconditional write here would retrigger itself forever.
  var render = function () {
    // The chat id only appears after a pushState, which raises no event, so the
    // handover is checked whenever the page changes.
    var adopted = adoptDraft();
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
    markTerminalMenu();
    setMenuHidden(!remoteControlBroken);

    var s = selection();
    var icon = s && s.mode === 'cloud' ? ICON_CLOUD : s ? ICON_FOLDER : ICON_EMPTY;
    if (chipIcon.innerHTML !== icon) chipIcon.innerHTML = icon;
    var text = label();
    if (chipLabel.textContent !== text) chipLabel.textContent = text;
    var title = remoteControlBroken
      ? t(
          'Auswahl konnte nicht auf Open WebUI übertragen werden — benutze das Wolken-Menü daneben',
          'The selection could not be applied to Open WebUI — use the cloud menu next to this'
        )
      : s
        ? t('Arbeitsbereich dieses Chats ändern', 'Change this conversation’s workspace')
        : t('Arbeitsbereich für diesen Chat wählen', 'Choose a workspace for this conversation');
    if (chip.title !== title) chip.title = title;
    var opacity = s ? '0.85' : '0.5';
    if (chip.style.opacity !== opacity) chip.style.opacity = opacity;
    if (adopted) {
      // A route change rebuilds Open WebUI's composer state. Re-select the
      // handed-over terminal after the new composer has mounted.
      setTimeout(function () { applySelection(adopted); }, 0);
      reportLiveWorkspaces();
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
        var result = original.apply(window.history, arguments);
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
    window.addEventListener('popstate', scheduleRender);

    var observer = new MutationObserver(scheduleRender);
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleRender();
    // Release folders left open by conversations that no longer point at them.
    reportLiveWorkspaces();

    window[FLAG] = {
      configure: function (next) { opts = next; repos = null; scheduleRender(); }
    };
  } catch (e) {
    console.warn('[desktop] workspace chip disabled:', e);
    window[FLAG] = { configure: function () {} };
  }
})();
`
