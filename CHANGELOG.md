# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.20-services.14] - 2026-08-24

### Added

- **A cloud workspace shows its files.** The selected repository is mounted read-only and registered
  as a terminal server, so Open WebUI's file panel lists its tree and opens files just as it does for
  a local folder — still without a checkout. The mount serves the browsing subset of Open Terminal's
  file API against the GitHub contents API; one loopback server hosts every repository under its own
  path prefix. Anything that would change the repository is refused, because writing belongs to the
  GitHub connector, which commits properly.

### Fixed

- **The workspace was forgotten the moment it was used.** A conversation has no id until its first
  message, so the choice was stored under a draft slot; when Open WebUI then navigated to the new
  conversation the chip looked under its id, found nothing, and fell back to "Arbeitsbereich". The
  draft is now handed over to the conversation that grew out of it.

## [0.0.20-services.13] - 2026-08-24

### Fixed

- **Every folder ever used stayed open and could not be deleted.** All previously active workspaces
  were reopened on launch, and Open Terminal runs with the folder as its working directory, so each
  one kept a handle on it — Windows then refuses to delete or move that folder. Workspaces are now
  started when a conversation asks for one, and the page reports which ones its conversations still
  point at so the rest are released.

### Notes

A connector that is active in every conversation also shapes what the model thinks it is. With no
workspace selected, the only tools in the request are the connectors — 135 Garmin operations and
GitHub MCP — and the model will describe itself as limited to Garmin, because for that request it
was. Selecting a workspace adds the file and shell tools; narrowing Garmin through
`function_name_filter_list` in Open WebUI's tool server settings keeps it available without letting
it dominate.

## [0.0.20-services.12] - 2026-08-24

### Fixed

- **Leaving a local workspace for a cloud one did not clear Open WebUI's selection.** Deselecting was
  given a fixed moment to find the menu entry, which the page often had not rendered yet, so the
  cloud menu reappeared next to the chip and the file browser kept showing the local folder. The
  entry is now polled for, and the chip's own panel is closed first so its identically named entries
  cannot be picked by mistake.
- **The folder emoji was still in the picker.** Only the chip had been converted; the entries in the
  panel now use the same line icons.

### Notes

A connector that is active in every conversation is also sent in every request. Garmin alone exposes
135 operations, about 49 KB of schema, which is why a short question already arrives at the model
with roughly 34,000 prompt tokens. A capable model handles that; a small one tends to answer in prose
instead of calling anything. The per-connector `function_name_filter_list` in Open WebUI's tool
server settings narrows the exposed functions and survives a sync.

## [0.0.20-services.11] - 2026-08-24

### Fixed

- **The chip and Open WebUI's cloud menu were two separate selections.** Which folder a conversation
  works in lives in a store inside Open WebUI's bundle, and the file browser and terminal panel read
  it — so the chip could rewrite the chat request but never move what the page displayed. The chip
  now operates Open WebUI's own terminal menu, making its click the page's click, and that menu is
  hidden so there is one control. If driving it ever fails the menu is shown again rather than
  leaving a chip that looks authoritative but selects nothing.
- **A connector whose port was still held could not start.** An mcpo instance orphaned by a crash or
  a forced quit kept the port, and startup refused because the key could not be verified. An mcpo
  that answers with this connector's own generated key can only be ours, so it is adopted instead.
  This is what left Garmin red.
- **The tools counter still advertised the connectors.** It is hidden while the only active tools are
  the desktop's own; adding a tool of your own brings it back, with the connector rows hidden
  individually.

### Changed

- **The chip uses line icons instead of an emoji.** A folder or cloud outline that takes the
  surrounding text colour, rather than a yellow glyph that did not belong in the row.

## [0.0.20-services.10] - 2026-08-24

### Fixed

- **The app never got past its loading spinner.** The workspace chip injected into the Open WebUI
  page patched `fetch` and forwarded its own receiver to the real one. Open WebUI's bundles are
  strict-mode modules, so a bare `fetch(...)` arrives with an undefined `this` and the browser
  rejects the call outright — every request in the page failed. The patch now always calls `fetch`
  bound to `window`.
- **Rendering could drive itself in a loop.** The chip's label was written on every pass, and
  assigning `textContent` replaces a text node, which the observer watching the page reports. Each
  render therefore scheduled the next one. Writes now happen only when the value differs, and the
  observer goes through a frame-debounced scheduler that skips rounds caused by the chip's own
  changes.
