/**
 * OpenAI Codex SDK provider.
 *
 * `@openai/codex-sdk` exposes a Thread API: `codex.startThread().run(prompt)`
 * with the reply available as `result.finalResponse`. The SDK does not (as of
 * writing) expose a public streaming tool-callback surface, so we do the same
 * "outer loop iterates, SDK produces one final turn per call" trick as the
 * Claude Agent SDK adapter: our loop still handles tool approval, execution,
 * and iteration; the SDK is the LLM client.
 */
import { Codex } from "@openai/codex-sdk";
import type { ProviderConfig } from "../settings.js";
import type { Msg, ParsedTurn, Provider } from "./types.js";

export function codexSdkProvider(cfg: ProviderConfig): Provider {
  return {
    async infer(system, messages, _tools): Promise<ParsedTurn> {
      // Codex reads OPENAI_API_KEY from env; scope it per call so multiple
      // provider configs can coexist.
      const prev = process.env.OPENAI_API_KEY;
      if (cfg.api_key) process.env.OPENAI_API_KEY = cfg.api_key;
      try {
        const codex = new Codex();
        const thread = codex.startThread();
        const prompt = renderPrompt(system, messages);
        const result = await thread.run(prompt);
        const anyResult = result as { finalResponse?: unknown };
        const text = typeof anyResult.finalResponse === "string" ? anyResult.finalResponse : "";
        return { text, tool_calls: [] };
      } finally {
        if (prev === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prev;
      }
    },
  };
}

function renderPrompt(system: string, messages: Msg[]): string {
  const parts: string[] = [];
  if (system.trim().length) parts.push(`# System\n${system}`);
  for (const m of messages) parts.push(`# ${m.role}\n${m.content}`);
  return parts.join("\n\n");
}
