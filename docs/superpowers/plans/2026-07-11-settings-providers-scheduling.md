# Settings Providers and Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make backgrounds preview and persist correctly, provide working GitHub Copilot and Azure AI Foundry configuration, and replace saved scheduled prompts with a native persistent scheduler that performs one catch-up run after restart.

**Architecture:** Keep visual background drafts in React, but move credentials, provider-specific protocol behavior, and scheduling into focused Rust/Tauri modules. `provider_configs` becomes authoritative; a shared native agent execution service is used by foreground and scheduled runs. The scheduler owns typed persistence, timing, duplicate-run prevention, and status events.

**Tech Stack:** React 18, TypeScript 5, Tauri 2, Rust 2021, Tokio, Reqwest, Serde, Vitest, Rust unit/integration tests.

---

## File structure

### Frontend

- Modify `src/types/app.ts`: provider configuration, OAuth status, Azure mappings, and scheduled-task contracts.
- Modify `src/lib/runtime.ts`: register and mock new Tauri commands.
- Create `src/lib/background.ts`: background URL validation and CSS-safe value construction.
- Test `src/lib/background.test.ts`.
- Modify `src/components/AppShell.tsx`: cross-theme background rendering.
- Modify `src/components/SettingsWindow.tsx`: background draft callbacks and provider-aware settings shell.
- Create `src/components/settings/CustomProviderFields.tsx`: custom-provider form.
- Create `src/components/settings/CopilotProviderFields.tsx`: OAuth/token/status/model UI.
- Create `src/components/settings/AzureProviderFields.tsx`: endpoint/key/version/deployment mapping UI.
- Modify `src/components/SettingsWindow.test.tsx`: background and provider behavior.
- Modify `src/App.tsx`: preview lifecycle and scheduled status integration while preserving existing uncommitted lines.
- Modify `src/components/ScheduledView.tsx`: typed scheduler editor/status monitor.
- Create `src/components/ScheduledView.test.tsx`: scheduler UI coverage.
- Modify `src/styles/layout/workspace.css`: preserve transparent workspace and add status styles.

### Rust

- Modify `src-tauri/Cargo.toml`: add only `keyring` for platform credential storage.
- Create `src-tauri/src/secrets.rs`: credential-store abstraction and tests.
- Modify `src-tauri/src/settings.rs`: provider schema, migrations, projections, and validation.
- Create `src-tauri/src/agent/copilot.rs`: device OAuth, two-token lifecycle, model capabilities, retries.
- Create `src-tauri/src/agent/azure.rs`: deployment mapping and Azure request construction.
- Modify `src-tauri/src/agent/provider.rs`: shared provider discovery/request parsing.
- Modify `src-tauri/src/agent/mod.rs`: shared `run_once` execution entry point.
- Create `src-tauri/src/scheduler.rs`: typed store, cadence calculations, timers, catch-up, run guard, events.
- Modify `src-tauri/src/main.rs`: managed states and focused Tauri commands.
- Add module-local Rust tests; use injectable clients, clocks, stores, and runners instead of real services.

## Task 1: Protect current work and establish failing baselines

**Files:**
- Preserve: `src/App.tsx`
- Preserve: `src/styles/layout/workspace.css`
- Read/Test: existing suites

- [ ] **Step 1: Record the protected diff**

Run:

```powershell
git diff -- src/App.tsx src/styles/layout/workspace.css
```

Expected: the `backgroundUrl={settings?.background_url ?? ""}` line and transparent `.workspace-main` background are present. Do not restore, stash, or overwrite either file.

- [ ] **Step 2: Run frontend baseline**

Run: `npm test`

Expected: existing Vitest suites pass. Record failures that predate the change.

- [ ] **Step 3: Run Rust baseline**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: existing Rust tests pass. Record failures that predate the change.

## Task 2: Background validation, live preview, rollback, and cross-theme rendering

**Files:**
- Create: `src/lib/background.ts`
- Create: `src/lib/background.test.ts`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/SettingsWindow.tsx`
- Modify: `src/components/SettingsWindow.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles/layout/workspace.css`

- [ ] **Step 1: Write failing background utility tests**

Add tests for empty values, HTTPS URLs, localhost HTTP URLs, rejected `javascript:`/`data:` URLs, quotes, and CSS escaping:

```ts
expect(validateBackgroundUrl("")).toEqual({ ok: true, value: "" });
expect(validateBackgroundUrl("https://example.com/a b.jpg").ok).toBe(true);
expect(validateBackgroundUrl("javascript:alert(1)").ok).toBe(false);
expect(backgroundImageValue('https://example.com/a"b.jpg')).not.toContain('url("https://example.com/a"b.jpg")');
```

- [ ] **Step 2: Verify the utility tests fail**

Run: `npm test -- src/lib/background.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement URL validation and safe CSS construction**

