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
endpoint, so the desktop registry writes every MCP and remote connector into Open WebUI's
`TOOL_SERVER_CONNECTIONS` whenever the registry changes and whenever a connection opens. mcpo
connectors are registered as **OpenAPI** servers pointing at `openapi.json`; remote endpoints are
registered as **MCP (Streamable HTTP)** servers with their bearer token.

Registered entries carry the id `desktop-<service-id>`. Connections added by hand in Open WebUI are
never touched, and a connector removed from the desktop registry is removed from Open WebUI on the
next sync. Disabling a connector clears its `enable` flag instead of deleting the entry, so bearer
keys and filters survive a restart.

Two conditions apply:

- The Open WebUI account must be an **admin**; tool-server configuration is an admin API. A
  non-admin session is reported in the desktop status toast and nothing is written.
- The sync waits for sign-in. If the app opens on the login screen, registration happens as soon as
  a session token exists.

Open WebUI still requires the tools to be picked per chat. Click the cloud icon in the message box
and select the connector.

## Work on local projects

The **Workspace** button in the bottom chat status bar is the shortest path from chat to an actual
project. It stays outside the Services & Connectors settings because it controls the current local
chat workspace rather than adding another connector:

1. Click **Choose workspace**. The picker has two tabs:
   - **Local** — recently used workspaces plus a folder browser. Nothing is selected on a fresh
     installation, and the active path remains visible after selection.
   - **GitHub** — repositories reachable with the token of the configured GitHub MCP connector. No
     second credential is requested. Selecting a repository clones it into the clone folder shown at
     the bottom of the picker, or fast-forwards an existing clone. A checkout with uncommitted
     changes is opened as-is instead of being pulled.
2. The desktop app starts or restarts Open Terminal in that exact folder and registers it only in
   the bundled local Open WebUI instance.
3. In an Open WebUI chat, click the cloud icon and select **Local Open Terminal**. A tool-capable
   model can then create and edit files, run commands, use Git, install project dependencies, and
   execute builds and tests.

The clone folder defaults to `~/OpenWebUI Workspaces` and can be overridden with `workspaces.root`
in the desktop config. Cloning requires `git` on `PATH`; the token is passed through the environment
so it never appears in process arguments.

If a response mentions only `/mnt/uploads`, the chat used Open WebUI's isolated code interpreter
instead of Local Open Terminal. Select **Local Open Terminal** from the cloud menu for host-folder
access. Open WebUI currently requires this tool selection per chat.

OmniRoute supplies models; it does not forward the local tools of a separate Codex or Claude Code
process. Open WebUI needs its own Open Terminal connection for agentic workspace access.

Open Terminal runs directly with the desktop user's permissions. The selected folder is the initial
working directory and file-browser root, not a security sandbox. Use a trusted model, keep backups,
and prefer an isolated Docker deployment when host-wide access is not required. The desktop API key
is removed from process arguments and logs and is encrypted with Electron `safeStorage` when the
operating system supports it.

## GitHub MCP preset

Choose **Add → GitHub MCP** for an optional template based on GitHub's official MCP server. The
template uses the official hosted endpoint at `https://api.githubcopilot.com/mcp/`, does not require
Docker, and does not contain an account or token. The user must enter a fine-grained Personal Access
Token with only the repository permissions needed for the intended tasks. The token is required for
this preset, not optional. It is encrypted locally and excluded from registry exports.

After saving, the connector is registered in the bundled Open WebUI automatically. A blue
**reachable** status in the desktop registry only confirms that the remote endpoint answered; tool
selection in a chat remains a separate step.

The same token backs the **GitHub** tab of the workspace picker, so one connection covers both API
access and repository checkouts.

GitHub MCP handles GitHub APIs such as repositories, issues, and pull requests. Open Terminal handles
the checked-out files, shell, Git CLI, builds, and tests on the local machine. Use both when a task
needs local implementation plus GitHub collaboration: pick the repository in the workspace picker to
get a working tree, and keep GitHub MCP selected for issues and pull requests.

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
