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

Open WebUI selects tools per chat, so a registered connector would still start every conversation
switched off. The desktop therefore also writes its connectors into the signed-in user's default
tool selection (`settings.ui.tools`), which is what a new chat falls back to when the model carries
no tool list of its own. Garmin MCP and GitHub MCP are available from the first message without
touching the tools menu.

They remain listed in that menu and can still be switched off for a single conversation. Hiding
them entirely is not possible from the desktop app: the menu is rendered by Open WebUI from every
registered tool server, and the only way to remove an entry is to disable the connector, which would
also stop the model from calling it.

## Workspaces

The **Workspace** button in the bottom chat status bar chooses how the model works on a project. It
offers two modes.

### Local

A local folder gets its own Open Terminal instance. Because Open WebUI selects a terminal server per
conversation, several folders can be open at once and each chat picks its own: click the cloud icon
in the message box and select the workspace by name.

Every open workspace is registered as a terminal server named after its folder, with a stable id of
`desktop-ws-<hash>`. A tool-capable model can then create and edit files, run commands, use Git,
install dependencies, and execute builds and tests in that folder. Open workspaces are remembered
and reopened on the next launch.

### Cloud

A cloud workspace is a GitHub repository and branch that is **not** checked out. The model reads and
writes through the GitHub connector and commits straight to the selected branch, so nothing is
cloned and no terminal is started. Pick a repository, then its branch; the choice is declared in the
user's system prompt inside a delimited block, so anything written there by hand is preserved and
leaving cloud mode removes the block again.

Only one cloud workspace is active at a time, because Open WebUI offers no per-chat control for it —
unlike local workspaces, which map onto terminal servers.

Local clones created by earlier versions live under `~/OpenWebUI Workspaces`, overridable with
`workspaces.root` in the desktop config. Cloning requires `git` on `PATH`; the token is passed
through the environment so it never appears in process arguments.

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
