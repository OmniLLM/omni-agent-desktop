# Settings Providers, Background, and Scheduling Design

**Date:** 2026-07-11
**Status:** Approved

## Scope

This change fixes the nonfunctional Settings background, replaces the obsolete AI settings form with working Custom, GitHub Copilot, and Azure AI Foundry provider configuration, and turns Scheduled from a saved-prompts list into a persistent native scheduler.

The existing uncommitted background changes in `src/App.tsx` and `src/styles/layout/workspace.css` are user work and must be preserved and incorporated.

## Goals

- Preview and apply a configured background in both light and dark themes.
- Make provider-specific settings authoritative; retain legacy flat AI fields only for compatibility and migration.
- Support GitHub Copilot device-code OAuth and manual GitHub-token fallback.
- Store the long-lived GitHub credential securely and refresh short-lived Copilot API tokens automatically.
- Support Azure AI Foundry endpoint, API key, API version, and explicit model-to-deployment mappings.
- Run scheduled prompts through the existing agent execution path while the app process is alive.
- Execute each overdue task at most once after an app restart, regardless of how many intervals were missed.
- Add unit, integration, and end-to-end coverage for all three areas.

## Non-goals

- Running scheduled tasks while the desktop process is fully terminated.
- Implementing arbitrary cron expressions in the first iteration; the existing hourly, daily, and weekly cadences remain.
- Copying OmniLLM's HTTP administration server into the desktop application.
- Supporting Microsoft Entra ID for Azure in this iteration; Azure uses an API key.

## Architecture

### Background preview

`SettingsWindow` owns a draft background URL while the dialog is open and reports draft changes through a preview callback. `App` owns the effective preview value and passes it to `AppShell`. `AppShell` applies the image in light and dark themes with a theme-appropriate overlay for readable content.

Save validates and persists the draft. Cancel, a failed save, or closing without saving restores the persisted value. URL values are converted into CSS safely rather than interpolated into a raw declaration.

### Provider settings

The AI tab becomes provider-aware:

- **Custom:** endpoint, API key, API shape, and model.
- **GitHub Copilot:** connection state, device-code OAuth, manual GitHub-token fallback, discovered model selection, and disconnect.
- **Azure AI Foundry:** endpoint, API key, API version, explicit model-to-deployment mappings, and selected model.

`provider_configs` is authoritative for UI and runtime behavior. Legacy `ai_base_url`, `ai_api_key`, and `ai_model` fields remain compatibility projections and migration inputs only.

Focused Rust services isolate provider behavior:

- Copilot authentication and token lifecycle.
- Copilot model discovery and request routing.
- Azure configuration, deployment mapping, and request construction.
- Provider dispatch shared by manual and scheduled agent runs.

Secrets are persisted through the platform credential store when available. Existing plaintext values are migrated on successful read and removed from normal serialized settings. If credential-store access fails, saving fails visibly rather than silently degrading to plaintext.

### GitHub Copilot

Device OAuth requests a code from GitHub and returns the user code, verification URL, expiry, and polling interval. A native polling task respects GitHub's interval and handles `authorization_pending`, `slow_down`, expiry, cancellation, and denial. The frontend receives explicit flow states.

On success, the long-lived GitHub OAuth token is stored. A short-lived Copilot API token is exchanged lazily and cached in memory. It refreshes when absent or within five minutes of expiry. Manual-token setup uses the same validation, user lookup, persistence, and Copilot-token exchange path.

Model discovery calls the Copilot models endpoint and records supported endpoints per model. Requests select Chat Completions or Responses accordingly. A `401/403` forces one token refresh and one retry. A supported-endpoint mismatch may retry once via Responses. Retry counts are bounded.

Disconnect cancels any active flow, deletes persisted credentials, clears cached tokens, and resets provider state.

### Azure AI Foundry

Azure configuration includes:

- HTTPS endpoint.
- API key stored as a secret.
- API version.
- Unique application-model to deployment-name mappings.
- Selected application model.

The adapter centralizes endpoint normalization, `api-key` headers, model remapping, and Responses API payloads. The selected application model is translated to its deployment before request execution. A Test Connection action makes a bounded authenticated request and reports actionable errors without persisting the draft.

### Persistent scheduler

The scheduler runs as native Tauri-managed state. Tasks are typed records with:

- Stable ID.
- Prompt.
- Cadence: hourly, daily, or weekly.
- Enabled state.
- Creation/update timestamps.
- `next_run_at` and optional `last_run_at`.
- Last outcome and bounded error summary.

Mutations are serialized through the scheduler service, persisted atomically, and immediately reschedule in-memory timers. The frontend is an editor and status monitor, not the timing authority.