Expose:

```ts
export type BackgroundValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function validateBackgroundUrl(raw: string): BackgroundValidation;
export function backgroundImageValue(url: string): string;
```

Accept empty, `https:`, localhost `http:`, and Tauri asset protocols already used by the app. Build the CSS value with `JSON.stringify(url)` so quotes and control characters cannot break the declaration.

- [ ] **Step 4: Write failing Settings preview/rollback tests**

Cover: draft selection calls `onBackgroundPreview`; Save retains it; Cancel/close restores the opening value; failed Save restores the persisted value and keeps the dialog open; invalid URL displays inline error.

- [ ] **Step 5: Implement preview ownership**

Add to `SettingsWindow` props:

```ts
onBackgroundPreview?: (url: string) => void;
```

Capture the opening persisted URL. Preview every valid draft change. On non-save close and save failure, preview the opening URL. In `App`, track `previewBackgroundUrl` separately from persisted settings and pass it to `AppShell`.

- [ ] **Step 6: Apply backgrounds in both themes**

Remove dark-theme gating in `AppShell`. Use layered gradients for contrast:

```ts
const overlay = resolvedTheme === "dark"
  ? "linear-gradient(rgb(0 0 0 / 46%), rgb(0 0 0 / 46%))"
  : "linear-gradient(rgb(255 255 255 / 72%), rgb(255 255 255 / 72%))";
```

Retain the existing transparent workspace CSS and add no opaque ancestor over the image.

- [ ] **Step 7: Run focused and full frontend tests**

Run:

```powershell
npm test -- src/lib/background.test.ts src/components/SettingsWindow.test.tsx src/App.test.tsx
npm test
npm run build
```

Expected: all pass.

## Task 3: Authoritative provider types, migration, and secure secrets

**Files:**
- Modify: `src/types/app.ts`
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/secrets.rs`
- Modify: `src-tauri/src/settings.rs`

- [ ] **Step 1: Write failing provider-schema and migration tests**

Test that `provider_configs` wins over legacy flat fields, legacy fields migrate once, compatibility fields project from the active provider, Copilot validation consults credential state, and Azure requires unique model/deployment mappings.

Use an Azure mapping contract:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AzureDeploymentMapping {
    pub model: String,
    pub deployment: String,
}
```

- [ ] **Step 2: Add failing secret-store tests using an injectable backend**

Define:

```rust
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}
```

Test get/set/delete, missing values, and surfaced backend failures with an in-memory fake.

- [ ] **Step 3: Verify Rust tests fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings:: secrets::`

Expected: FAIL for missing types/module.

- [ ] **Step 4: Add platform credential storage**

Add `keyring` to Cargo dependencies and implement `KeyringSecretStore` with service name `omni-agent-desktop`. Never serialize Copilot GitHub tokens or Azure keys into normal settings. Credential-store errors must return errors, not fall back to plaintext.

- [ ] **Step 5: Update provider configuration**

Keep custom fields, add Azure API version and deployment mappings, and ensure TypeScript mirrors Rust. Preserve deserialization defaults for existing settings. Keep legacy flat fields only as migration/projection fields.

- [ ] **Step 6: Run tests and build**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml settings::
cargo test --manifest-path src-tauri/Cargo.toml secrets::
npm run build
```

Expected: all pass.

## Task 4: GitHub Copilot OAuth and token lifecycle

**Files:**
- Create: `src-tauri/src/agent/copilot.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src/lib/runtime.ts`

- [ ] **Step 1: Write failing pure state-machine tests**

Cover device-code parsing; `authorization_pending`; `slow_down`; denied; expired; token completion; cancellation; and five-minute Copilot-token refresh skew. Define public states:

```rust
pub enum CopilotAuthStatus {
    Disconnected,
    AwaitingUser { flow_id: String, user_code: String, verification_uri: String, expires_at: u64 },
    Connected { login: String },
    Expired,
    Cancelled,
    Error { message: String },
}
```

- [ ] **Step 2: Write failing HTTP-client tests with an injectable transport**

Test device-code POST fields, OAuth token polling interval changes after `slow_down`, GitHub user lookup, Copilot-token exchange, and one forced refresh/retry after `401/403`. Do not call real GitHub.

- [ ] **Step 3: Implement Copilot auth service**

Port the proven OmniLLM sequence:

1. POST `https://github.com/login/device/code`.
2. Poll `https://github.com/login/oauth/access_token` at the instructed interval.
3. GET GitHub user.
4. GET `https://api.github.com/copilot_internal/v2/token`.
5. Cache the short-lived token in memory and refresh with 300-second skew.

Store only the long-lived GitHub token through `SecretStore`. Inject HTTP client and token fetcher for tests.

