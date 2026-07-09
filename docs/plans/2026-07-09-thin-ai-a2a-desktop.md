# Thin AI/A2A Desktop Architecture Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make `omni-agent-desktop` a pure thin desktop AI agent with OmniPilot-style provider/model configuration and first-class A2A client support, while preserving OmniLauncher desktop UX.

**Architecture:** The desktop app owns local desktop affordances, UI, provider selection, and A2A client orchestration. Capabilities are extended through `omni-agent-hub` or direct A2A agents, not by running local plugin/tool backends inside the desktop process. Compatibility with the current OmniLauncher backend HTTP API can remain during migration, but new functionality should move toward direct provider + A2A-client semantics.

**Tech Stack:** Tauri v2, Rust desktop shell, React/Vite/TypeScript UI, OpenAI/Anthropic-compatible provider APIs, A2A JSON-RPC over HTTP.

---

## Design Invariants

1. **Desktop stays thin.** No local plugin loading, no local hub/router, no heavy backend agent runtime in the Tauri process.
2. **Provider config mirrors OmniPilot.** Provider type, endpoint, API key/auth, API shape, model list/manual models, active model.
3. **A2A is a client feature.** The app can connect to `omni-agent-hub` or direct A2A agents, discover cards/skills, and delegate work.
4. **OmniLauncher UX stays.** Hotkey summon, compact launcher feel, resize/position behavior, keyboard-first interaction, screenshot capture.
5. **Hub is the extension point.** If a user wants more tools/capabilities, add upstreams to `omni-agent-hub` or connect a direct A2A agent.
6. **Server-side A2A knobs do not belong in normal desktop settings.** Existing server registration controls should be moved behind a compatibility/admin section or removed once the direct client path lands.

---

## Task 1: Rename the current A2A settings surface from server/admin to client connections

**Objective:** Prevent the UI from implying that the desktop is primarily an A2A server or hub admin.

**Files:**
- Modify: `src/components/SettingsWindow.tsx`
- Modify: `src/types/app.ts`
- Test: `src/components/SettingsWindow.test.tsx`

**Step 1: Write/adjust tests**

Add assertions that the settings tabs and labels use client-facing language:

```ts
expect(screen.getByText("A2A Connections")).toBeInTheDocument();
expect(screen.getByText(/Connect to omni-agent-hub or direct A2A agents/i)).toBeInTheDocument();
```

Also assert that normal settings do not lead with `Enable A2A Server`.

**Step 2: Run focused test**

```bash
cd /data/tools/omni-agent-desktop
npm test -- src/components/SettingsWindow.test.tsx
```

Expected: fail until labels are changed.

**Step 3: Update UI copy**

Change the tab/section language:

- `A2A` tab can stay short.
- Section header should become `A2A Connections`.
- Description should say: `Connect to omni-agent-hub or direct A2A agents to extend desktop capabilities.`
- Any current `A2A Server` controls should move under an `Advanced / Compatibility` subsection if still needed for backend compatibility.

**Step 4: Re-run focused test**

```bash
cd /data/tools/omni-agent-desktop
npm test -- src/components/SettingsWindow.test.tsx
```

Expected: pass.

---

## Task 2: Introduce OmniPilot-style provider config shape

**Objective:** Make desktop provider settings capable of matching OmniPilot instead of only raw `ai_base_url` + `ai_api_key` + `ai_model`.

**Files:**
- Modify: `src/types/app.ts`
- Modify: `src/components/SettingsWindow.tsx`
- Modify backend API compatibility only if needed through HTTP `/api/settings`
- Test: `src/components/SettingsWindow.test.tsx`

**Step 1: Add typed fields with backward compatibility**

Add fields such as:

```ts
export type ProviderType = "custom-provider" | "github-copilot" | "azure-foundry";
export type ApiShape = "openai-compatible" | "anthropic-messages" | "openai-responses";
```

Extend `AppSettings` with:

```ts
provider_type: ProviderType;
api_shape: ApiShape;
manual_models: string;
```

Keep `ai_base_url`, `ai_api_key`, and `ai_model` during migration so existing backend settings load safely.

**Step 2: Write UI tests**

Assert Preferences → AI exposes:

- Provider selector
- API shape selector for custom/compatible providers
- Model selector/manual entry

**Step 3: Implement minimal UI**

Add a provider dropdown in the AI tab:

- Custom Provider
- GitHub Copilot
- Azure Foundry

Show endpoint/API-key fields only when relevant. GitHub Copilot auth can start as a placeholder/status row if native device-flow support is not implemented yet.

**Step 4: Run tests**

```bash
cd /data/tools/omni-agent-desktop
npm test -- src/components/SettingsWindow.test.tsx
npm test -- src/lib/runtime.test.ts
```

Expected: pass.

---

## Task 3: Add an A2A client settings model

**Objective:** Represent one or more A2A endpoints as client connections, matching OmniPilot's mental model.

**Files:**
- Modify: `src/types/app.ts`
- Modify: `src/components/SettingsWindow.tsx`
- Test: `src/components/SettingsWindow.test.tsx`

**Step 1: Add types**

```ts
export interface A2aClientServer {
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  token?: string;
  agent_card?: unknown;
  enabled_skills?: string[];
}
```

Add to `AppSettings`:

```ts
a2a_client_servers: A2aClientServer[];
a2a_auto_route: boolean;
```

Keep old `a2a_*` server fields during migration but mark them compatibility/admin in comments.

**Step 2: Write tests**

Assert the A2A tab can render at least one configured server row and an auto-route toggle.

**Step 3: Implement initial UI**

Minimal controls:

- Add endpoint URL
- Add token
- Enable/disable
- Auto-route checkbox
- Clear visual distinction between `omni-agent-hub` endpoint and direct A2A agent endpoint

