/**
 * Provider router — model-id based, per the user's rule:
 *   claude-*  -> Claude Agent SDK
 *   gpt-* / o* / codex-* -> Codex SDK
 *   anything else -> OpenAI Chat Completions HTTP shape
 *
 * Active-provider (custom / azure-foundry / github-copilot) supplies the
 * endpoint, credentials, and any provider-specific headers or shape overrides.
 */
import type { AppSettings, ProviderConfig, ProviderType } from "../settings.js";
import type { Provider } from "./types.js";
import { anthropicSdkProvider } from "./anthropic-sdk.js";
import { codexSdkProvider } from "./codex-sdk.js";
import { chatCompletionsProvider } from "./chat-completions.js";
import { azureFoundryProvider } from "./azure.js";
import { copilotProvider } from "./copilot.js";

export type ProviderRoute = "claude-sdk" | "codex-sdk" | "chat-http";

export function routeForModel(model: string): ProviderRoute {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "claude-sdk";
  if (m.startsWith("gpt") || m.startsWith("codex") || /^o\d/.test(m)) return "codex-sdk";
  return "chat-http";
}

export function activeConfig(settings: AppSettings): { type: ProviderType; cfg: ProviderConfig } {
  const type = settings.active_provider;
  const cfg = settings.provider_configs?.[type];
  if (!cfg) throw new Error(`no provider config for ${type}`);
  return { type, cfg };
}

export function pickProvider(settings: AppSettings, copilotToken: string | null): Provider {
  const { type, cfg } = activeConfig(settings);
  // The provider (endpoint/auth) is chosen by `active_provider`; the model id
  // decides which client shape to use.
  if (type === "azure-foundry") return azureFoundryProvider(cfg);
  if (type === "github-copilot") return copilotProvider(cfg, copilotToken);
  const route = routeForModel(cfg.model);
  if (route === "claude-sdk") return anthropicSdkProvider(cfg);
  if (route === "codex-sdk") return codexSdkProvider(cfg);
  return chatCompletionsProvider(cfg);
}
