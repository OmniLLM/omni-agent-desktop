# Omni Agent Desktop

A standalone Tauri desktop shell for the Omni agent ecosystem.

This repo is the desktop/UI half extracted from OmniLauncher. It owns only local desktop concerns:

- global launcher hotkey
- window show/hide/resize/positioning
- local screenshot capture for vision flows
- frontend backend-token storage
- React/Vite UI

All agent business logic runs in backend agents over HTTP/A2A:

- OmniLauncher backend API: default `http://127.0.0.1:1422`
- OmniLauncher A2A agent endpoint: default `http://127.0.0.1:1423`
- Omni Agent Hub: default `http://127.0.0.1:8222`

## Architecture

```text
┌───────────────────────┐       HTTP API        ┌────────────────────────┐
│ Omni Agent Desktop    │ ────────────────────► │ OmniLauncher Backend   │
│ Tauri + React shell   │                       │ pure agent/tool server │
│ local window/hotkeys  │                       │ A2A upstream :1423     │
└───────────────────────┘                       └──────────┬─────────────┘
                                                             │ A2A upstream
                                                             ▼
                                                   ┌────────────────────┐
                                                   │ Omni Agent Hub      │
                                                   │ routing + upstreams │
                                                   └────────────────────┘
```

The desktop does not load plugins, run tools, or execute the agent loop locally. It invokes backend routes through `src/lib/runtime.ts` and receives backend events through SSE.

## Configure backend connection

Priority for backend URL:

1. `OMNI_AGENT_BACKEND_URL`
2. `OMNILAUNCHER_BACKEND_URL` (compatibility)
3. `backend_url` from `~/.config/omnilauncher/settings.json`
4. `http://127.0.0.1:1422`

Priority for backend token:

1. `OMNI_AGENT_BACKEND_TOKEN`
2. `OMNILAUNCHER_AUTH_TOKEN` (compatibility)
3. `~/.config/omni-agent-desktop/backend-token`
4. `~/.config/omnilauncher/server-token` (same-machine compatibility)

## Develop

```bash
make install
make check
make dev
```

Useful Make targets:

- `make build` — build the release desktop binary with embedded React/Vite assets
- `make verify-binary` — verify the binary exists and contains embedded frontend HTML
- `make package` — build platform installers/bundles with Tauri
- `make dev` — run the full Tauri dev app (Vite + desktop shell)
- `make dev-web` — run only the Vite frontend dev server

`make build` produces `src-tauri/target/release/omni-agent-desktop`. The frontend is embedded into the Tauri binary by `tauri-build`; no separate `dist/` directory is needed at runtime. On Linux it is still dynamically linked against system WebKitGTK/GTK libraries, which is normal for Tauri apps.

## Test

```bash
make test
make check
```
