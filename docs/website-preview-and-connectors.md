# Website preview and connector setup

## Preview a generated website

Select the local workspace in the chat composer, then choose **Vorschau / Preview** next to it. The website appears beside the chat. The default entry is `index.html`; the HTML field also accepts a workspace-relative file such as `pages/dashboard.html`. **Neu laden** reloads the files after an edit; **Breit / Mobil** changes the viewport width.

Changing the workspace or conversation closes the old preview. No new chat is required to change workspaces. Cloud repository mounts are not local websites and cannot use this preview. Opening the preview hides Open WebUI's file/controls pane to leave room; it does not change the selected workspace.

The preview serves local HTML, CSS, JavaScript, images, fonts and media. It is not a development server: server-side apps, external APIs/CDNs, forms, workers and embedded external pages are deliberately blocked. Use local assets for an offline static website. The preview never receives terminal credentials or the Electron API.

### Security boundary

- A trusted desktop IPC call supplies a registered workspace terminal ID, never an arbitrary renderer path.
- Each preview receives a new loopback origin and a preview-only capability; old sessions are closed and their ports are not reused in the same manager lifetime.
- The iframe is an opaque `sandbox="allow-scripts"` frame. The main process adds the capability only to requests from its own renderer to the currently active preview origin, enabling CSS/modules without granting same-origin privileges.
- HTTP requests are read-only. Paths, hidden files, symlinks/junctions, Windows alternate data streams and file types are checked. Files outside the selected root are not served.
- CSP and the Electron subframe navigation guard block external network access and navigation into the authenticated app.

## Services and connectors

**Deine / Yours** lists desktop-managed connections, their state and the main action. **Entdecken / Discover** searches the catalog and opens provider-specific setup. Technical process settings, import/export and destructive actions remain available under advanced/details controls. Existing IDs, credentials and environment settings are preserved when editing.

A remote endpoint marked **Erreichbar / Reachable** is not necessarily authenticated. A network probe must not be presented as proof that account tools work.

GitHub can use the existing desktop token flow. Gmail, Google Drive and Google Calendar have official remote MCP endpoints, currently in **Developer Preview**. They require the documented Google Cloud project/API configuration and a user's own OAuth client. The gallery provides the endpoint, read-only scope suggestions and a handoff to Open WebUI's existing OAuth integration screen. Account consent is always performed by the user. No OAuth token or client secret is copied from another application.

OAuth connections configured in Open WebUI remain managed there, outside the desktop registry. The desktop synchronization preserves such manually configured entries. Do not add unauthenticated OAuth endpoints as always-on desktop services: discovery success is not authorization.

Official references (checked 2026-09-07):

- [Google Workspace MCP setup](https://developers.google.com/workspace/guides/configure-mcp-servers)
- [Google Developer Preview](https://developers.google.com/workspace/preview)
- [GitHub remote MCP](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- [Open WebUI native MCP and OAuth](https://docs.openwebui.com/features/extensibility/mcp/)

## Regression coverage

`npm run test:ipc` includes workspace/chip/store regressions, preview HTTP/path/lifecycle tests, IPC authorization tests and catalog/editor-preservation tests. The isolated Electron browser regression additionally checks real CSS/modules/fonts, opaque-origin restrictions, blocked navigation and workspace replacement. The UI smoke harness uses synthetic connections and an isolated profile, never the user's live service configuration.

### Verification on 2026-09-07

- Full regression suite: 155 tests passed; typecheck, Vite build and shipped-workspace checks passed.
- Real Chromium isolation test passed under Node 22.22.1; this test is now included in the Windows-x64 release gate.
- Computer Use in the visible isolated Electron window verified the connector catalog, Gmail setup guide, Escape dismissal without creating a connection, empty search results, actual HTML/CSS display, JavaScript clicks, mobile website width, switching A/B with the same `index.html` filename, missing-file error with the old frame removed, recovery and reload.
- The first UI harness build omitted utility classes from components outside its Vite root. An explicit Tailwind source fixes this test-only issue; the corrected display was verified again visually.
- Real Google account consent and authenticated Gmail operations were not tested: these require the user's own OAuth setup. No production accounts, chat database or service configuration were changed by these tests.
- Existing Vite accessibility warnings in unrelated legacy components remain; the new connector dialog and targeted new/changed modules have a clean lint check.

Repeat the manual test with `node tests/ui-smoke/launch.mjs`. Use `node --experimental-strip-types --test tests/workspace-preview.browser.mts` for the isolated browser regression.
