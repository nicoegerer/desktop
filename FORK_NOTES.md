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
