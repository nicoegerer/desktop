# Services and connectors

Open WebUI Desktop Services Edition keeps tool-server launchers and endpoints in a local registry.
Nothing is connected by default, so the same build is safe to distribute publicly.

## Add a connector

Open **Settings → Services & Connectors → Add** and choose one of these adapters:

1. **MCP → OpenAPI** for a local MCP stdio executable. Enter the MCP executable, one argument per
   line, and a free local port. The app launches `uvx --refresh --with mcp==1.9.4 mcpo ...` and
   generates a per-service bearer key. You can also provide an existing key; it is encrypted with
   the operating system credential store when available.
2. **Local process** for any long-running command. A health-check URL is optional and restricted to
   localhost.
3. **Remote MCP** for an existing Streamable HTTP MCP server. An optional bearer token is stored
   with the operating system's credential encryption when available.

Click a service in the bottom status bar to open its logs in the same resizable panel used by Open
WebUI, Open Terminal, and llama.cpp. Right-click a running local service to stop it.

## Chat access to a connector

Starting a connector only launches the process. The bundled Open WebUI also has to know the
endpoint, so the main process writes every MCP and remote connector into Open WebUI's
`TOOL_SERVER_CONNECTIONS` through its admin API. mcpo connectors are registered as **OpenAPI**
servers pointing at `openapi.json`; remote endpoints are registered as **MCP (Streamable HTTP)**
servers with their bearer token.

Registration is retried with backoff while the server is still booting or nobody is signed in yet,
and it repeats whenever the registry changes. Registered entries carry the id `desktop-<service-id>`.
Connections added by hand in Open WebUI are never touched, and a connector removed from the desktop
registry is removed from Open WebUI on the next sync. Disabling a connector clears its `enable` flag
instead of deleting the entry, so bearer keys and filters survive a restart.

The Open WebUI account must be an **admin**; tool-server configuration is an admin API. A non-admin
session is reported in the desktop status toast and nothing is written.

### Always active, not in the tools menu

Open WebUI selects tools per conversation, so a registered connector would still start every chat
switched off. Two things prevent that:

- The connector tool ids are added to the signed-in user's default tool selection
  (`settings.ui.tools`), which is what a chat falls back to when its model carries no tool list.
