---
name: a2a-route-validate
description: Validate that omni-agent-desktop auto-routes model tool calls to the configured A2A hub/agent when a discovered skill matches. Use when changing provider request building (src-tauri/src/agent/provider.rs), A2A discovery/delegation (src-tauri/src/agent/a2a.rs), or the shared run loop (src-tauri/src/agent/mod.rs), OR when the user reports "A2A skill not being called", "hub not receiving requests", "model ignoring A2A tools", or wants to verify A2A dispatch end-to-end.
---

# A2A Auto-Routing Validation

Confirms the desktop app dispatches model-emitted tool calls to A2A hubs/agents when a discovered skill matches. Rooted in the regression where Anthropic-shape provider requests silently omitted `tools`, leaving the model unable to ever emit a `tool_use` for an A2A skill.

## Run now (one-shot)

Single command that runs every A2A-relevant test in this repo — static Anthropic-shape checks, unit tests, the in-crate E2E, and the shared-loop A2A gating tests. Test filters go after `--` so the runner accepts multiple substring matches:

```bash
cd src-tauri && cargo test --bin omni-agent-desktop -- \
  agent::a2a \
  agent::run_once_tests::ask_mode_requires_approval_for_a2a_in_both_origins \
  agent::run_once_tests::plan_mode_blocks_a2a_delegation_in_both_origins \
  agent::run_once_tests::ask_mode_denied_a2a_does_not_execute \
  provider::tests::anthropic_request_forwards_tools_in_native_shape \
  provider::tests::anthropic_request_omits_tools_key_when_none
```

Expect **14 passed, 0 failed**:
- 8 × `agent::a2a::tests::*` (card discovery, tool derivation, JSON-RPC)
- 1 × `agent::a2a_e2e_tests::model_tool_use_routes_to_a2a_hub_end_to_end`
- 3 × `agent::run_once_tests::*` A2A gating (approval, plan-mode block, denied)
- 2 × `provider::tests::anthropic_request_*` (native-shape forwarding)

If any fail, drop to the per-step sections below to isolate.

## When to run

- After editing `src-tauri/src/agent/provider.rs`, `agent/a2a.rs`, `agent/mod.rs`, or `agent/tools.rs`.
- After adding a new provider `ApiShape` or a new tool schema translator.
- When a user reports A2A skills not being called by the model.
- Before releasing a build that touches agent dispatch.

## Validation steps

Run every step. Stop at the first failure and fix before continuing.

### 1. Static: Anthropic request must carry tools in native shape

```bash
cd src-tauri && cargo test --bin omni-agent-desktop \
  provider::tests::anthropic_request_forwards_tools_in_native_shape \
  provider::tests::anthropic_request_omits_tools_key_when_none
```

Both must pass. Failure = the Anthropic arm of `build_request` is dropping tools again, or emitting the OpenAI `{function:{...}}` shape instead of `{name, description, input_schema}`.

### 2. Unit: A2A card discovery, tool derivation, JSON-RPC shape

```bash
cd src-tauri && cargo test --bin omni-agent-desktop agent::a2a::tests
```

All 8 must pass. Covers: namespaced tool names, 64-char provider limit, disabled-skill filtering, task-text extraction from status/history/artifacts, terminal-state detection, **and honoring the agent-card's declared RPC `url`/`endpoint` over the raw connection endpoint** (`card_url_overrides_connection_endpoint`).

### 3. E2E: model tool_use routes to a real mock hub

```bash
cd src-tauri && cargo test --bin omni-agent-desktop \
  agent::a2a_e2e_tests::model_tool_use_routes_to_a2a_hub_end_to_end
```

Spins a mock A2A hub on 127.0.0.1 that serves discovery at `/.well-known/agent-card.json` and RPC at a **subpath** (`/a2a`), advertised via the card's `url` field. The test asserts:
- Hub received `POST /a2a` with method `message/send` (proves subpath routing).
- Reply text is the hub-sourced answer (proves the delegate output flowed back).
- The A2A tool schema was passed to `infer` on turn 1 (proves wiring).

### 4. Full suite (no regressions)

```bash
cd src-tauri && cargo test --bin omni-agent-desktop
```

Expect all tests green. As of the last validation, that was 181 passing.

### 5. Runtime sanity (only when investigating a live report)

If a user reports A2A not being called against a real hub, additionally check:
- Their A2A connection has `enabled: true` in `settings.json`. `prepare_run` filters with `.filter(|c| c.enabled)` (`main.rs`), and `A2aConnection::enabled` defaults to `false` via `#[serde(default)]`. Hand-edited configs will silently skip discovery.
- The provider's active `api_shape`. Only the Anthropic arm previously omitted tools; if the user is on OpenAI/Copilot/Azure and A2A still doesn't fire, the break is elsewhere (typically the `enabled` filter above or hub discovery returning HTTP 404 / 401).

## Where the code lives

| Concern | File |
|---|---|
| Provider request shape (bug site) | `src-tauri/src/agent/provider.rs` — `build_request`, `to_anthropic_tools` |
| A2A discovery + delegation | `src-tauri/src/agent/a2a.rs` — `fetch_card`, `tools_from_card`, `a2a_tool_definition`, `delegate` |
| Shared run loop + routing gate | `src-tauri/src/agent/mod.rs` — `run_once` (`is_a2a` closure decides A2A vs local) |
| Tool set assembly | `src-tauri/src/main.rs` — `prepare_run` |
| E2E harness | `src-tauri/src/agent/a2a_e2e_tests.rs` |

## Adding coverage for a new provider shape

When adding a new `ApiShape`:
1. Add its arm in `provider::build_request` and include `tools` in whatever native shape the provider expects.
2. Add a `provider::tests::<shape>_request_forwards_tools_in_native_shape` regression test mirroring the Anthropic one.
3. Extend `a2a_e2e_tests` with a `build_request` cross-check for the new shape so the E2E covers wire-level tool forwarding for every shape.
