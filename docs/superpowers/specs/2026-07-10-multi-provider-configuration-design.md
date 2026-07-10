# Multi-Provider Configuration Design

**Date:** 2026-07-10  
**Status:** Approved  
**Scope:** Configure and run Custom Provider, GitHub Copilot, and Azure Foundry from Omni Agent Desktop.

## Summary

Omni Agent Desktop will support three provider types through one provider picker. Each provider keeps an independent saved profile, while one provider is active for chat at a time. The React preferences UI owns draft editing. A native Tauri/Rust provider service owns provider persistence, authentication, model loading, secret handling, request construction, and outbound provider calls.

The design adapts provider schemas and behavior from `omni-pilot` without carrying over its Chrome-extension storage and runtime architecture. It preserves the desktop's HTTP-backend compatibility path, but provider configuration and execution must work in pure Tauri mode.

## Goals

- Configure Custom Provider, GitHub Copilot, and Azure Foundry in Preferences.
- Preserve a separate configuration for every provider when switching.
- Activate a provider only after the user saves valid settings.
- Implement complete GitHub Copilot device-flow authentication and direct Copilot requests.
- Support Custom Provider requests using OpenAI Chat Completions, Anthropic Messages, or OpenAI Responses shapes.
- Support Azure Foundry through an endpoint, API key, and manual deployment/model list.
- Migrate existing flat AI settings without losing values.
- Keep secrets local and redact them from diagnostics.

## Non-Goals

- Multiple accounts or profiles for the same provider type.
- OS credential-manager integration in this iteration.
- Automatic Azure deployment discovery.
- Arbitrary named provider types beyond the single Custom Provider profile.
- A2A settings or runtime changes.
- Removing the OmniLauncher HTTP-backend compatibility path.
- Unrelated refactoring.

## Architecture

### React preferences layer

React owns only presentation and draft state:

- Provider picker and provider-specific fields.
- Draft preservation while switching providers.
- Field-level validation feedback.
- Model refresh and manual-model controls.
- GitHub Copilot authentication status and device-flow instructions.
- Atomic Save and discard-on-Cancel behavior.

React must not make authenticated provider requests directly or hold raw Copilot tokens in ordinary component state.

### Native provider service

Tauri/Rust owns:

- Loading, migration, validation, and persistence of provider settings.
- GitHub device flow, token polling, token refresh, and sign-out.
- Model discovery for Custom Provider and GitHub Copilot.
- Provider endpoint normalization and authentication headers.
- Request construction and response parsing by API shape.
- Model-specific Copilot Chat/Responses routing.
- Safe error classification and secret-redacted logging.

This boundary avoids browser CORS constraints, reduces secret exposure in the webview, and provides the native base required by the desktop's local agent loop.

### Provider registry

Provider-specific behavior is declared in a registry rather than spread across UI conditionals:

| Provider | Endpoint | API key | API shape | Models | Authentication |
|---|---:|---:|---|---|---|
| Custom Provider | Yes | Yes | User-selected | Discover from `/models`, manual fallback | Static API key |
| GitHub Copilot | No | No | Native model routing | Copilot model endpoint | GitHub device flow |
| Azure Foundry | Yes | Yes | Fixed OpenAI-compatible | Manual list | Static API key |

The TypeScript UI metadata and Rust provider definitions must represent the same capabilities. Tests protect their observable behavior.

## Settings Model

### Frontend types

```ts
export type ProviderType =
  | "custom-provider"
  | "github-copilot"
  | "azure-foundry";

export type ApiShape =
  | "openai-compatible"
  | "anthropic-messages"
  | "openai-responses";

export interface ProviderConfig {
  endpoint: string;
  api_key: string;
  api_shape: ApiShape;
  model: string;
  manual_models: string;
}

export interface ProviderSettings {
  active_provider: ProviderType;
  provider_configs: Record<ProviderType, ProviderConfig>;
}
```

`AppSettings` includes the provider settings alongside existing shared settings. The Rust model uses corresponding typed enums and provider config structures with serde defaults.

### Shared settings

The following remain global rather than per-provider:

- Timeout.
- Maximum tool iterations.
- Retry attempts and base delay.
- Loop detector.
- Theme, hotkey, result limit, and background settings.

### Compatibility fields

`ai_base_url`, `ai_api_key`, and `ai_model` remain during migration. They mirror the active provider's effective values where applicable so compatibility consumers continue to load settings. They are not the long-term source of truth once `provider_configs` exists.

## Migration

When settings do not contain a provider config map:

