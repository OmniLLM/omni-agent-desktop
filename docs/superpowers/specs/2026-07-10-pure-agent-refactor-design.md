# Pure Agent Refactor Design

**Date:** 2026-07-10
**Status:** Approved
**Scope:** Refactor Omni Agent Desktop from an OmniLauncher-derived launcher into a focused desktop AI agent: a chat UI invoked by a global hotkey, a settings page for LLM providers and A2A agents, a native Rust agent loop, and a small set of local tools with Claude-Code-style run modes.

## Summary

Omni Agent Desktop becomes "just an agent with a desktop UI." The OmniLauncher heritage (fuzzy search, favorites, plugin manager, skill manager, cheat sheet, multi-session picker, launcher result modes) is deleted. What remains is a thin React chat shell over a native Rust agent core.

The Rust core owns the full agent loop: provider requests (from the existing multi-provider design), a limited local tool registry, an A2A tool bridge, and run-mode gating. React renders one persisted conversation, a composer with a run-mode selector, inline tool-approval prompts, and a two-tab settings page.

This refactor removes all dependence on the legacy OmniLauncher HTTP backend. The app runs standalone in pure Tauri mode.

## Goals

- Invoke the agent with the global hotkey `Ctrl+Shift+O` (existing, unchanged).
- Present a single chat/agent UI; no launcher, search, favorites, plugin, or skill surfaces.
- Settings page with two tabs: LLM Providers (existing multi-provider config) and A2A Agents.
- Run the agent loop natively in Rust with no HTTP backend dependency.
- Ship seven local tools: `read`, `write`, `edit`, `ls`, `glob`, `grep`, `bash`.
- Expose enabled A2A agent skills as auto-routed tools discovered from agent cards.
- Provide three run modes (Plan / Ask / Autopilot) selectable in the UI.
- Persist a single ongoing conversation across restarts.
- Keep theme toggle, window resize/geometry memory, and screenshot/vision capture.

## Non-Goals

- Multi-session management or a session picker (single ongoing conversation only).
- Fuzzy launcher search, favorites, plugin manager, skill manager, cheat sheet.
- OmniLauncher HTTP backend as a runtime dependency (compatibility bridge is removed for the agent loop).
- Expanding the local tool set beyond the seven listed.
- Multiple accounts per provider (unchanged from multi-provider spec).
- OS credential-store integration (future hardening).
- Server-side A2A/hub administration knobs.

## Architecture

```text
┌─────────────────────────────────────────────┐
│ React thin shell (webview)                   │
│  ChatPane · Composer(mode selector) ·        │
│  ToolApprovalPrompt · SettingsWindow         │
└───────────────┬─────────────────────────────┘
                │ invoke() / listen()
┌───────────────▼─────────────────────────────┐
│ Rust agent core (src-tauri)                  │
│  agent.rs   → loop + run-mode gating         │
│  providers/ → provider client (multi-prov)   │
│  tools/     → read/write/edit/ls/glob/grep/  │
│               bash local tool registry       │
│  a2a.rs     → agent-card discovery + A2A     │
│               skills exposed as tools        │
│  settings.rs→ providers, A2A, shared prefs   │
└───────────────┬─────────────────────────────┘
        ┌───────┴────────┐
        │                │
   LLM provider API   A2A JSON-RPC
                      ├─ direct A2A agent
                      └─ omni-agent-hub
```

### React thin shell

React owns presentation and light interaction state only:

- `App.tsx` — reduced to chat + settings orchestration; all launcher wiring removed.
- `ChatPane` — renders the single conversation (reuses `ChatBubble`, `AIResponsePane`, `AiChatHistory`).
- `Composer` — input box plus a run-mode selector (Plan / Ask / Autopilot).
- `ToolApprovalPrompt` — inline approve / deny / allow-for-session controls shown when the core requests approval.
- `SettingsWindow` — two tabs: Providers (kept) and A2A Agents (add/remove endpoint, token, discover card, enable/disable skills).
- Kept affordances: theme toggle, window resize/geometry memory, screenshot/vision capture.

