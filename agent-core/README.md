# agent-core

TypeScript sidecar for **omni-agent-desktop**. Runs the agent loop, providers,
local tools, A2A, scheduler, memory, settings, and secrets that used to live in
`src-tauri/src/`. Talks to the Tauri Rust shell over **stdio JSON-RPC** (one
JSON object per line: `\n`-delimited).

## Wire protocol

- **Requests** (Rust → sidecar): `{ "id": <number>, "method": "<dotted>", "params": <any> }`
- **Responses** (sidecar → Rust): `{ "id": <number>, "result": <any> }` or
  `{ "id": <number>, "error": { "code": <number>, "message": "<string>" } }`
- **Events** (sidecar → Rust, no `id`): `{ "event": "<dotted>", "data": <any> }`

Rust re-emits every event under the same name the frontend already listens for
(`agent://thought`, `scheduler://status`, etc.).

## Providers

Routed by `settings.active_provider`:

| Provider | SDK / transport |
|----------|-----------------|
| Anthropic | `@anthropic-ai/claude-agent-sdk` → `query()` |
| OpenAI | `@openai/codex-sdk` (tool-using turns fall back to Responses API until Codex SDK exposes tool callbacks) |
| Azure | HTTP → `/openai/v1/responses` |
| Copilot | OAuth device flow + HTTP inference |
| Custom | OpenAI-compat HTTP |

## Build

```
npm install
npm run build       # tsc -> dist/
npm run build:bin   # + pkg -> ../src-tauri/target/sidecar/agent-core-<triple>
```

The compiled binary is registered via Tauri's `externalBin` (see
`src-tauri/tauri.conf.json`) so the packaged app carries it without a system
Node install.
