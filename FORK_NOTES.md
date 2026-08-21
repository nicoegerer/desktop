# Managed Services fork notes

This fork adds a public, provider-neutral services and connectors layer to Open WebUI Desktop.
It does not ship personal service definitions, credentials, or provider accounts.

## Branch model

| Branch | Purpose |
| --- | --- |
| `main` | Fast-forward mirror of `open-webui/desktop:main`; no fork-only commits. |
| `managed-services` | Long-lived public feature branch. Official upstream changes are merged here. |
| `release` | Packaging branch with the fork update feed and monotonically increasing `services` versions. |

The scheduled `sync-upstream.yml` workflow updates `main`, merges upstream into
`managed-services`, merges that result into `release`, increments the fork prerelease version,
and lets `release.yml` publish installers. Conflicts stop the workflow instead of discarding fork
or upstream changes.

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