React must not run the agent loop, execute tools, make authenticated provider requests, or hold raw provider/A2A tokens.

### Rust agent core

New/extended modules under `src-tauri/src/`:

- `agent.rs` — the loop: assemble request, call provider, dispatch tool calls, gate by run mode, feed results back, repeat until no tool calls, cancel, or iteration cap. Emits streaming events.
- `providers/` — provider client from the multi-provider configuration design (Custom / GitHub Copilot / Azure Foundry), including request construction and response parsing by API shape.
- `tools/` — local tool registry implementing `read`, `write`, `edit`, `ls`, `glob`, `grep`, `bash`. Each tool declares a JSON-schema tool definition and a native executor. Behavior adapts the corresponding omnicode tools.
- `a2a.rs` — native A2A: agent-card discovery, skill enumeration, and JSON-RPC delegation. Moved out of the frontend `fetch` client. Enabled skills are surfaced to the loop as callable tools.
- `settings.rs` — extended to store A2A connections/enabled-skills alongside existing provider and shared settings.

## Deletions

Frontend files/hooks to remove (with their tests):

- Hooks: `useSearch`, `useFavorites`, `useAiSessions`, `useInputHistory`, `useSubmitAndExecute` (launcher execute path), and the launcher parts of `useGlobalKeyboard` / `useLayoutGeometry`.
- Components: `SearchBar`, `LauncherResults`, `ResultList`, `FavoritesList`, `PluginManager`, `SkillManager`, `CheatSheetModal`, `SessionPicker`, `QueuedPromptBubble` (if queueing is dropped), launcher body result modes.
- Config: `launcherConfig.ts`, `features/launcher/*`.
- Compact/expanded launcher layout branching (retain a single agent window layout with resize).

The multi-session model in `useAiSessions` is replaced by single-conversation persistence.

## Local Tools

Seven tools, native in Rust, adapting omnicode semantics:

| Tool | Purpose | Mutating |
|---|---|---|
| `read` | Read a file (path, optional offset/limit) | No |
| `ls` | List a directory | No |
| `glob` | Match files by glob pattern | No |
| `grep` | Search file contents (regex) | No |
| `write` | Create/overwrite a file | Yes |
| `edit` | String-replace edit in an existing file | Yes |
| `bash` | Run a shell command | Yes |

Each tool exposes a stable JSON-schema definition sent to the provider as a tool, and a native executor returning a normalized result or error. Tool errors are returned to the model as tool results, not surfaced as fatal loop errors.

## A2A Tools

- A2A connections are configured in the A2A settings tab: endpoint, optional token, enable/disable, per-skill enable/disable. Supports direct agents and the `omni-agent-hub` composite endpoint.
- On load (and on discovery refresh), `a2a.rs` fetches each enabled connection's agent card and enumerates skills.
- Each enabled skill becomes an auto-routed tool the model can call by name (e.g. a namespaced `<agent>__<skill>` tool). The tool definition is derived from the agent card's skill metadata.
- When the model calls an A2A tool, the loop delegates via JSON-RPC (native), waits for the task result, extracts text/structured output, and returns it as the tool result.
- A2A delegation runs in the Rust loop; the frontend `a2aClient.ts` `fetch` path is removed.
- A2A tools are treated as non-local; run-mode gating (below) applies the same approval rules as mutating local tools by default, since delegation can cause side effects. (Plan mode blocks A2A tool calls; Ask prompts; Autopilot auto-runs.)

## Run Modes

A mode selector in the composer, defaulting to **Ask**, modeled on Claude Code / Codex:

| Mode | Read-only tools | Mutating + A2A tools |
|---|---|---|
| **Plan** | Auto-run | Blocked; returned to model as "not permitted in plan mode" |
| **Ask** (default) | Auto-run | Emit approval request; wait for user decision; support allow-for-session |
| **Autopilot** | Auto-run | Auto-run |

- Read-only tools: `read`, `ls`, `glob`, `grep`.
- Mutating tools: `write`, `edit`, `bash`. A2A tools default to the mutating tier.
- Mode is chosen per message send and applies to all tool calls within that run.
- Ask-mode allow-list is per-session (per app run), keyed by tool name; cleared on restart.