- [ ] **Step 4: Add Tauri commands and runtime mocks**

Register:

```rust
start_copilot_device_flow
get_copilot_auth_status
cancel_copilot_device_flow
connect_copilot_with_token
disconnect_copilot
list_copilot_models
```

Return public status only; never return stored tokens. Replace hardcoded `copilot_connected = false` validation with auth-service state.

- [ ] **Step 5: Add model capability discovery**

Parse `supported_endpoints`; route Responses-only models to `/responses`, otherwise prefer Chat Completions. Generate a cryptographically random request ID using the OS RNG facility provided by the selected dependency or platform API. Retry only once for auth refresh and once for explicit unsupported-chat fallback.

- [ ] **Step 6: Run focused tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml copilot::`

Expected: all Copilot tests pass without network access.

## Task 5: Azure Foundry deployment adapter

**Files:**
- Create: `src-tauri/src/agent/azure.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/agent/provider.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write failing Azure tests**

Cover HTTPS endpoint validation, endpoint normalization, duplicate/empty mappings, model-to-deployment remapping, `api-key` header, Responses URL, API version handling where applicable, and secret redaction.

- [ ] **Step 2: Implement Azure configuration and requests**

Expose pure helpers:

```rust
pub fn validate_config(config: &ProviderConfig) -> Result<(), String>;
pub fn remap_model<'a>(config: &'a ProviderConfig, model: &str) -> Result<&'a str, String>;
pub fn responses_url(endpoint: &str) -> Result<String, String>;
```

Use `{endpoint}/openai/v1/responses`, `api-key`, `store: false`, and the mapped deployment/model required by the endpoint. Keep secrets out of settings and logs.

- [ ] **Step 3: Add draft Test Connection command**

Register `test_azure_connection(draft, api_key)` but move the key immediately into the native request and never log or persist it unless Save succeeds. Return concise redacted errors.

- [ ] **Step 4: Run focused tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml azure:: provider::`

Expected: all pass.

## Task 6: Provider-aware Settings UI

**Files:**
- Create: `src/components/settings/CustomProviderFields.tsx`
- Create: `src/components/settings/CopilotProviderFields.tsx`
- Create: `src/components/settings/AzureProviderFields.tsx`
- Modify: `src/components/SettingsWindow.tsx`
- Modify: `src/components/SettingsWindow.test.tsx`
- Modify: `src/types/app.ts`

- [ ] **Step 1: Write failing provider UI tests**

Test provider selector; independent drafts; Custom API shape/model; Copilot disconnected/pending/connected/error states; device-code display/cancel; token fallback; model discovery; Azure mapping add/edit/delete; duplicate validation; Test Connection; Save activation; Cancel; and save-error draft preservation.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- src/components/SettingsWindow.test.tsx`

Expected: FAIL because provider-aware fields are absent.

- [ ] **Step 3: Split focused field components**

Each component receives a draft, an update callback, validation errors, and only its provider-specific command callbacks. Keep `SettingsWindow` responsible for provider selection, draft map, Save, and Cancel.

- [ ] **Step 4: Make provider configs authoritative**

On Save, update `active_provider` and `provider_configs`; do not write flat fields directly in the UI. Rust projects compatibility values. On provider switching inside the dialog, retain unsaved drafts per provider.

- [ ] **Step 5: Implement OAuth and Azure UI flows**

Poll status with bounded timers only while a flow is pending; clear the timer on unmount/cancel. Display the verification URI and code. Azure rows use stable keys and reject duplicate model or deployment names inline.

- [ ] **Step 6: Run frontend tests and build**

Run:

```powershell
npm test -- src/components/SettingsWindow.test.tsx
npm test
npm run build
```

Expected: all pass.

## Task 7: Shared headless agent execution

**Files:**
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write failing shared-run tests**

Define:

```rust
pub enum RunOrigin { Foreground, Scheduled { task_id: String } }
pub struct RunOutcome { pub text: String }
```

Test that foreground and scheduled origins use the same settings/provider dispatch and return the same parsed response. Inject the provider transport; do not bind a real socket.

- [ ] **Step 2: Extract `run_once`**

Move reusable work out of the Tauri `agent_run` command into an async service that accepts settings, prompt/history, origin, and injected provider dependencies. Keep the command as a thin adapter so existing chat behavior remains unchanged.

- [ ] **Step 3: Verify no foreground regression**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml agent::
npm test -- src/hooks/useAgent.test.ts src/App.test.tsx
```

Expected: all pass.

## Task 8: Typed persistent scheduler and catch-up semantics

**Files:**
- Create: `src-tauri/src/scheduler.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write failing serialization/migration tests**

Define:

