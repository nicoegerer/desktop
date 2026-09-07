# Isolated desktop UI smoke test

Run from the desktop repository:

    node tests/ui-smoke/launch.mjs

To compile without opening a window:

    node tests/ui-smoke/launch.mjs --build-only

The launcher builds the actual Services and WorkspacePreview Svelte components. Its
Electron window is titled **Open WebUI – UI Test**, uses a new temporary user-data
directory, synthetic connector state, and the real WorkspacePreviewManager with
the checked-in A/B fixtures. No real services, browser accounts, production profile
or chat database are opened. Connector actions only mutate in-memory test state;
external links and the real OAuth screen are deliberately not opened. A notice
confirms setup-navigation requests instead.

Manual checks: switch Entdecken/Deine, search Gmail, inspect OAuth prerequisites,
open/close setup dialogs, use keyboard dismissal, then open the website preview,
click its JavaScript counter, switch A/B in the same window, change mobile width,
reload, and test missing/non-HTML/traversal entry paths.

Build output stays in ignored `.out/`. Closing the test window stops its preview
server. Temporary browser profiles contain only test state and are not reused.
