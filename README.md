# Omni Agent Desktop

A standalone, thin Tauri desktop AI agent for the Omni agent ecosystem.

The product boundary is intentionally small: **Omni Agent Desktop is the local desktop shell + provider/model configuration + A2A client.** It should feel like OmniLauncher on the desktop, but its capabilities come from configured LLM providers and A2A agents rather than from a local plugin/tool runtime.

## Product Boundary

### Owned by Omni Agent Desktop

- Global launcher hotkey and show/hide behavior.
- Window show/hide/resize/positioning.
- React/Vite chat and launcher-style UI.
- Provider/model configuration similar to OmniPilot:
  - provider type
  - endpoint / base URL
  - API key or provider auth
  - API wire shape
  - active model and model discovery/manual model list
- A2A client configuration and discovery:
  - connect directly to one or more A2A agents
  - connect to `omni-agent-hub` as a composite A2A endpoint
  - discover agent cards and enabled skills/tools
  - route/delegate work to enabled A2A capabilities
- Local desktop affordances needed by an assistant UI, such as screenshot capture for vision flows and local frontend token storage.

### Not owned by Omni Agent Desktop

- Loading or executing OmniLauncher plugins locally.
- Running a full tool server or backend agent capability runtime inside the desktop process.
- Acting as the hub/router for other agents.
- Owning heavy agent business logic that can live in `omni-agent-hub`, an A2A upstream, or another backend agent.

If the desktop needs more capability, it should connect to `omni-agent-hub` or a direct A2A agent. The desktop itself remains a thin client.

## Architecture

```text
┌──────────────────────────┐
│ Omni Agent Desktop       │
│ Tauri + React shell      │
│ hotkey/window/screenshot │
│ provider + A2A client    │
└───────────┬──────────────┘
            │
            ├── LLM provider API
            │   GitHub Copilot / Azure Foundry / OpenAI-compatible / OmniLLM / Anthropic-compatible
            │
            └── A2A JSON-RPC client
                ├── direct A2A agent
                └── omni-agent-hub composite endpoint
                        ├── OmniLauncher backend agent/tools
                        ├── browser/OmniPilot-style agents
                        └── other local or remote A2A agents
```

The preferred runtime shape mirrors OmniPilot: the desktop agent owns provider selection and the agent loop, while A2A servers are exposed as callable tools/capabilities. `omni-agent-hub` is the normal way to aggregate many upstream agents; direct A2A endpoints are useful for simple or local setups.

During migration, compatibility with an OmniLauncher-style HTTP backend may remain useful, but it should be treated as a bridge, not the north-star architecture. New features should avoid adding more local plugin/backend responsibilities to the desktop app.

## Preserved Desktop UX

Keep the original OmniLauncher desktop affordances:

- Invoke with a global shortcut.
- Toggle/minimize the window from the shortcut.
- Preserve launcher-style compact and expanded layouts.
- Keep fast keyboard-first interaction.
- Keep local screenshot/vision capture flows.
- Keep preferences for hotkey, appearance, model/provider, and A2A endpoints.

## Configuration Direction

Provider/model settings should follow OmniPilot concepts so users do not learn a different mental model on desktop:

- Provider modes: Custom Provider, GitHub Copilot, Azure Foundry, and other compatible providers as needed.
- API shapes: OpenAI Chat Completions-compatible, Anthropic Messages-compatible, OpenAI Responses-compatible where supported.
- Model selection: fetch from `/models` when the provider supports it; otherwise allow manual model entry/list.
- A2A servers: add endpoint, optional token, discover agent card, enable/disable server and skills, allow `@AgentName`/explicit routing plus auto-routing.

Server-side A2A registration knobs belong to the upstream agent or hub configuration, not to the thin desktop client, unless explicitly presented as compatibility/admin tooling.

## Development

### Prerequisites

- **Node.js and npm** — for the React/Vite frontend and Tauri CLI.
- **Rust and Cargo** — for the Tauri desktop shell (`src-tauri`).
- **GNU Make** — to run the `make` targets below.
- **Tauri 2 platform prerequisites** — OS-specific system dependencies (e.g. WebKitGTK/GTK on Linux, build tools on macOS/Windows). Follow the official guide: https://v2.tauri.app/start/prerequisites/

### Develop

```bash
make install
make dev
```

- `make install` — install frontend dependencies with `npm ci`.
- `make dev` — run the full Tauri dev app (`npm run tauri dev`). This starts the Vite frontend dev server and the desktop shell together, with hot reload across the whole app: frontend (React/Vite) changes refresh instantly, and Rust (`src-tauri`) changes trigger a rebuild and relaunch of the desktop window.

### Release

```bash
make build
make start
```

- `make build` — build the release app with Tauri (`npm run tauri build`).
- `make start` — launch the built release app (`npm start`).

`make build` produces:

- Platform installers/bundles (`.deb`/`.AppImage`/`.dmg`/`.msi`, etc.) under `src-tauri/target/release/bundle/`.
- The standalone desktop executable under `src-tauri/target/release/`.

### Validation

```bash
make check
make test
```

- `make check` — type-check/build the frontend (`npm run build`) and run `cargo check` on the Tauri crate.
- `make test` — run the frontend tests (Vitest) and the Rust tests (`cargo test`).
- `make clean` — remove build artifacts (`dist/` plus `cargo clean`).
- `make help` — show the list of supported make targets.
