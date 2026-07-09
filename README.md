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
