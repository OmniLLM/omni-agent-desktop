/**
 * Provider router. Selection rules:
 *
 *   1. active_provider = azure-foundry  -> azureFoundryProvider (HTTP)
 *   2. active_provider = github-copilot -> copilotProvider (HTTP)
 *   3. active_provider = custom-provider:
 *        - api_shape = anthropic-messages          -> anthropicMessagesProvider (HTTP)
 *        - api_shape = openai-compatible / responses -> chatCompletionsProvider (HTTP)
 *
 * IMPORTANT: A custom provider has a USER-SUPPLIED endpoint. The Claude Agent
 * SDK and OpenAI Codex SDK both spawn a CLI binary and talk only to the
 * official Anthropic/OpenAI hosted backends — they IGNORE a custom base URL and
 * add a heavy binary dependency. So custom-provider always uses a plain HTTP
 * client that honors the configured endpoint and api_shape. Model-id (gpt-*,
 * claude-*, etc.) no longer changes the transport, only the wire shape does.
 */
import type { AppSettings, ProviderConfig, ProviderType } from "../settings.js";
import type { Provider } from "./types.js";
import { anthropicMessagesProvider } from "./anthropic-http.js";
import { chatCompletionsProvider } from "./chat-completions.js";
import { azureFoundryProvider } from "./azure.js";
import { copilotProvider } from "./copilot.js";

export type ProviderRoute = "anthropic-http" | "chat-http" | "azure" | "copilot";

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
  // custom-provider: always HTTP, transport shape by api_shape.
  if (cfg.api_shape === "anthropic-messages") {
    process.stderr.write(
      `agent-core: provider -> anthropic-http (custom anthropic-messages, model=${cfg.model})\n`,
    );
    return anthropicMessagesProvider(cfg);
  }
  process.stderr.write(
    `agent-core: provider -> chat-http (custom ${cfg.api_shape}, model=${cfg.model})\n`,
  );
  return chatCompletionsProvider(cfg);
}