- **A failure in the chip can no longer take the chat with it.** Everything past the request
  rewriting is wrapped, so a problem there leaves the page exactly as Open WebUI built it.

## [0.0.20-services.9] - 2026-08-24

### Changed

- **The workspace is picked per conversation, in the chat.** A chip next to the message box offers
  **Lokal** and **Cloud**. Lokal opens a native folder dialog — any folder on the machine, not only
  ones already open or below a particular root — starts a terminal for it, and binds it to that
  conversation. Cloud lists the repositories the GitHub connector can reach and works on one without
  a checkout. Different conversations can work in different places at the same time.
- **The desktop status bar no longer carries a workspace control.** The button and the manager it
  opened are gone; the choice belongs to the chat.
- **The cloud workspace is scoped to a conversation.** It travels in the chat request instead of the
  account-wide system prompt, and the block written by the previous version is cleaned up on the next
  sync.

### Fixed

- **Garmin MCP and GitHub MCP are no longer listed as tools that must be switched on.** This was the
  known limitation of the previous release. Every chat request is rewritten in the page so it carries
  the connector tool ids whether or not anything is selected, which makes the rows redundant, so they
  are hidden from the tools menu.

### Notes

The workspace chip and the request rewriting are injected into the embedded Open WebUI page, because
Open WebUI owns the chat interface. The rewriting targets the request body of
`/api/chat/completions`, which is far more stable than the page's markup; the chip and the hidden
rows are cosmetic and fail silently if Open WebUI changes its layout, leaving the chat untouched.

## [0.0.20-services.8] - 2026-08-24

### Added

- **Cloud workspaces.** The workspace picker now distinguishes **Local** from **Cloud**. A cloud
  workspace is a GitHub repository and branch that is never checked out: the model reads and writes
  through the GitHub connector and commits straight to the selected branch. The choice is declared in
  a delimited block of the user's system prompt, so a prompt written by hand is preserved and leaving
  cloud mode removes the block again.

### Changed

- **Connectors are available without being switched on.** A registered connector still started every
  conversation switched off, which is why a chat reported having no Garmin data and no file access
  even though both connectors were running. Connectors are now written into the user's default tool
  selection, so a new chat can call them from the first message.
- **Workspace picker rebuilt around the two modes.** Local mode lists folders and opens one per
  terminal; cloud mode lists repositories and then their branches. The status bar shows the active
  workspace — `Local · desktop` or `Cloud · test1` — instead of a count of open workspaces.

### Known limitation

- Garmin MCP and GitHub MCP remain listed in the chat's tools menu and can still be switched off for
  a single conversation. Open WebUI renders that menu from every registered tool server, and the only
  way to remove an entry is to disable the connector, which would also stop the model from calling
  it.

## [0.0.20-services.7] - 2026-08-24

### Changed

- **One Open Terminal per workspace.** Open WebUI selects a terminal per conversation, so a single
  shared instance forced every chat into the same folder. Each open workspace now runs its own
  terminal and is registered under its folder name, which makes the working directory a per-chat
  choice made from the cloud icon rather than a global desktop setting. Open workspaces are restored
  on the next launch.
- **Workspace manager instead of a single picker.** The status-bar button opens a manager that shows
  which workspaces are open, opens or closes each one, and reports how many are active.
- **GitHub setup is reachable where it is needed.** The GitHub tab of the workspace manager offers
  **Connect GitHub**, which jumps straight to the connector setup instead of describing where to find
  it.

### Fixed

- **Connectors and workspaces never reached the chat.** Registration was pushed into the embedded
  page and silently did nothing whenever it ran before a webview existed — the normal case on
  startup — so `TOOL_SERVER_CONNECTIONS` stayed empty and Garmin MCP and GitHub MCP were invisible in
  every conversation. The main process now writes the configuration through Open WebUI's admin API
  and retries with backoff while the server is booting or nobody is signed in.
- **Empty cloud menu in the message box.** Workspaces were stored without an id, and Open WebUI hides
  system terminals whose id is empty, so the menu opened as a thin empty strip. Terminals are now
  registered with a stable id, and the id-less entries written by earlier versions are cleaned up.