When a task becomes due, the scheduler acquires a per-task execution guard, snapshots the task, marks it running, and invokes the same agent execution service used by manual runs. Completion stores status and advances `next_run_at` to the first future interval. It does not enqueue one run per missed interval.

At startup, every overdue enabled task is queued once and then advanced to a future run. Disabled tasks are not queued. Editing, disabling, or deleting a task invalidates its previous timer. A task cannot execute concurrently with itself.

Because the desktop process owns the scheduler, tasks continue when the main window is hidden but not after the application has fully exited. Startup catch-up covers that case once.

## Data flows

### Background

1. Settings loads the persisted URL.
2. Draft changes update the app preview immediately.
3. `AppShell` applies the image and readable overlay in either theme.
4. Save validates and persists the draft.
5. Cancel, close-without-save, or failed save restores the persisted URL.

### Copilot OAuth

1. Start command creates a device-code flow and returns display details.
2. Native polling reports awaiting-user, complete, expired, cancelled, or error.
3. Completion stores the GitHub token and resolves the GitHub user.
4. Model listing or inference exchanges/refreshes the short-lived Copilot token.
5. Model capabilities select the request shape.
6. Disconnect removes persisted and in-memory credentials.

### Azure

1. The user edits a provider draft and deployment rows.
2. Validation rejects malformed or duplicate values inline.
3. Test Connection uses the draft without saving.
4. Save writes non-secret configuration and the key secret, then projects compatibility fields.
5. Inference remaps the model to a deployment and sends a Responses request.

### Scheduling

1. UI mutations call typed scheduler commands.
2. The scheduler validates, atomically persists, and reschedules.
3. Due tasks call common agent execution.
4. Status changes are persisted and emitted to the UI.
5. Startup performs at most one catch-up run per overdue task.

## Error handling

- Settings save errors keep the dialog open and preserve the draft.
- Background image load failure shows an inline warning and retains the draft for correction; it never breaks shell styling.
- OAuth flows expose denial, expiry, cancellation, network, and credential-store errors separately.
- Provider requests use bounded retries only for explicit authentication refresh or endpoint-shape fallback.
- Azure validation identifies the exact invalid field or duplicate mapping.
- Scheduler persistence failure rejects the mutation and retains the last valid in-memory schedule.
- Agent execution errors mark the scheduled run failed but still compute a future next run.
- Error summaries stored with tasks are length-bounded and must not contain credentials or full provider response bodies.

## Testing

### Frontend

- Background preset/custom preview in light and dark themes.
- Save commits the preview; cancel, close, and save failure restore the previous value.
- Provider-aware AI settings update `provider_configs`, not obsolete flat fields.
- Copilot OAuth pending/success/denied/expired/cancelled states and manual-token fallback.
- Azure mapping add/edit/delete, duplicate validation, Test Connection, and save behavior.
- Scheduled task CRUD, enabled state, last/next run display, Run Now, running, success, and error events.

### Rust

- Compatibility migration and projection tests.
- Device OAuth interval, `slow_down`, cancellation, denial, and expiry using an injectable HTTP/token client.
- Copilot token five-minute refresh window and one-time auth retry.
- Supported-endpoint model-shape selection and fallback.
- Azure endpoint validation, mapping uniqueness, URL/header construction, and model remapping.
- Scheduler cadence calculations with an injectable clock.
- Startup catch-up exactly once, next-run advancement, disabled tasks, edits/deletes, duplicate-run guard, persistence failure, and execution failure.

### End-to-end verification

- Preview and save a background in both themes, then restart and confirm persistence.
- Complete or simulate Copilot device OAuth, list models, select one, and send a request.
- Configure Azure mappings, test the connection, select a model, and send a request.
- Create a short test schedule through a test clock or development hook, hide the window, observe execution, restart with an overdue task, and verify exactly one catch-up run.

## Security and privacy

- Do not log GitHub tokens, Copilot tokens, Azure keys, authorization responses, or credential-store payloads.
- Redact authentication headers and provider response bodies from user-visible errors.
- Use cryptographically random request IDs where required by Copilot.
- Restrict background URLs to `https`, `http` for local development, and supported local asset schemes; encode them safely for CSS.
- Cancel OAuth pollers and scheduler workers during application shutdown.

## Delivery sequence

1. Establish typed provider/scheduler models and secret storage.
2. Fix background preview, rollback, and cross-theme rendering.
3. Replace the AI settings UI and fix authoritative provider persistence.
4. Add Copilot OAuth, token refresh, discovery, and dispatch.
5. Add Azure deployment mappings and adapter behavior.
6. Add native scheduler, startup catch-up, status events, and UI integration.
7. Run focused tests, full frontend/Rust suites, builds, security review, and real-app verification.
