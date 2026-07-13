---
name: copilot-live-e2e
description: Verify GitHub Copilot models route to the correct API endpoint (chat/completions vs responses) against the LIVE Copilot API. Use when changing Copilot provider request building (agent-core/src/providers/copilot.ts), the model→shape map (agent-core/src/providers/copilot-model-shapes.ts), or the responses parser (agent-core/src/providers/responses.ts), OR when the user reports Copilot errors like "unsupported_api_for_model", "not accessible via the /chat/completions endpoint", an HTTP 400 on a specific model, or wants to confirm claude/gpt/mai/gemini models all work through Copilot.
compatibility: Windows 11, Bun runtime (for Bun.secrets + Bun-native fetch), GitHub Copilot connected in the app (long-lived token in the OS credential store under service "omni-agent-desktop", name "github-copilot.token")
---

# Live GitHub Copilot E2E — endpoint routing

Copilot serves models on two request shapes:

- **OpenAI Chat Completions** — `POST /chat/completions`
- **OpenAI Responses** — `POST /responses`

Each model is served by one or both. Sending a model to the wrong endpoint
returns:

```
HTTP 400 { "error": { "code": "unsupported_api_for_model",
           "message": "model \"gpt-5.6-terra\" is not accessible via the
                       /chat/completions endpoint" } }
```

`copilotProvider().infer()` routes each model to the correct endpoint using the
model→shape map in `agent-core/src/providers/copilot-model-shapes.ts`
(exhaustive snapshot + a family fallback for models not yet in the snapshot).
This skill proves that routing works end-to-end against the **real** Copilot
API, using the token the app already stored — no re-auth, no mock.

## Run

From the repository root:

```bash
bun agent-core/e2e/copilot-live.mjs
```

Behind a corporate TLS-inspection proxy (self-signed cert in chain):

```bash
bun agent-core/e2e/copilot-live.mjs --insecure-tls
# equivalently: OMNI_AGENT_INSECURE_TLS=1 bun agent-core/e2e/copilot-live.mjs
```

Useful filters:

```bash
bun agent-core/e2e/copilot-live.mjs --model gpt-5.5          # force one model
bun agent-core/e2e/copilot-live.mjs --max-per-family 2 --json
```

Options: `--model <id>` (test a single catalog model), `--max-per-family <n>`
(representatives per (family, shape) bucket, default 1), `--insecure-tls`,
`--json`.

## What it checks

1. Reads the long-lived token from the OS secret store (service
   `omni-agent-desktop`, name `github-copilot.token`) — the same entry the
   device-flow login writes. The token is never printed or saved.
2. Calls `listCopilotModels()` for the live catalog.
3. Buckets every model by its routed shape and family, then picks one
   representative per `(family, shape)` bucket. gpt is intentionally split into
   its **chat** and **responses** variants — that split is the whole point of
   the routing fix.
4. Runs a real `infer()` per representative with a benign, deterministic prompt
   ("reply OK"), no tools. A wrong route would 400 and throw; a correct route
   returns non-empty text.

Coverage the user cares about: **claude** (chat), **gpt-chat** (e.g. gpt-4),
**gpt-responses** (e.g. gpt-5.5), **mai** (responses), **gemini** (chat).

## Read-only guarantee

The probe sends only a trivial "reply with OK" message with no tools and no
tool_choice. It performs no mutations and touches no user data. It does not
modify saved settings or the stored token.

## Verdict

Exit code: `0` all passed · `1` any failed · `2` no token / empty catalog.

A model PASSes when `infer()` returns non-empty text through its routed
endpoint. It FAILs on any thrown error (notably an
`unsupported_api_for_model` 400, which is the exact regression this guards) or
an empty response.

Example PASS output:

```
Copilot live E2E — endpoint routing
========================================================================
[PASS] claude  claude-opus-4.6              → /chat/completions  1824ms
[PASS] gemini  gemini-2.5-pro               → /chat/completions  5549ms
[PASS] gpt     gpt-4                        → /chat/completions  1270ms
[PASS] gpt     gpt-5.5                      → /responses         1245ms
[PASS] mai     mai-code-1-flash-picker      → /responses         1206ms
[PASS] other   trajectory-compaction        → /chat/completions  1394ms
========================================================================
6/6 passed
```

## Unit-level guard

For a fast check with no network or token, the pure routing map is unit-tested:

```bash
cd agent-core && bun test src/providers/copilot-model-shapes.test.ts
```

That asserts known models map to the right shape and that unknown `gpt-*` names
(like `gpt-5.6-terra`) fall back to `responses`. Run it in CI; run the live
harness locally when a Copilot token is available.

## When to run

- After editing `copilot.ts`, `copilot-model-shapes.ts`, or `responses.ts`.
- When a user reports an `unsupported_api_for_model` 400 or a specific Copilot
  model failing.
- Before shipping a Copilot-related change, to confirm all model families still
  route correctly against the live API.