- **Registrations were invisible until a restart.** Open WebUI reads its tool and terminal lists once
  while the page loads, so the embedded page is reloaded when a registration actually changed
  something.

## [0.0.20-services.6] - 2026-08-24

### Added

- **Connectors reach the chat automatically.** Every MCP and remote connector in the registry is now
  written into Open WebUI's tool-server configuration when it changes and when a connection opens.
  mcpo connectors register as OpenAPI servers, remote endpoints as MCP (Streamable HTTP) servers with
  their bearer token. Connections added by hand in Open WebUI are left untouched, and a connector
  removed from the registry is removed there as well. Registration requires an Open WebUI admin
  session and waits for sign-in.
- **GitHub repositories as workspaces.** The workspace picker has a GitHub tab that lists the
  repositories reachable with the configured GitHub MCP token, so one connection covers both API
  access and checkouts. Selecting a repository clones it into the workspace root or fast-forwards an
  existing clone, then points Open Terminal at it. A checkout with uncommitted changes is opened
  as-is instead of being pulled, and the token reaches `git` through the environment rather than
  process arguments.
- **Recent workspaces.** The picker keeps the last workspaces and marks the active one, so switching
  between a local project and a repository no longer means browsing the file system again.

### Fixed

- **Connectors started but stayed invisible to the chat.** Starting Garmin MCP or GitHub MCP only
  launched the process; Open WebUI's tool-server list stayed empty, so no chat could call them.
- **GitHub token was labelled optional but required.** The bearer field of the hosted GitHub MCP
  preset is now labelled as a required Personal Access Token, matching the validation that already
  rejected an empty value.

## [0.0.20-services.5] - 2026-08-23

### Fixed

- **Garmin MCP could not be saved.** Managed-service form values are now converted from Svelte state
  proxies before they cross Electron's `contextBridge`, fixing `An object could not be cloned.` for
  Garmin MCP and other nested service definitions.
- **mcpo key mismatches.** New MCP connectors always receive a cryptographically secure generated
  bearer key. The same encrypted key is used by the local mcpo process and the Open WebUI connection,
  preventing `403 – Invalid API key` caused by independently entered values.

## [0.0.20-services.4] - 2026-08-23

### Changed

- **Workspace control in chat.** The local coding workspace picker now lives in the persistent chat
  status bar. Its selected path remains visible, and changing folders restarts Open Terminal in the
  new working directory before synchronizing it with Open WebUI.
- **Hosted GitHub MCP preset.** The optional GitHub template now uses GitHub's official hosted MCP
  endpoint instead of requiring Docker. A user-supplied fine-grained token is still required and is
  encrypted locally. Remote endpoints use a blue “reachable” state so they are not confused with a
  locally running or already connected service.

### Fixed

- **Service editor could not save.** Svelte state proxies are converted to plain IPC values before
  Electron receives them, fixing `An object could not be cloned.` for Garmin MCP, GitHub MCP, and
  other connectors.
- **Misleading workspace state.** Reopening the app now shows the active folder in the chat status
  bar instead of presenting an empty picker while Open Terminal is still using an older directory.
- **Connection instructions.** The integration dialog now distinguishes Garmin-style mcpo/OpenAPI
  connectors from native Streamable HTTP MCP servers such as GitHub.

## [0.0.20-services.3] - 2026-08-23

### Added

- **Agentic Local Workspaces.** A guided Services card lets users choose a project folder, start Open
  Terminal there, and synchronize it with the bundled local Open WebUI so tool-capable models can
  edit files, use Git, and run builds and tests.
- **GitHub MCP Preset.** The Add menu now includes an optional template for GitHub's official Docker
  MCP server. It requires the user to supply a fine-grained token and never installs an account,
  credential, or enabled service by default.

### Fixed

- **Open Terminal Registration Race.** Autostart now registers Open Terminal in the local Open WebUI,
  and desktop events wait until the embedded client installs its authenticated event handler.
- **Stale Open Terminal API Keys.** Running instances can explicitly refresh their Open WebUI entry.
  Keys no longer appear in command-line arguments or logs and migrate to OS-backed encryption when
  available.

## [0.0.20-services.2] - 2026-08-22

### Fixed