```rust
pub enum Cadence { Hourly, Daily, Weekly }
pub enum RunStatus { Idle, Running, Succeeded, Failed }
pub struct ScheduledTask {
    pub id: String,
    pub prompt: String,
    pub cadence: Cadence,
    pub enabled: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub next_run_at: u64,
    pub last_run_at: Option<u64>,
    pub last_status: RunStatus,
    pub last_error: Option<String>,
}
```

Test migration from current `{id,prompt,cadence}` JSON with defaults.

- [ ] **Step 2: Write failing cadence and catch-up tests**

With an injected clock, test exact next-run calculation, overdue startup queues once, many missed intervals still queue once, disabled tasks do not run, completion advances to the first future interval, and execution failure still schedules a future run.

- [ ] **Step 3: Write failing mutation and duplicate-run tests**

Test create/update/disable/delete atomically persists and invalidates previous timers. A per-task guard rejects overlapping automatic/manual runs of the same task.

- [ ] **Step 4: Implement scheduler store and service**

Use atomic JSON writes, a `Mutex`-protected typed store, generation/version tokens for timer invalidation, and injected `Clock`/`TaskRunner` traits. Bound stored error summaries and redact credentials/provider bodies.

- [ ] **Step 5: Add Tauri state, startup catch-up, and commands**

Register:

```rust
list_scheduled
create_scheduled
update_scheduled
delete_scheduled
run_scheduled_now
```

Start the scheduler in Tauri setup. Emit status events containing task ID, status, last/next timestamps, and redacted error summary. On shutdown, cancel timers/workers.

- [ ] **Step 6: Run scheduler tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml scheduler::`

Expected: all pass deterministically without sleeping.

## Task 9: Scheduler editor and status UI

**Files:**
- Modify: `src/components/ScheduledView.tsx`
- Create: `src/components/ScheduledView.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles/layout/workspace.css`
- Modify: `src/lib/runtime.ts`

- [ ] **Step 1: Write failing UI tests**

Cover typed load, create/edit/delete, enabled toggle, last/next run display, Run Now command, running state, success, redacted error, and event updates.

- [ ] **Step 2: Replace whole-array autosave with typed commands**

Remove `save_scheduled` on every React state change. Call create/update/delete commands and reconcile returned tasks. Listen for scheduler status events and update only the matching record.

- [ ] **Step 3: Preserve current protected edits**

Keep the existing background URL line and transparent workspace declaration. Add only the scheduler listener and status styles needed by the new UI.

- [ ] **Step 4: Run focused and full frontend verification**

Run:

```powershell
npm test -- src/components/ScheduledView.test.tsx src/App.test.tsx
npm test
npm run build
```

Expected: all pass.

## Task 10: Security, complete verification, and real-app exercise

**Files:**
- Review all changed files
- Update tests only where verification finds a concrete gap

- [ ] **Step 1: Run all automated checks**

Run:

```powershell
npm test
npm run test:launcher
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: all pass.

- [ ] **Step 2: Scan changed code for secrets vulnerabilities**

Run the repository security-review/Aikido scan over changed source files. Confirm tokens, keys, authorization headers, and provider bodies are neither logged nor serialized into normal settings.

- [ ] **Step 3: Review and simplify changed code**

Run the required code-review and simplify workflows. Apply only verified findings; rerun focused tests after every correction.

- [ ] **Step 4: Exercise background behavior end to end**

Launch the app, preview a background in light and dark themes, Cancel and verify rollback, Save and restart, then confirm persistence.

- [ ] **Step 5: Exercise provider behavior end to end**

Use mocks where live credentials are unavailable. Verify Copilot pending/success/cancel/error states, model discovery and request; verify Azure deployment mapping, Test Connection, selected-model request, restart persistence, and failed-save preservation.

- [ ] **Step 6: Exercise scheduling end to end**

Use an injectable/development clock hook in a test build to make a task due, hide the window and observe execution, restart with an overdue task, and verify exactly one catch-up run and a future `next_run_at`.

- [ ] **Step 7: Confirm protected user changes survived**

Run:

```powershell
git diff -- src/App.tsx src/styles/layout/workspace.css
```

Expected: the original background URL and transparent workspace changes remain, plus intentional preview/scheduler additions.

## Plan self-review

- Spec coverage: background cross-theme preview/rollback, authoritative providers, Copilot OAuth/token fallback/refresh/discovery, Azure mappings, secret storage, scheduler persistence/timing/catch-up/dedup/status, security, and end-to-end verification all map to tasks.
- Placeholder scan: no deferred implementation placeholders or unbounded “handle errors” steps remain.
- Type consistency: frontend and Rust use the same provider, OAuth, Azure mapping, cadence, status, and timestamp concepts; `run_once` is the sole shared execution entry point.
