# Sidecar architecture (TS agent-core)

The agent loop, providers, tools, A2A bridge, scheduler, memory, settings, and
secrets moved from Rust to a TypeScript **sidecar** shipped alongside the Tauri
binary. Rust keeps window, hotkey, tray, and the sidecar bridge.

The agent follows the operating principles from
[harness-guide.com](https://harness-guide.com/): plan-before-act, tool
discipline, verify-results, respect the RunMode gate, honest failure reporting.
See `buildSystemPrompt` in `agent-core/src/index.ts` for the exact prompt
injected on every run.

## Layout

```
agent-core/                  <- TypeScript sidecar
  src/
    index.ts                 <- JSON-RPC entrypoint (stdio, line-delimited)
    rpc.ts                   <- request/response + event server
    run.ts                   <- agent loop (run_once + gate + approvals)
    tools.ts                 <- local built-ins (read/write/edit/bash/…)
    a2a.ts                   <- agent-to-agent card + delegate
    scheduler.ts             <- persistent scheduled-run driver
    settings.ts              <- AppSettings model, load/save, atomic write
    secrets.ts               <- keytar-backed OS keyring
    memory.ts                <- MEMORY.md + daily logs
    approvals.ts             <- pending-approval registry
    paths.ts                 <- config dir resolution
    providers/
      router.ts              <- model-id -> route (claude-sdk / codex-sdk / http)
      types.ts               <- Provider, Msg, ParsedTurn, ToolCall
      anthropic-sdk.ts       <- @anthropic-ai/claude-agent-sdk
      codex-sdk.ts           <- @openai/codex-sdk
      chat-completions.ts    <- OpenAI-compat HTTP fallback
      azure.ts               <- Azure Foundry (/openai/v1/…, api-key header)
      copilot.ts             <- GitHub Copilot chat + short-lived token
      copilot-auth.ts        <- device-flow login
  build.mjs                  <- pkg -> ../src-tauri/binaries/agent-core-<triple>[.exe]

src-tauri/
  binaries/agent-core-<host-triple>[.exe]   <- registered as externalBin
  src/
    main.rs                  <- Tauri shell + hotkey + `sidecar_call` bridge
    sidecar.rs               <- spawn child, JSON-RPC client, event pump
```

## Provider routing

Decided by the **model id** on the active provider profile:

| Model id prefix | Route |
|-----------------|-------|
| `claude-*`      | `@anthropic-ai/claude-agent-sdk` `query()` |
| `gpt-*`, `codex-*`, `o<digit>*` | `@openai/codex-sdk` |
| everything else | OpenAI Chat Completions HTTP |

Provider-specific transports override the route:
- `active_provider = azure-foundry` -> `providers/azure.ts` regardless of model
  (Azure Foundry is an OpenAI Chat Completions endpoint with an `api-key`
  header and deployment remapping).
- `active_provider = github-copilot` -> `providers/copilot.ts` (short-lived
  token minted from the long-lived device-flow token).

## Wire protocol

Line-delimited JSON on stdio (`\n`-terminated). Rust <-> sidecar:

| Direction | Shape |
|-----------|-------|
| Request   | `{ "id": u64, "method": "dotted.name", "params": <any> }` |
| Response  | `{ "id": u64, "result": <any> }` or `{ "id": u64, "error": { code, message, data? } }` |
| Event     | `{ "event": "dotted.name", "data": <any> }` |

Events are re-emitted by the Rust bridge under their original names — the
frontend already listens on `agent://thought`, `agent://tool-call`,
`agent://tool-result`, `agent://tool-approval-request`, `agent://done`,
`agent://error`, `scheduler://status`.

## Frontend migration

Replace per-command Rust invocations with a single sidecar bridge call:

```ts
// Before
import { invoke } from "@tauri-apps/api/core";
await invoke("agent_run", { message, mode, history });

// After
import { call } from "./lib/sidecar";
await call("agent.run", { message, mode, history });
```

The legacy Rust commands still exist and still work — migration can happen
component-by-component. Once the frontend has fully migrated, delete
`src-tauri/src/agent/`, `memory.rs`, `scheduler.rs`, `secrets.rs`,
`settings.rs`, and the corresponding command bodies in `main.rs`. See phase 6
notes in the top-level plan.

## RPC methods

| Method | Legacy Rust command |
|--------|--------------------|
| `agent.run` | `agent_run` |
| `agent.approve` | `approve_tool` |
| `settings.get` / `settings.save` | `get_settings` / `save_settings_cmd` |
| `settings.set_hotkey` | `set_hotkey_cmd` |
| `memory.get` / `memory.save` | `get_memory` / `save_memory` |
| `copilot.status` / `copilot.start_device_flow` / `copilot.poll_device_flow` / `copilot.connect_with_token` / `copilot.disconnect` / `copilot.list_models` | `get_copilot_auth_status` / `start_copilot_device_flow` / (implicit) / `connect_copilot_with_token` / `disconnect_copilot` / `list_copilot_models` |
| `azure.test_connection` | `test_azure_connection` |
| `a2a.discover_card` | `a2a_discover_card` |
| `scheduler.list` / `.create` / `.update` / `.delete` / `.run_now` / `.cancel` | `list_scheduled` / `create_scheduled` / `update_scheduled` / `delete_scheduled` / `run_scheduled_now` / `cancel_scheduled` |

## Build

```
make sidecar   # cd agent-core && bun install && bun run build:bin
make build     # tauri build (depends on sidecar)
```

The sidecar is compiled with `bun build --compile` into a per-target
single-file binary registered via Tauri's `externalBin`. The dev-time fallback
in `src-tauri/src/sidecar.rs` runs `bun agent-core/src/index.ts` when the
packaged binary isn't present, so `npm run tauri dev` works after
`cd agent-core && bun install` (no separate `bun run build` needed for dev).

Secrets use Bun's built-in `Bun.secrets` API (OS Keychain / Credential Manager
/ libsecret) — no native module compile step. Under Node (dev fallback the
sidecar isn't compiled), it falls back to a chmod-600 plaintext file with a
warning to stderr.