Do not implement discovery yet in this task.

**Step 4: Run tests**

```bash
cd /data/tools/omni-agent-desktop
npm test -- src/components/SettingsWindow.test.tsx
```

Expected: pass.

---

## Task 4: Implement A2A agent-card discovery in the frontend/runtime layer

**Objective:** Let the desktop discover what a configured A2A endpoint can do.

**Files:**
- Create: `src/lib/a2aClient.ts`
- Modify: `src/components/SettingsWindow.tsx`
- Test: `src/lib/a2aClient.test.ts`

**Step 1: Create failing client tests**

Test discovery fallback order:

1. `/.well-known/agent-card.json`
2. `/.well-known/agent.json`

Include bearer token header when a token is configured.

**Step 2: Implement discovery helper**

```ts
export async function fetchAgentCard(endpoint: string, token?: string): Promise<unknown> {
  // normalize trailing slash
  // try agent-card.json, then agent.json
  // include Authorization: Bearer <token> if token is non-empty
}
```

**Step 3: Add UI button**

In the A2A connection row, add `Discover`. On success, store the returned card in the server config and show discovered skill count/name.

**Step 4: Run tests**

```bash
cd /data/tools/omni-agent-desktop
npm test -- src/lib/a2aClient.test.ts
npm test -- src/components/SettingsWindow.test.tsx
```

Expected: pass.

---

## Task 5: Add A2A JSON-RPC delegation helper

**Objective:** Support sending tasks to a direct A2A endpoint or hub endpoint from desktop code.

**Files:**
- Modify: `src/lib/a2aClient.ts`
- Test: `src/lib/a2aClient.test.ts`

**Step 1: Test message/send + tasks/get polling**

A2A `message/send` often returns `working`, so tests must cover polling until a terminal state:

- `completed`
- `failed`
- `canceled`

**Step 2: Implement JSON-RPC helper**

Functions:

```ts
export async function sendA2aMessage(...): Promise<A2aTask>;
export async function pollA2aTask(...): Promise<A2aTask>;
export async function delegateA2aTask(...): Promise<A2aTask>;
```

Headers:

- `Content-Type: application/json`
- `A2A-Version: 1.0` when required by the endpoint
- `Authorization: Bearer <token>` when configured

**Step 3: Preserve hub/direct compatibility**

Do not special-case hub protocol unless necessary. `omni-agent-hub` should appear as a normal A2A endpoint with a composite agent card.

**Step 4: Run tests**

```bash
cd /data/tools/omni-agent-desktop
npm test -- src/lib/a2aClient.test.ts
```

Expected: pass.

---

## Task 6: Wire A2A capabilities into the desktop agent loop

**Objective:** Let the desktop AI use configured A2A skills/tools to extend capabilities.

**Files:**
- Add/modify agent runtime files under `src/lib/` or `src/features/ai/` depending on current organization
- Reference implementation: `/data/tools/omni-pilot/src/background/agent/a2a-tool-provider.mjs`
- Test: new unit tests for tool registration and routing

**Step 1: Port the concept, not browser-specific code**

Use OmniPilot as a model:

- one tool per direct A2A skill
- hub composite card support
- meta-tool for hub `skill:*` / `plugin:query:*` style skills
- explicit `@AgentName` routing and auto-route mode

Avoid Chrome storage/runtime APIs; use desktop settings state.

**Step 2: Write tool-registration tests**

Given a configured server with agent card skills, assert tools are registered with stable names and useful descriptions.

**Step 3: Implement minimal tool registration**

Build a pure helper that maps `A2aClientServer[]` to tool schemas/dispatch functions.

**Step 4: Run tests**

```bash
cd /data/tools/omni-agent-desktop
npm test -- src/lib/a2aClient.test.ts
npm test
```

Expected: pass.

---

## Task 7: Decide and simplify compatibility with OmniLauncher backend

**Objective:** Keep only the bridge pieces that are still useful, and avoid growing desktop into another OmniLauncher backend.

**Files:**
- Modify: `src/lib/runtime.ts`
- Modify: `src-tauri/src/main.rs`
- Modify: `README.md`
- Test: `src/lib/runtime.test.ts`

**Step 1: Audit current backend-routed commands**

List all commands in `runtime.ts` that route to `/api/*`.

Classify:

- local desktop commands: must remain Tauri-native
- thin AI/provider/A2A commands: candidate for direct desktop implementation
- legacy OmniLauncher backend commands: compatibility only

**Step 2: Update documentation/comments**

Mark compatibility routes clearly so future changes do not add new local backend assumptions.

**Step 3: Run runtime tests**

```bash
cd /data/tools/omni-agent-desktop
npm test -- src/lib/runtime.test.ts
```

Expected: pass.

---

## Task 8: End-to-end validation against hub and direct A2A

**Objective:** Prove the desktop can extend capabilities through both a direct A2A agent and `omni-agent-hub`.

**Files:**
- Create: `tests/e2e/a2a-client-e2e.test.ts` or suitable repo convention
- Update: `README.md` with test instructions

**Step 1: Bring up dependencies**

Use known local defaults:

- Direct OmniLauncher A2A: `http://127.0.0.1:1423`
- Hub: `http://127.0.0.1:8222`

Follow the A2A operational notes: message/send is async; tests must poll `tasks/get`.

**Step 2: Test direct endpoint**

- Fetch card.
- Send a simple task.
- Poll to terminal state.

**Step 3: Test hub endpoint**

- Fetch composite card.
- Verify namespaced skills are visible.
- Delegate one task through the hub.
- Poll to terminal state.

**Step 4: Full verification**

```bash
cd /data/tools/omni-agent-desktop
make check
```

Expected: TypeScript, unit tests, Rust checks, and E2E docs/scripts all pass or clearly skip when dependencies are absent.