- Every request to `/api/chat/completions` is rewritten in the page so it carries those ids, whether
  or not anything is selected. See [Workspaces](#workspaces) for how that rewriting works.

Because the connectors are always active, their rows are hidden from the chat's tools menu. The rows
carry no identifying attribute, so they are matched by the connector name the desktop registered them
under; if Open WebUI changes that markup the rows simply reappear and the connectors keep working.

## Workspaces

A workspace is chosen **per conversation**, from a chip next to the message box. The desktop status
bar carries no workspace control.

Open WebUI owns the chat interface, so the chip is added to the page from the outside: after the
embedded page loads, the desktop injects a script into it. That script does two things.

- It patches `fetch` for `/api/chat/completions`. The workspace picked for that conversation, and the
  connector tool ids, are written into the request body. The body is a far more stable contract than
  the page's markup, so the behaviour does not depend on any DOM detail and cannot be undone by
  Open WebUI's own menus.
- It renders the chip and hides the connector rows. Both are cosmetic: if an anchor is not found, the
  chat is left exactly as it was.

The selection is stored per chat id in the page's `localStorage`, so different conversations can work
in different places at the same time. A conversation that has not been saved yet shares a `draft`
slot and keeps its workspace once it gets an id.

### Local

Pick **Lokal → Ordner öffnen …** for a native folder dialog; any folder on the machine works, it does
not have to be below a particular root. The desktop starts an Open Terminal instance for it, registers
it as a terminal server named after the folder with a stable id of `desktop-ws-<hash>`, and the chip
stores that id for the conversation. The same instance is registered as a hidden OpenAPI tool server.
Every request from that chat carries both `terminal_id` and the matching workspace tool id, so a
tool-capable model can create and edit files, run commands, use Git, install dependencies, and execute
builds and tests there even when Open WebUI omits its special terminal tools for that model.

Several active folders can be open at once — one terminal each. Reopening a conversation restores
its selection and starts its workspace on demand.

### Cloud

Pick **Cloud** for a list of the repositories the GitHub connector's token can reach. Selecting one
makes it the workspace for that conversation **without a checkout**: nothing is cloned.

The mount provides list/read/write file tools scoped to that repository and branch, plus the
terminal-shaped browsing API used by Open WebUI's Files panel. Each chat request selects this
toolset ahead of large connector catalogs, so its file tools survive provider tool-count limits.
The terminal ID selects the file pane, not a shell: cloud mounts cannot execute local commands.

Saving a text file (up to 1 MB UTF-8) creates a GitHub commit in the selected branch. The tool
reads the current blob revision, serializes writes on the branch and verifies the committed bytes
before reporting success. It invalidates the file-list cache after writes. The connector's token
needs **Contents: read and write** for that repository; branch protections remain in effect.
No local copy is created, no force push is used, and permission/conflict errors are shown explicitly.

Switching workspace mid-conversation replaces that instruction rather than stacking a second one,
and switching back to a local folder removes it.

### Lifetime

A workspace is started when a conversation asks for one, never on launch. Open Terminal runs with
the folder as its working directory, so a folder left open would keep a handle on it and could not be
deleted or moved. The chat retains the current/pending workspace, recently submitted requests and
active background answers. Inactive historical selections remain saved, but do not keep a process
or repository mount registered forever. Unknown activity states are retained conservatively.

The desktop additionally checks for running commands and live PTYs before stopping a process.
An explicitly configured startup Open Terminal service is protected. Reopening a saved selection
restarts the workspace, waiting for any shutdown already in progress.

Desktop-managed terminal/tool entries are hidden in Open WebUI's duplicate integration controls;
use **Services & Connectors** to manage them. Needed connectors such as Garmin remain available
to every chat. User-owned entries, including id-less local servers, are preserved.

A workspace picked before the first message is carried over when the conversation gets its id, so it
is not lost the moment it is used.

## GitHub MCP preset

Choose **Add → GitHub MCP** for an optional template based on GitHub's official MCP server. The
template uses the official hosted endpoint at `https://api.githubcopilot.com/mcp/`, does not require
Docker, and does not contain an account or token. The user must enter a fine-grained Personal Access
Token with only the repository permissions needed for the intended tasks. The token is required for
this preset, not optional. It is encrypted locally and excluded from registry exports.

After saving, the connector is registered in the bundled Open WebUI automatically and becomes part
of the default tool selection, so a chat can use it straight away. A blue **reachable** status in the
desktop registry only confirms that the remote endpoint answered.

The same token backs the **Cloud** mode of the workspace picker, so one connection covers repository
APIs and cloud workspaces alike.

GitHub MCP handles the GitHub side — repositories, issues, pull requests, and commits without a
checkout. A local workspace handles files, shell, Git CLI, builds, and tests on this machine. Pick
cloud mode for changes that can be committed directly, and a local workspace when the task needs a
working tree, a build, or a test run.

## Windows and `uvx`

Use `uvx` as the runner unless a specific installation must be selected. At launch the app checks:

- every directory in `PATH`;
- `%USERPROFILE%\.local\bin`;
- the WinGet links directory; and
- installed Python `Scripts` directories below `%LOCALAPPDATA%\Programs\Python`.

An absolute runner path remains available as an override. Commands are launched directly with
`shell: false`.

## mcpo authentication

After saving an MCP connector, the connection dialog shows the URL and its bearer key. In Open
WebUI, select **Bearer** authentication and paste only the key value, without adding the `Bearer `
prefix. Replace an older stored key completely; a mismatched key is rejected by mcpo with
`403 Invalid API key`.

A managed MCP connector never adopts an unrelated process that is already listening on its port,
because the app cannot safely verify that process's key. Stop a manually started mcpo instance or
choose another port. To keep using an externally managed instance, add it as a **Remote endpoint**
with its existing bearer token instead.

## Provider integrations

GitHub, Gmail, Google Calendar, Garmin, and similar products need an MCP/tool-server implementation
or a hosted adapter. The desktop registry manages that adapter; it does not claim to implement each
provider's OAuth flow. This separation lets providers be added without hardcoding personal accounts
or credentials into the public application.

The GitHub item is a selectable template, not a configured default. Garmin MCP and OmniRoute are
also never created on a fresh installation. Only an explicitly enabled legacy OmniRoute preference
is migrated for an existing user.

## Sharing registry files

Exported JSON is suitable for templates and team sharing. It includes commands and endpoints, but
never environment values, generated mcpo bearer keys, or remote access tokens. Import always shows
the commands for confirmation before replacing the current registry.