1. Create the `custom-provider` profile from `ai_base_url`, `ai_api_key`, and `ai_model`.
2. Infer Anthropic Messages for the existing OmniLLM endpoint rule; otherwise use OpenAI-compatible.
3. Set Custom Provider as active.
4. Supply empty default profiles for GitHub Copilot and Azure Foundry.
5. Persist the new representation only through a normal successful Save; loading alone must not silently rewrite the settings file.

When provider profiles already exist, they take precedence and must never be overwritten from legacy flat fields.

A successful Save atomically persists the active provider, all provider profiles, compatibility projections, and shared settings. A failed Save leaves the previously persisted configuration unchanged.

## Preferences UI

The AI tab places the Provider selector before provider-specific settings.

### Draft lifecycle

- Opening Preferences clones persisted settings into draft state.
- Switching providers writes the current form into that provider's draft and loads the target provider's draft.
- Switching does not persist or activate anything.
- Save validates all required fields for the selected provider, persists the complete profile map, and activates the selected provider.
- Cancel or closing without Save discards the entire draft.
- Save failure preserves the draft for correction and keeps the previous active provider.

### Custom Provider

Show:

- Endpoint.
- API key.
- API shape selector.
- Selected model.
- Refresh models.
- Manual model entry fallback.

Model discovery uses the unsaved draft endpoint, key, and API shape. It requests the normalized endpoint's `/models` route and accepts common `data[].id` or `models[].name` response forms. Anthropic-shaped requests use `x-api-key`; other shapes use bearer authentication. A discovery failure keeps the form usable and exposes manual model entry instead of clearing the selected model.

### GitHub Copilot

Show:

- Connected, disconnected, pending, expired, or failed status.
- Sign in or Sign out action.
- Device code and validated verification link during authentication.
- Refreshable Copilot model selector.

Do not show endpoint, API-key, or API-shape fields. GitHub Copilot cannot be saved as active unless authentication is connected and a model is selected.

### Azure Foundry

Show:

- Endpoint.
- API key.
- Manual deployments/models textarea.
- Model selector populated from the normalized manual list.

Parse deployment/model names from newline- or comma-separated text, trim whitespace, remove empty values, and de-duplicate while retaining first-seen order. The list and selected model are required. The API shape is fixed internally to OpenAI-compatible and is not editable.

## GitHub Copilot Authentication

The native service adapts the full `omni-pilot` device-flow behavior:

1. Start the GitHub device authorization request.
2. Validate the response and return only the user code, verification URL, expiry, polling interval, and opaque device-flow identifier required by subsequent commands.
3. Accept and open only `https://github.com/login/device` as the verification URL.
4. Poll according to the server interval, respecting pending, `slow_down`, expiration, denial, and terminal errors.
5. Persist the GitHub token and device-flow state in the existing local desktop configuration area.
6. Exchange the GitHub token for a short-lived Copilot API token when required and cache it until shortly before expiry.
7. Sign-out clears GitHub, Copilot, and pending device-flow state.

Raw GitHub and Copilot tokens must not be returned to React. Authentication commands expose only status and non-secret device-flow details.

The current iteration stores these values in existing local desktop storage, consistent with current API-key handling. OS credential-store integration remains a future hardening opportunity.

## Native Command Surface

Use focused commands with typed inputs and outputs:

- `list_provider_models(provider_type, draft_config)`
- `start_copilot_device_flow()`
- `poll_copilot_device_flow(flow_id)`
- `get_copilot_auth_status()`
- `clear_copilot_auth()`
- Local provider query/cancel operations required by the native agent loop

Implement provider settings and migration in a focused settings module, Copilot authentication in a dedicated authentication module, and request construction/parsing in a provider client module. UI consumers depend only on the narrow commands and normalized results above.

## Provider Request Flow

A shared request builder accepts the active provider config, normalized conversation messages, system prompt, and tools. It returns:

- API shape.
- Request URL.
- Redactable headers.
- Provider-specific body.
- Matching response parser.

### Custom Provider

- OpenAI-compatible: `POST <endpoint>/chat/completions`.
- Anthropic Messages: `POST <endpoint>/messages` with `x-api-key` and Anthropic version headers.
- OpenAI Responses: `POST <endpoint>/responses`.

The endpoint normalizer removes trailing separators and adds `/v1` only when the configured URL contains no path. It must not duplicate `/v1` or provider-specific path segments.

### GitHub Copilot

Use Copilot-specific headers, short-lived Copilot authentication, and the model catalog endpoint. Adapt `omni-pilot`'s known model-shape map and fallback heuristics:

