import type { ProviderConfig, ProviderType } from "../types/app";

/**
 * Frontend save-time validation for provider drafts. These are guard rails that
 * mirror (but do not replace) the authoritative native/Rust validation — they
 * give the user field-level feedback and block a doomed save round-trip.
 *
 * Returns an error string when invalid, or "" when the draft is savable.
 */
export function validateProviderDraft(
  provider: ProviderType,
  draft: ProviderConfig,
  ctx: { copilotConnected: boolean },
): string {
  switch (provider) {
    case "custom-provider":
      return validateCustom(draft);
    case "github-copilot":
      return validateCopilot(ctx.copilotConnected, draft);
    case "azure-foundry":
      return validateAzure(draft);
  }
}

function validateCustom(draft: ProviderConfig): string {
  if (!draft.endpoint.trim()) return "Provider endpoint is required";
  if (!draft.api_shape) return "API shape is required";
  // Parity with the authoritative Rust validation, which requires a key for the
  // custom provider. The custom key is plaintext (not secret-stored), so there
  // is no api_key_stored fallback here.
  if (!draft.api_key.trim()) return "API key is required";
  if (!draft.model.trim()) return "Model is required";
  return "";
}

function validateCopilot(connected: boolean, draft: ProviderConfig): string {
  if (!connected) {
    return "Connect GitHub Copilot before activating this provider";
  }
  if (!draft.model.trim()) {
    return "Select a Copilot model before activating this provider";
  }
  return "";
}

/** Trimmed, non-empty mapping models in draft order (deduped for membership). */
export function normalizedAzureModels(draft: ProviderConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of draft.azure_deployments ?? []) {
    const model = m.model.trim();
    if (model && !seen.has(model)) {
      seen.add(model);
      out.push(model);
    }
  }
  return out;
}

function validateAzure(draft: ProviderConfig): string {
  const endpoint = draft.endpoint.trim();
  if (!endpoint) return "Azure endpoint is required";
  if (!/^https:\/\//i.test(endpoint)) {
    return "Azure endpoint must be an https:// URL";
  }
  // NOTE: key presence is intentionally NOT blocked here. Deliberately clearing
  // the stored credential (api_key="" + api_key_stored=false) is a valid save —
  // it tells the native layer to delete the keyring entry. The authoritative
  // Rust `validate_config` still enforces key-or-stored for a live request.
  if (!(draft.azure_api_version ?? "").trim()) {
    return "Azure API version is required";
  }
  const mappings = draft.azure_deployments ?? [];
  if (mappings.length === 0) {
    return "At least one deployment mapping is required";
  }
  const models = new Set<string>();
  const deployments = new Set<string>();
  for (const m of mappings) {
    const model = m.model.trim();
    const deployment = m.deployment.trim();
    if (!model || !deployment) {
      return "Every mapping needs a model and a deployment";
    }
    if (models.has(model)) return "Duplicate model name in mappings";
    if (deployments.has(deployment)) {
      return "Duplicate deployment name in mappings";
    }
    models.add(model);
    deployments.add(deployment);
  }
  const selected = draft.model.trim();
  if (!selected) return "Selected model is required";
  if (!models.has(selected)) {
    return "Selected model must be one of the mapped models";
  }
  return "";
}
