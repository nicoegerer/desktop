# Managed Services fork notes

This fork adds a public, provider-neutral services and connectors layer to Open WebUI Desktop.
It does not ship personal service definitions, credentials, or provider accounts.

## Branch model

| Branch | Purpose |
| --- | --- |
| `main` | Fast-forward mirror of `open-webui/desktop:main`; no fork-only commits. |
| `managed-services` | Long-lived public feature branch. Official upstream changes are merged here. |
| `release` | Packaging branch with the fork update feed and monotonically increasing `services` versions. |

The daily `sync-upstream.yml` workflow checks both official Desktop commits and stable
`open-webui/open-webui` releases. It merges all feature and release changes into a candidate,
updates `src/shared/runtime-versions.json`, and increments the Services version from the
pre-merge release baseline. Tests, build and the runtime contract must pass before an atomic,
non-forced push updates all three branches. Conflicts stop publication without discarding changes.
The feature/default branch receives release fixes too, so its scheduled workflow stays current.

The workflow explicitly dispatches `release.yml`: a `GITHUB_TOKEN` push does not trigger
another push workflow. A no-change run checks for a published Windows update manifest and
can recover a missing release, without duplicating a running build. This is a tested integration
pipeline, not a promise of conflict-free upstream merges; failed CI runs require attention.

New installations use the release-tested runtime versions. With automatic updates enabled,
starting the server upgrades older Open WebUI installations to the version carried by the
desktop release. Explicit user pins, disabled updates, and newer/custom runtimes are preserved.
Runtime upgrades still require package-registry access; on failure the existing runtime starts
and the failure is logged. The runtime version remains visible in Open WebUI.

## Conversation workspaces

Workspace activation is versioned per conversation. A message waits for a pending manual
selection; a superseded activation/request cannot save its old selection into the current
chat. Draft handover never transfers the workspace of an existing conversation.

The guest bridge sets the selected terminal's per-chat cwd before dispatch. On a terminal
or conversation change it clears file-open requests and unmounts/remounts the native Files
panel, without reloading Open WebUI or resetting the chat. The injected instruction identifies
the current output root explicitly, even when earlier messages mention another directory.

`resources/open-terminal-workspace.py` launches the installed official Open Terminal CLI.
Its file-mutation guard rejects stale absolute output paths, traversal, and symlink escapes
outside that instance's workspace with a recoverable HTTP 409 error. Reads remain available.
This is an accidental-write safeguard, **not an OS sandbox**: shell commands still run with
the desktop user's permissions. No installed upstream package is patched. The resource is
unpacked beside the application's ASAR and retained across backend runtime upgrades.

Automatic connectors and workspace servers are omitted from the optional chat-tool picker
by their IDs, not disabled or deleted. Custom tools remain selectable. Completion requests
continue to include the default connectors, with the active filesystem first.

Release and upstream-sync gates check the published frontend stores, per-chat cwd API and
filesystem mutation signatures. Local verification can also exercise the real installed
Open Terminal using `python -B tests/test_workspace_write_guard.py --real`.

## Supported connector types

- **Local process** — any executable plus arguments, working directory, environment, optional
  localhost health check, restart policy, and bounded logs.
- **MCP → OpenAPI** — a local MCP stdio server wrapped with `mcpo`. The `uvx` runner is resolved
  from `PATH`, common Windows Python locations, or an explicit override.
- **Remote endpoint** — an existing HTTP(S) external tool server with an optional encrypted bearer
  token. Provider-specific OAuth still belongs in a provider adapter or backend.

New installations start with an empty registry. An existing enabled OmniRoute autostart setting is
migrated once for backward compatibility. Existing saved services remain local to the user.

## Upstream integration surface

The fork keeps changes outside upstream-owned code where practical:

- `src/main/services/` contains registry persistence, executable discovery, validation, health
  checks, process lifecycle, encrypted secrets, IPC, imports/exports, and log buffers.
- `src/shared/services/` contains versioned shared types.
- `src/preload/services.ts` exposes an allow-listed renderer API.
- `src/renderer/src/lib/components/Main/Settings/Services.svelte` is the connector hub.
- `src/renderer/src/lib/services/` contains bottom-status and log-panel components.

Small hooks remain in Electron startup, preload registration, Settings navigation, and the existing
bottom status bar. No Open WebUI database or Python backend migration is introduced.

## Security boundaries

Service imports require a command preview and explicit confirmation. Exported registries omit
environment values, generated mcpo keys, and remote access tokens. Secrets use Electron
`safeStorage` where available. Processes always launch without a shell, and only processes started
by the app are terminated by it.
