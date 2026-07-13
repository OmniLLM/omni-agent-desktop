/**
 * Provider router. Selection rules, in order:
 *
 *   1. active_provider = azure-foundry  -> azureFoundryProvider
 *   2. active_provider = github-copilot -> copilotProvider
 *   3. active_provider = custom-provider:
 *        - api_shape = anthropic-messages -> anthropicMessagesProvider (HTTP)
 *        - api_shape = openai-responses / openai-compatible:
 *            - if model looks like `claude-*`              -> claude-sdk
 *            - if model looks like `gpt-*` / `o<digit>` / `codex-*` -> codex-sdk
 *            - else                                        -> chat-completions HTTP
 *
 * OmniLLM (Anthropic-messages via a custom endpoint) is the common case for
 * (3.a) and used to be broken here: earlier router versions always used Chat
 * Completions for custom-provider regardless of the configured api_shape.
 */
import type { AppSettings, ProviderConfig, ProviderType } from "../settings.js";
import type { Provider } from "./types.js";
import { anthropicSdkProvider } from "./anthropic-sdk.js";
import { anthropicMessagesProvider } from "./anthropic-http.js";
import { codexSdkProvider } from "./codex-sdk.js";
import { chatCompletionsProvider } from "./chat-completions.js";
import { azureFoundryProvider } from "./azure.js";
import { copilotProvider } from "./copilot.js";

export type ProviderRoute =
  | "claude-sdk"
  | "codex-sdk"
  | "chat-http"
  | "azure"
  | "copilot";

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
  if (type === "azure-foundry") {
    process.stderr.write(`agent-core: provider -> azure-foundry (deployment=${cfg.model})\n`);
    return azureFoundryProvider(cfg);
  }
  if (type === "github-copilot") {
    process.stderr.write(`agent-core: provider -> copilot (model=${cfg.model})\n`);
    return copilotProvider(cfg, copilotToken);
  }
  // custom-provider
  if (cfg.api_shape === "anthropic-messages") {
    // OmniLLM-shaped endpoints: HTTP Messages API. Preferred over the Claude
    // Agent SDK for custom endpoints because the SDK spawns a `claude` binary
    // and hard-codes some paths, neither of which fit a custom base URL.
    process.stderr.write(
      `agent-core: provider -> anthropic-http (custom anthropic-messages, model=${cfg.model})\n`,
    );
    return anthropicMessagesProvider(cfg);
  }
  const route = routeForModel(cfg.model);
  process.stderr.write(`agent-core: provider -> ${route} (custom ${cfg.api_shape}, model=${cfg.model})\n`);
  if (route === "claude-sdk") return anthropicSdkProvider(cfg);
  if (route === "codex-sdk") return codexSdkProvider(cfg);
  return chatCompletionsProvider(cfg);
}