- **MCP Connector Form Errors Hidden Behind the Dialog.** Validation and save failures now appear
  inside the service editor, so a rejected port or invalid field no longer looks like an inactive
  Save button.
- **mcpo `403 Invalid API key`.** MCP connectors accept an optional encrypted API key, show exact
  Bearer setup guidance after saving, and no longer adopt an unrelated process on the same port
  with an unverifiable key.

## [0.0.20-services.1] - 2026-08-21

This release turns the earlier OmniRoute-specific fork into a public, provider-neutral Services
Edition while preserving the existing in-app update feed.

### Added

- **Services & Connectors hub.** A dedicated settings area manages local processes, MCP-to-OpenAPI
  adapters, and existing remote HTTP(S) tool endpoints without shipping personal accounts.
- **Remote endpoint adapter.** External tool servers can be stored with an optional encrypted bearer
  token and copied into Open WebUI integration settings.
- **Integrated service console.** Clicking a managed service in the bottom status bar now opens the
  same resizable bottom log area used by Open WebUI, Open Terminal, and llama.cpp.

### Fixed

- **Windows `uvx` discovery.** mcpo launch no longer assumes `%USERPROFILE%\\.local\\bin\\uvx.exe`.
  The app resolves `uvx` from `PATH`, WinGet, and installed Python Scripts folders or accepts an
  explicit runner path. mcpo launches now include `--refresh`.

### Changed

- New installations start with an empty registry. Existing saved services remain local, and only an
  actually enabled legacy OmniRoute preference is migrated.
- The public branch model keeps `main` as an upstream mirror, carries the feature on
  `managed-services`, and republishes successful upstream merges from `release` with collision-safe
  `services` versions.

## [0.0.22-omniroute.1] - 2026-08-21

Fork prerelease based on the official Open WebUI Desktop v0.0.20 source. It supersedes the fixed OmniRoute autostart with an extensible local managed-services registry.

### Added

- **Generic managed background services.** Any local command can be configured, started without blocking app startup, monitored through a health endpoint, restarted with bounded exponential backoff, and stopped as a complete process tree on app quit.
- **First-class mcpo services.** Adding an MCP stdio server now requires only its executable, arguments, and port. The app derives the absolute `uvx`/mcpo command, generates an encrypted bearer key, and shows the Open WebUI external-tool URL and key with copy actions.
- **Dynamic settings and status display.** Services can be added, edited, enabled, started, stopped, removed, and inspected through a 500-line log buffer. The existing bottom status bar lists registry services dynamically and summarizes overflow as `+N`.
- **Safe registry transfer.** JSON import/export omits secret values, previews every imported command for confirmation, and regenerates mcpo bearer keys.

### Changed

- Existing OmniRoute autostart preferences migrate automatically into the versioned registry. A disabled Garmin MCP example is included without assuming user-specific activation.
- Service secrets and environment values use Electron `safeStorage`. Systems without OS encryption receive an explicit warning and a local file fallback that is kept out of config logging.
- Fork versioning advances to `0.0.22-omniroute.1`, avoiding a collision with the forthcoming official `v0.0.21` while remaining on the installed `omniroute` update channel.

## [0.0.21-omniroute.1] - 2026-08-20

Fork prerelease based on the official Open WebUI Desktop v0.0.20 source plus the optional OmniRoute integration.

### Added

- **Optional OmniRoute Autostart on Windows.** Open WebUI Desktop can start an existing global OmniRoute installation when the setting is enabled, avoid duplicate starts, and provide an OmniRoute tray icon with dashboard and stop controls.

### Fixed

- **OmniRoute Opens a Terminal Window.** OmniRoute is now launched without a detached Windows console, so enabling autostart no longer opens a persistent terminal tab.
- **OmniRoute Cannot Be Stopped.** Intentional `omniroute stop` requests no longer trigger the OmniRoute supervisor to restart the server.
- **OmniRoute Startup Can Crash Electron.** Readiness request errors such as `socket hang up` are handled without becoming uncaught exceptions in the Electron main process.
- **Missing OmniRoute Tray Icon after Slow Startup.** The tray icon is managed by Electron after the bounded readiness check instead of relying on OmniRoute's shorter internal tray timeout.

## [0.0.20] - 2026-05-07

### Fixed

