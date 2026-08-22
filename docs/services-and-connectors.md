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
3. **Remote endpoint** for an existing HTTP(S) tool server. An optional bearer token is stored with
   the operating system's credential encryption when available.

Click a service in the bottom status bar to open its logs in the same resizable panel used by Open
WebUI, Open Terminal, and llama.cpp. Right-click a running local service to stop it.

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

## Sharing registry files

Exported JSON is suitable for templates and team sharing. It includes commands and endpoints, but
never environment values, generated mcpo bearer keys, or remote access tokens. Import always shows
the commands for confirmation before replacing the current registry.
