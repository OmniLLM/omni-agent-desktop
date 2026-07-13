/**
 * GitHub Copilot model → API shape mapping. Ported from omni-pilot's
 * `copilot-model-shapes.mjs`.
 *
 * Copilot exposes two request shapes for chat-style traffic:
 *   * OpenAI Chat Completions  (POST /chat/completions)
 *   * OpenAI Responses         (POST /responses)
 *
 * Each model is served by ONE OR BOTH of these endpoints. Sending a request to
 * the wrong endpoint yields:
 *
 *   HTTP 400 { "error": { "code": "unsupported_api_for_model",
 *              "message": "model \"gpt-5.6-terra\" is not accessible via the
 *                          /chat/completions endpoint" } }
 *
 * The map below is a snapshot of Copilot's `/models` response. It lets us route
 * to the correct endpoint on the first request. For any model NOT in the map
 * (e.g. a brand-new model), a family heuristic mirrors the omni-pilot rule.
 *
 * Values:
 *   'responses' — model MUST be reached at POST /responses
 *   'chat'      — model MUST or MAY be reached at POST /chat/completions
 */

type CopilotShape = "chat" | "responses" | "messages" | "gemini";

const COPILOT_MODEL_SHAPES: Readonly<Record<string, CopilotShape>> =
  Object.freeze({
    // Anthropic models on Copilot — chat-completions compatible
    "claude-opus-4.6": "chat",
    "claude-opus-4.7": "chat",
    "claude-opus-4.8": "chat",
    "claude-sonnet-4.5": "chat",
    "claude-sonnet-4.6": "chat",
    "claude-sonnet-5": "chat",
    "claude-haiku-4.5": "chat",

    // Google models on Copilot
    "gemini-2.5-pro": "chat",
    "gemini-3-flash-preview": "chat",
    "gemini-3.1-pro-preview": "chat",
    "gemini-3.5-flash": "chat",

    // OpenAI GPT-5 family on Copilot
    // gpt-5.4 supports BOTH endpoints; we prefer chat for compatibility.
    "gpt-5.4": "chat",
    // gpt-5-mini supports BOTH endpoints; we prefer chat.
    "gpt-5-mini": "chat",
    // Responses-only models — sending them to /chat/completions produces
    // `unsupported_api_for_model`.
    "gpt-5.3-codex": "responses",
    "gpt-5.4-mini": "responses",
    "gpt-5.5": "responses",

    // Microsoft AI models on Copilot — responses-only
    "mai-code-1-flash-picker": "responses",

    // Classic OpenAI models — chat-completions
    "gpt-3.5-turbo": "chat",
    "gpt-3.5-turbo-0613": "chat",
    "gpt-4": "chat",
    "gpt-4-0125-preview": "chat",
    "gpt-4-0613": "chat",
    "gpt-4-o-preview": "chat",
    "gpt-4.1": "chat",
    "gpt-4.1-2025-04-14": "chat",
    "gpt-41-copilot": "chat",
    "gpt-4o": "chat",
    "gpt-4o-2024-05-13": "chat",
    "gpt-4o-2024-08-06": "chat",
    "gpt-4o-2024-11-20": "chat",
    "gpt-4o-mini": "chat",
    "gpt-4o-mini-2024-07-18": "chat",

    // Utility
    "trajectory-compaction": "chat",
  });

/** True when `model` is a member of the GPT-5 family (`gpt-5`, `gpt-5.4`,
 * `gpt-5-mini`, `gpt-5.3-codex`, `gpt-5o`, …). Matches the omnillm rule. */
export function isCopilotGpt5Family(model: string): boolean {
  return /^gpt-5(\.|-|o|$)/i.test(String(model || "").trim());
}

/**
 * Returns the API shape for a Copilot model.
 *
 * Priority:
 *   1. Exact map lookup (case-insensitive) — ground truth from Copilot's
 *      `/models` `supported_endpoints`.
 *   2. Fallback heuristic on the raw model name (for models not yet in the
 *      snapshot):
 *        - name contains 'claude' → 'messages'
 *        - name contains 'gemini' → 'gemini'
 *        - name contains 'mai' or 'gpt' → 'responses'
 *        - anything else → 'chat'
 */
export function selectCopilotShape(model: string): CopilotShape {
  const raw = String(model || "").trim();
  if (!raw) return "chat";
  const key = raw.toLowerCase();

  const mapped = COPILOT_MODEL_SHAPES[key];
  if (mapped) return mapped;

  // Fallback heuristic by substring on the LOWERCASE model name. Order
  // matters: check 'claude' first so a hypothetical "claude-gpt-relay" isn't
  // swallowed by the gpt rule.
  if (key.includes("claude")) return "messages";
  if (key.includes("gemini")) return "gemini";
  if (key.includes("mai") || key.includes("gpt")) return "responses";

  return "chat";
}

/**
 * True when the model MUST be reached at Copilot's /responses endpoint. A
 * shape of 'messages' or 'gemini' does NOT count as responses-only — those
 * fall back to chat-completions until their endpoints are wired up.
 */
export function isCopilotResponsesOnlyModel(model: string): boolean {
  return selectCopilotShape(model) === "responses";
}

export { COPILOT_MODEL_SHAPES };
export type { CopilotShape };
