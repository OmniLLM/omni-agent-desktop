/**
 * Azure AI Foundry provider (chat/completions via /openai/v1). Uses the
 * `api-key` header instead of Bearer, and remaps model -> deployment before
 * emitting the request.
 */
import { httpFetch as fetch } from "../http.js";
import type { ProviderConfig } from "../settings.js";
import { buildMessages, parseChatCompletions } from "./chat-completions.js";
import type { ParsedTurn, Provider } from "./types.js";

export function azureFoundryProvider(cfg: ProviderConfig): Provider {
  return {
    async infer(system, messages, tools, signal): Promise<ParsedTurn> {
      const deployment = resolveDeployment(cfg);
      const base = cfg.endpoint.replace(/\/+$/, "");
      const apiVersion = cfg.azure_api_version || "2024-02-01";
      const url = `${base}/openai/v1/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
      const body = {
        model: deployment,
        messages: buildMessages(system, messages),
        tools: tools.length ? tools : undefined,
        store: false,
      };
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "api-key": cfg.api_key,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!r.ok) throw new Error(`azure http ${r.status}: ${await r.text()}`);
      return parseChatCompletions((await r.json()) as unknown);
    },
  };
}

function resolveDeployment(cfg: ProviderConfig): string {
  const model = cfg.model.trim();
  const match = cfg.azure_deployments.find((m) => m.model === model);
  return match?.deployment ?? model;
}