## Native Command Surface

- `agent_run({ message: string, mode: "plan" | "ask" | "autopilot" })` — start a run.
- `agent_cancel()` — cancel the in-flight run.
- `approve_tool({ call_id: string, decision: "approve" | "deny" | "allow_session" })` — respond to an approval request.
- A2A: `a2a_list_connections`, `a2a_add_connection`, `a2a_remove_connection`, `a2a_discover_card(connection_id)`, `a2a_set_skill_enabled(...)`.
- Provider commands from the multi-provider design (`list_provider_models`, Copilot device-flow commands, etc.).
- Kept: `get_settings`, `save_settings_cmd`, `set_hotkey_cmd`, `frontend_log`, `save_window_position`, `set_window_geometry`, `set_window_size_centered`, `capture_vision_screenshot`.

The legacy `ai_query` / `ai_cancel` calls and `omnilauncher://ai-*` events are replaced by `agent_run` / `agent_cancel` and `agent://*` events.

## Events

- `agent://token` — streamed assistant text delta.
- `agent://tool-call` — `{ call_id, tool, args, iteration }` a tool is about to run (or awaiting approval).
- `agent://tool-approval-request` — `{ call_id, tool, args }` Ask mode needs a decision.
- `agent://tool-result` — `{ call_id, tool, ok, summary }`.
- `agent://done` — `{ conversation }` run finished.
- `agent://error` — `{ message }` normalized, secret-free.

## Persistence

- A single ongoing conversation is persisted to the local app data directory.
- On launch, the app reloads the saved conversation.
- A "new conversation" action clears and starts fresh (no multi-session list).
- Provider secrets and A2A tokens remain in existing local settings storage; redacted from logs and never returned to React.

## Error Handling and Diagnostics

- Provider errors normalized per the multi-provider design (auth, rate limit, unsupported model, network, malformed response, Copilot expiry).
- Tool execution errors return to the model as tool results; the loop continues.
- A2A delegation failures return an error tool result and are logged with redacted endpoint origin.
- Loop safeguards: max tool iterations (shared setting), cancellation, and loop detection remain.
- Logging redacts authorization/API-key/token headers; never logs secrets, device codes, or tokens.

## Testing Strategy

### Frontend (Vitest)

- `App` renders chat + settings only; no launcher surfaces mount.
- Composer mode selector changes the mode passed to `agent_run`.
- `ToolApprovalPrompt` shows on `agent://tool-approval-request` and sends the correct `approve_tool` decision.
- Settings: Providers tab (existing tests kept) and A2A tab (add/remove/discover/enable-skill).
- Conversation persistence: saved conversation reloads on mount.

### Rust unit tests

- Each local tool: happy path, error normalization, path handling.
- Run-mode gating matrix: read-only vs mutating vs A2A across Plan / Ask / Autopilot.
- Approval flow: request emitted, blocked until decision, allow_session persists within run.
- A2A: agent-card parsing, skill-to-tool derivation, delegation result extraction.
- Loop: tool-call dispatch, iteration cap, cancel, tool-error-continues.
- Provider request/response tests from the multi-provider design remain.

### Integration / E2E

- Drive the dev Tauri app: send a message in each mode; verify read-only auto-runs in Plan, mutating blocked in Plan, prompted in Ask, auto in Autopilot.
- Configure an A2A connection, discover its card, enable a skill, and confirm the model can call it.
- Restart and confirm the conversation and settings reload.

## Acceptance Criteria

- Launcher/search/favorites/plugin/skill/cheat-sheet/session-picker code is removed; the app builds and tests pass.
- The hotkey opens a chat-only agent UI.
- The agent loop runs natively in Rust with no HTTP backend dependency.
- All seven local tools work and are gated correctly by run mode.
- Enabled A2A skills appear as callable tools and delegate successfully.
- Plan / Ask / Autopilot behave as specified; Ask supports allow-for-session.
- A single conversation persists across restarts.
- Theme, window geometry, and screenshot/vision capture still work.
- Provider secrets and A2A tokens never reach React and never appear in logs.
```