- **Blank Webview on Linux.** Replaced the `--in-process-gpu` Chromium flag with SwiftShader software rendering (`--use-gl=angle --use-angle=swiftshader`). The in-process GPU flag broke `<webview>` guest compositing entirely, leaving connection views blank on all Linux configurations. SwiftShader keeps the GPU process out-of-process (required for webview compositing) while avoiding driver-level crashes (#178).

## [0.0.19] - 2026-05-06

### Fixed

- **Spotlight Pulls to First Desktop on macOS.** Spotlight no longer switches Spaces when triggered from a non-primary desktop. The window is now visible on all workspaces, and `app.focus({ steal: true })` — which activated the entire app and caused the Space switch — has been replaced with targeted window-level focus (#179).
- **Gray Screen When Connecting to Server on Linux.** Replaced the `--disable-gpu` Chromium flag with `--in-process-gpu`, which keeps the display compositor alive so `<webview>` guest surfaces actually paint instead of showing a gray rectangle. The previous flag fixed GPU process crashes but broke webview rendering on Debian and Ubuntu (#178).
- **Open Terminal Fails Silently Without Python.** Open Terminal now automatically installs Python when it's missing instead of throwing an opaque error. Progress status is surfaced in the UI during installation.
- **Corrupt Auto-Update Manifests.** Fixed the release workflow to deduplicate artifact entries during manifest merging, preventing SHA512 checksum mismatches that caused updates to fail silently.

## [0.0.18] - 2026-05-05

### Fixed

- **Downloaded Models Not Recognized by llama.cpp.** Models downloaded from Hugging Face are now stored directly under the `models/` directory instead of a nested `models/huggingface/` subdirectory, so llama-server's model scanner discovers them without manual symlinks. Existing models in the old location are automatically migrated on startup (#177).

## [0.0.17] - 2026-05-03

### Added

- **Webview Context Menu.** Right-clicking inside the webview now shows a native context menu with Cut, Copy, Paste, Undo/Redo, spell-check suggestions, and "Open Link in Browser" — enabling system autofill and password manager integration on login pages (#161).

### Changed

- **Windows OpenSSL Compatibility.** The bundled Python's directory is now prepended to `PATH` on Windows so its own OpenSSL DLLs are loaded before any conflicting system-wide installations (Git for Windows, Anaconda, Strawberry Perl, etc.), preventing the `OPENSSL_Uplink: no OPENSSL_Applink` crash on startup (#167).
- **Links Open in Default Browser on Windows.** Added `allowpopups` to the webview so that `target="_blank"` link clicks correctly propagate to the main process handler and open in the default browser instead of being silently blocked (#165, #170).
- **Linux System Requirements.** Documentation now specifies glibc 2.28+ as a minimum requirement for Linux installations.

## [0.0.16] - 2026-05-02

### Fixed

- **Links Open in Default Browser.** Clicking links in chat responses now opens them in the user's default browser instead of navigating within the app or spawning a new Electron window (#165).

## [0.0.15] - 2026-04-28

### Added

- **ARM64 Support for Linux and Windows.** Native ARM64 builds are now produced for Linux (.deb, AppImage) and Windows (NSIS installer), enabling support for Raspberry Pi, NVIDIA DGX Spark, Snapdragon laptops, and other ARM64 devices (#140).

### Fixed

- **Grey/Blank Screen on Linux.** Disabled GPU compositing entirely on Linux to prevent shared memory allocation crashes that caused a grey or blank screen on systems with restricted `/dev/shm` or `/tmp` permissions.
- **Spotlight Dismiss Behavior.** Pressing Escape or the toggle shortcut to dismiss Spotlight no longer erroneously brings the main application window to the foreground (#158).

## [0.0.14] - 2026-04-28

### Fixed

- **Grey/Blank Webview on Linux.** Disabled GPU compositing on Linux to prevent silent compositor failures that produce a grey rectangle instead of rendered content on systems with problematic Intel/NVIDIA drivers or certain Wayland compositors (#119).
- **Renderer Crash Recovery.** The main window now automatically reloads when the renderer process dies unexpectedly, preventing a permanent blank/grey screen.
- **Webview Crash Diagnostics.** Added logging for guest webview renderer crashes to aid debugging connectivity and rendering issues.
- **macOS Notarization.** Resolved Apple notarization failure caused by an expired Developer Program agreement, restoring signed and notarized macOS builds.

## [0.0.13] - 2026-04-27

### Fixed

- **Copy Button on Linux (GNOME/Wayland/Flatpak).** Fixed the "Copy" button in the Open WebUI interface not actually writing to the system clipboard on Linux. The webview session was missing the `clipboard-sanitized-write` permission required by Electron for `navigator.clipboard.writeText()` to work.

## [0.0.12] - 2026-04-25

### Added

- **Toggleable Clipboard Auto-Paste for Spotlight.** Spotlight's automatic clipboard pasting is now optional and can be toggled in Settings, so the input bar starts empty when preferred.
- **Persistent Window Size and Position.** The app now remembers your window dimensions, position, and maximized state across restarts, with safe fallback when a saved display is disconnected.

### Fixed

- **Linux .deb Crash.** Fixed app failing to launch on Linux with `Failed to load native module: pty.node` by enabling native module rebuilds and unpacking node-pty from the asar archive during packaging.
- **Grey Screen on Connection Failure.** The webview now shows an error overlay with retry and open-in-browser options instead of a blank grey screen when a connection fails to load or crashes.
- **Global Shortcuts on Wayland/Flatpak.** Global shortcuts now work on Wayland desktops via `xdg-desktop-portal`, with clear user-facing notifications when a shortcut cannot be registered.

## [0.0.11] - 2026-04-24

### Fixed

- **macOS Launch Crash.** Fixed app failing to launch with "different Team IDs" error by adding the missing `disable-library-validation` entitlement to the build signing configuration.
- **Self-Signed SSL Connections.** The app now trusts all SSL certificates, allowing connections to Open WebUI instances behind self-signed or untrusted certificates without errors.

## [0.0.10] - 2026-04-24

### Added

- **Concurrent Model Downloads.** Multiple Hugging Face models can now be downloaded simultaneously, each with independent progress tracking and per-file cancel buttons.

### Changed

- **Models Settings UI.** Cleaner layout with inline progress bars, hover-reveal download buttons, and breadcrumb-style repo navigation.

### Fixed

- **GPU Process Crash Recovery.** The app now automatically detects GPU process crashes (common with certain NVIDIA/Intel drivers on Windows) and relaunches with the GPU sandbox disabled, instead of closing immediately. No manual shortcut edits required.

## [0.0.9] - 2026-04-20

### Fixed

- **Open Terminal API Key Persistence.** The Open Terminal API key is now saved in config.json and reused across restarts instead of being regenerated on every startup, which was breaking existing integrations.

## [0.0.8] - 2026-04-11

### Added

- **Voice Input.** System-wide push-to-talk voice transcription. Press the shortcut from any app to record audio, which is automatically transcribed and sent to your active chat.
- **Voice Input Settings.** Configurable global hotkey and enable/disable toggle in Settings, with a default of Shift+Cmd+Space (macOS) or Shift+Ctrl+Space (Windows/Linux).
- **Audio Feedback.** Bundled start and stop chime sounds play when recording begins and ends.

### Fixed

- **Shortcut Recorder on macOS.** Shortcut inputs now use physical key codes instead of character values, fixing Alt key combinations producing unicode characters like √ instead of V.

## [0.0.7] - 2026-04-11

### Fixed

- **macOS Auto-Update.** Auto-update now works correctly on macOS. Previously, the updater tried to download a zip file with a versioned filename that did not exist in the release.

## [0.0.6] - 2026-04-10

### Added

- **Spotlight Screenshot Capture.** Drag anywhere on the Spotlight overlay to select a region of your screen. Screenshots appear as inline thumbnails and are sent alongside your message.
- **Multiple Screenshots.** Attach several screenshots in a single Spotlight query. Each one can be individually removed before sending.
- **Click-to-Dismiss Spotlight.** Clicking the background outside the input bar dismisses Spotlight, in addition to pressing Escape.
- **Screen Recording Permission Prompt (macOS).** If screen capture permission hasn't been granted, a notification guides you to the correct System Settings page.
- **Screenshot Hint.** A "Drag anywhere to capture a screenshot" hint appears when Spotlight opens.
- **Offline Mode for llama.cpp.** Previously downloaded llama.cpp binaries are automatically detected on startup, so local models work without an internet connection.
- **Auto-Connect on Startup.** The app pre-connects to your default connection when launched, so Spotlight queries work immediately.

### Changed

- **Fullscreen Spotlight Overlay.** Spotlight now opens as a fullscreen transparent overlay on your active display rather than a small floating window, enabling screenshot capture and multi-display support.
- **Faster Remote Connections.** Switching to a remote server is now instant with no loading delay.
- **Smarter Loading Indicator.** The loading spinner only appears when the local server is actually starting, instead of showing on every connection switch.
- **Clearer Sidebar Selection.** Active connections are more visually distinct with bolder text and stronger highlights. Inactive connections are subtler for better contrast.
- **Safer llama.cpp Updates.** The app verifies internet connectivity before removing the current installation, preventing accidental data loss when updating offline.

### Fixed

- **Tray Menu Connections.** Clicking a connection from the system tray menu now correctly opens it in the app.
- **Dark Mode Context Menus.** Sidebar right-click menus no longer appear incorrectly highlighted in dark mode.
- **Local Server Always Accessible.** The local connection in the sidebar is no longer grayed out when the server isn't running. Clicking it will start the server.
- **Open Terminal Install Errors.** If automatic installation of Open Terminal fails, you now see a clear error message instead of a silent failure.
- **Network Timeout Handling.** Requests for llama.cpp releases now time out after 10 seconds instead of hanging indefinitely on slow networks.

## [0.0.5] - 2026-04-07

### Added

- **Two-Way Theme Sync.** Theme changes in Open WebUI are now mirrored to the desktop app and vice versa, so your light/dark preference stays consistent everywhere.
- **Seamless Spotlight Queries.** Spotlight prompts now appear directly in your already-open chat without triggering a full page reload.

### Fixed

- **Auto-Default Connection.** Selecting a connection now automatically saves it as your default for Spotlight and app startup.
- **Smooth Connection Switching.** Switching between already-open connections no longer causes unnecessary page reloads.
- **Connection Switch Race Condition.** Clicking a remote connection while the local server is still starting no longer gets overridden when the local server finishes loading.

## [0.0.3] - 2026-04-06

### Fixed

- **Spotlight Focus.** Spotlight now reliably appears after interacting with the main window. Previously could fail to show on macOS.
- **Spotlight Search Passthrough.** Searches submitted from Spotlight now correctly load in already-open connections instead of being silently ignored.

## [0.0.2] - 2026-04-06

### Added

- **Spotlight Input Bar.** Lightweight quick-chat bar (⇧⌘I) for submitting queries without opening the full app.
- **Spotlight Shortcut.** Dedicated configurable shortcut for Spotlight, independent from the global app shortcut.
- **Draggable Spotlight.** Spotlight bar can be dragged to any position on screen.
- **Persistent Spotlight Position.** Spotlight position is saved and restored across app restarts.
- **Spotlight Settings.** Shortcut recorder in Settings → General for the Spotlight shortcut.

### Fixed

- **System Theme Sync.** The app now responds to OS dark/light mode changes in real-time when set to "Auto". Previously only checked once at startup.

## [0.0.1] - 2026-03-20

### Added

- **Local Server Management.** Install, start, stop, and restart Open WebUI directly from the desktop app.
- **Connection Manager.** Connect to multiple Open WebUI servers with sidebar quick-switch.
- **Status Bar.** Real-time status indicators for Open WebUI, Open Terminal, and llama.cpp services.
- **Log Viewer.** Live terminal log viewer for all services with copy, refresh, and resize.
- **Open Terminal Integration.** Built-in terminal server for AI-powered shell access.
- **llama.cpp Integration.** Local inference engine with model management and Hugging Face downloads.
- **Settings.** General, Open WebUI, Terminal, Inference, Models, Connections, and About panels.
- **Global Shortcut.** Configurable system-wide hotkey to bring the app to the foreground.
- **Auto-Update.** Built-in update checker with one-click download and install.
- **Tray Support.** System tray icon with quick actions and optional background mode.
- **Factory Reset.** One-click removal of all installed components, data, and connections.
- **Disk Space Check.** Pre-install check requiring at least 5 GB of free storage.
- **Internationalization.** English, Japanese, Chinese (Simplified & Traditional) translations.
- **In-App Changelog.** Accessible from the About settings page.
- **Cross-Platform.** macOS, Windows, and Linux support.