- Models known to require Responses use `/responses`.
- Other supported models use `/chat/completions`.
- Reasoning-family Copilot chat models use `max_completion_tokens`; compatible older models use `max_tokens`.
- A newly introduced model falls through to conservative family heuristics until the map is updated.

### Azure Foundry

Use the configured endpoint and API key with the OpenAI-compatible Chat Completions request shape. The manually entered value is sent as the model/deployment identifier. Preserve `omni-pilot`'s verified Azure Foundry `gpt-5.4` behavior: use `max_completion_tokens` instead of `max_tokens` for that model.

## Error Handling and Diagnostics

### Validation failures

Save is blocked with field-level feedback for:

- Missing or invalid required endpoint.
- Missing required API key.
- Missing selected model.
- Empty Azure model/deployment list.
- Azure selected model not present in the normalized list.
- GitHub Copilot not connected.

### Runtime failures

Normalize provider errors into actionable categories:

- Authentication/authorization failure.
- Rate limit or quota exhaustion.
- Unsupported model or API shape.
- Network or TLS failure.
- Invalid or incomplete provider response.
- Copilot authentication expiration or denial.

Model discovery failures are recoverable and non-destructive. Copilot expiry moves the UI to disconnected and requires reauthentication. Provider request failures surface to the existing AI error event path without exposing credentials.

### Logging

- Redact authorization, API-key, and token-bearing headers.
- Never log persisted secrets, device codes, GitHub tokens, or Copilot tokens.
- Log provider type, API shape, redacted endpoint origin, model, HTTP status, and request duration. Include at most 300 characters of a response error body after applying secret redaction.

## Testing Strategy

### React component tests

Extend `SettingsWindow.test.tsx` to verify:

- Provider options and default migration state.
- Provider-specific field visibility.
- Independent drafts survive provider switching.
- Save activation versus Cancel discard.
- Custom model discovery success and manual fallback.
- Azure list parsing, de-duplication, selection, and validation.
- Copilot authentication status and device-flow UI states.
- Save guards and failure-state draft preservation.

Update all complete `AppSettings` fixtures to include the new required fields.

### Rust unit tests

Cover:

- Legacy migration and profile precedence.
- Serde defaults and round-trip persistence.
- Provider validation.
- Endpoint normalization.
- Headers and request bodies for every API shape.
- Copilot model routing and token-limit rules.
- Azure `gpt-5.4` token-limit behavior.
- Response parsing and normalized errors.
- Secret redaction.
- Device-flow response validation, polling transitions, expiry, and token refresh.

### Mock HTTP integration tests

Use a local mock server to cover:

- Custom `/models` discovery variants and failure fallback.
- GitHub device authorization, polling, Copilot-token exchange, and sign-out.
- Copilot model listing and both Chat and Responses requests.
- Azure request construction.
- Authentication, rate-limit, unsupported-model, malformed-response, and network failures.

### End-to-end acceptance

Drive the packaged or development Tauri app and verify:

1. Configure and save Custom Provider; switch away and back without losing its profile; complete a query.
2. Complete GitHub Copilot sign-in, refresh models, select a model, save, and complete a query.
3. Configure Azure Foundry with manual deployments, save, and complete a query.
4. Restart the app and confirm the active provider and every profile reload correctly.
5. Confirm invalid configuration and failed saves do not replace the last working provider.

Real-provider checks may be skipped only when credentials are unavailable; mock integration tests remain mandatory.

## Compatibility and Rollout

- Keep existing HTTP `/api/settings`, `/api/models`, and AI routes working as a compatibility bridge.
- Extend compatibility payloads where the backend understands provider profiles, but do not require backend support for pure-Tauri operation.
- Preserve existing shared settings and A2A settings unchanged.
- Do not modify or overwrite the user's pre-existing `src-tauri/Cargo.toml` change except where implementation later requires an explicitly reviewed merge.

## Acceptance Criteria

- Preferences exposes Custom Provider, GitHub Copilot, and Azure Foundry.
- Each provider retains its own profile across switching, Save, app restart, and later editing.
- Provider switching remains a draft until Save.
- Full GitHub Copilot device flow, token lifecycle, model listing, and direct requests work from the desktop.
- Custom Provider supports all three specified API shapes and manual model fallback.
- Azure Foundry accepts and uses a manual deployment/model list.
- Legacy flat settings migrate without data loss.
- The native runtime can execute against every provider without a separate OmniLauncher backend.
- Errors are actionable, drafts are not lost, and secrets do not appear in logs.
- Component, Rust unit, mock integration, and available end-to-end tests pass.
