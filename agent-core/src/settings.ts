/**
 * Provider settings model, migration, validation, and atomic persistence.
 * TS port of src-tauri/src/settings.rs — same wire shape (snake_case, kebab
 * enum variants) so the frontend needs no changes.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { legacySettingsPath, settingsPath } from "./paths.js";

export type ProviderType = "custom-provider" | "github-copilot" | "azure-foundry";
export const PROVIDER_TYPES: ProviderType[] = [
  "custom-provider",
  "github-copilot",
  "azure-foundry",
];

export type ApiShape = "openai-compatible" | "anthropic-messages" | "openai-responses";
export type WindowSizePreset = "compact" | "standard" | "large";
export type RunMode = "ask" | "plan" | "autopilot";

export interface AzureDeploymentMapping {
  model: string;
  deployment: string;
}

export interface ProviderConfig {
  endpoint: string;
  api_key: string;
  api_key_stored?: boolean;
  api_shape: ApiShape;
  model: string;
  azure_deployments: AzureDeploymentMapping[];
  azure_api_version: string;
  manual_models: string;
}

export interface A2aConnection {
  id: string;
  name: string;
  endpoint: string;
  token: string;
  enabled: boolean;
  disabled_skills: string[];
}

export interface AppSettings {
  ai_base_url: string;
  ai_model: string;
  ai_api_key: string;
  active_provider: ProviderType;
  provider_configs?: Record<ProviderType, ProviderConfig>;
  ai_timeout_secs: number;
  ai_max_tool_iterations: number;
  ai_max_retry_attempts: number;
  ai_retry_base_delay_ms: number;
  ai_loop_detector_enabled: boolean;
  theme: string;
  hotkey: string;
  max_results: number;
  background_url: string;
  a2a_connections: A2aConnection[];
  run_mode: RunMode;
  backend_url: string;
  window_size: WindowSizePreset;
}

export function defaultProviderConfig(): ProviderConfig {
  return {
    endpoint: "",
    api_key: "",
    api_shape: "openai-compatible",
    model: "",
    azure_deployments: [],
    azure_api_version: "",
    manual_models: "",
  };
}

export function defaultProviderConfigs(): Record<ProviderType, ProviderConfig> {
  return {
    "custom-provider": defaultProviderConfig(),
    "github-copilot": defaultProviderConfig(),
    "azure-foundry": defaultProviderConfig(),
  };
}

export function defaultSettings(): AppSettings {
  return {
    ai_base_url: "",
    ai_model: "",
    ai_api_key: "",
    active_provider: "custom-provider",
    provider_configs: defaultProviderConfigs(),
    ai_timeout_secs: 120,
    ai_max_tool_iterations: 10,
    ai_max_retry_attempts: 3,
    ai_retry_base_delay_ms: 2000,
    ai_loop_detector_enabled: true,
    theme: "system",
    hotkey: "Ctrl+Shift+O",
    max_results: 10,
    background_url: "",
    a2a_connections: [],
    run_mode: "ask",
    backend_url: "",
    window_size: "standard",
  };
}

export function inferApiShape(endpoint: string): ApiShape {
  return endpoint.toLowerCase().includes("omnillm") ? "anthropic-messages" : "openai-compatible";
}

function fillDefaults(raw: Partial<AppSettings>): AppSettings {
  const d = defaultSettings();
  const merged: AppSettings = { ...d, ...raw } as AppSettings;
  // Backfill provider profiles; migrate legacy flat fields when absent.
  if (!merged.provider_configs) {
    const map = defaultProviderConfigs();
    map["custom-provider"] = {
      ...defaultProviderConfig(),
      endpoint: merged.ai_base_url,
      api_key: merged.ai_api_key,
      model: merged.ai_model,
      api_shape: inferApiShape(merged.ai_base_url),
    };
    merged.provider_configs = map;
  } else {
    for (const p of PROVIDER_TYPES) {
      merged.provider_configs[p] ??= defaultProviderConfig();
    }
  }
  // Normalize unknown window-size preset.
  if (!(["compact", "standard", "large"] as const).includes(merged.window_size)) {
    merged.window_size = "standard";
  }
  return merged;
}

export function loadSettings(path = settingsPath(), legacy = legacySettingsPath()): AppSettings {
  const tryRead = (p: string): Partial<AppSettings> | undefined => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return undefined;
    }
  };
  const raw = tryRead(path) ?? tryRead(legacy);
  return fillDefaults(raw ?? {});
}

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

export function validateProvider(
  provider: ProviderType,
  cfg: ProviderConfig,
  copilotConnected: boolean,
): ValidationResult {
  const req = (v: string, msg: string): ValidationResult | undefined =>
    v.trim() === "" ? { ok: false, message: msg } : undefined;
  if (provider === "custom-provider") {
    return (
      req(cfg.endpoint, "Endpoint is required") ??
      req(cfg.api_key, "API key is required") ??
      req(cfg.model, "Model is required") ?? { ok: true }
    );
  }
  if (provider === "github-copilot") {
    if (!copilotConnected) return { ok: false, message: "GitHub Copilot is not connected" };
    return req(cfg.model, "Model is required") ?? { ok: true };
  }
  // azure-foundry
  const badEndpoint = req(cfg.endpoint, "Endpoint is required");
  if (badEndpoint) return badEndpoint;
  if (cfg.api_key.trim() === "" && !cfg.api_key_stored) {
    return { ok: false, message: "API key is required" };
  }
  const mappings = cfg.azure_deployments.length
    ? cfg.azure_deployments
    : parseManualModels(cfg.manual_models).map((n) => ({ model: n, deployment: n }));
  if (mappings.length === 0) {
    return { ok: false, message: "At least one deployment/model mapping is required" };
  }
  const models = new Set<string>();
  const deployments = new Set<string>();
  for (const m of mappings) {
    if (!m.model.trim()) return { ok: false, message: "Mapping model is required" };
    if (!m.deployment.trim()) return { ok: false, message: "Mapping deployment is required" };
    if (models.has(m.model.trim()))
      return { ok: false, message: `Duplicate model mapping: ${m.model.trim()}` };
    if (deployments.has(m.deployment.trim()))
      return { ok: false, message: `Duplicate deployment mapping: ${m.deployment.trim()}` };
    models.add(m.model.trim());
    deployments.add(m.deployment.trim());
  }
  if (!cfg.azure_api_version.trim()) return { ok: false, message: "API version is required" };
  if (!cfg.model.trim()) return { ok: false, message: "Selected model is required" };
  if (!mappings.some((m) => m.model.trim() === cfg.model.trim())) {
    return { ok: false, message: "Selected model is not in the mapping list" };
  }
  return { ok: true };
}

export function parseManualModels(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\n\r,]/)) {
    const t = token.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export function projectCompatibilityFields(s: AppSettings): void {
  const active = s.provider_configs?.[s.active_provider];
  if (!active) return;
  if (s.active_provider === "github-copilot") {
    s.ai_base_url = "";
    s.ai_api_key = "";
  } else {
    s.ai_base_url = active.endpoint;
    s.ai_api_key = active.api_key;
  }
  s.ai_model = active.model;
}

export function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  writeFileSync(tmp, contents);
  try {
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
    renameSync(tmp, path);
  }
}

export function saveSettings(path: string, settings: AppSettings): AppSettings {
  const out: AppSettings = { ...settings };
  // Ensure provider_configs is materialized before write.
  const merged = fillDefaults(out);
  atomicWrite(path, JSON.stringify(merged, null, 2));
  return merged;
}
