export type RunMode = "plan" | "ask" | "autopilot";

export interface ChatMessage {
  role: "user" | "assistant" | "thinking";
  content: string;
  tools_used?: string[];
  isStreaming?: boolean;
  /** For role "thinking": the kind of trace entry, used for iconography. */
  kind?: "thought" | "action" | "result";
}

/** Transitional alias for components still importing the old name. */
export type ConversationTurn = ChatMessage;

/** Summary of a persisted conversation session, from `list_sessions`. */
export interface SessionInfo {
  id: string;
  title: string;
  message_count: number;
}

export interface A2aConnection {
  id: string;
  name: string;
  endpoint: string;
  token: string;
  enabled: boolean;
  disabled_skills: string[];
}

export interface ToolCallEvent {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
}

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

export interface AppSettings {
  ai_base_url: string;
  ai_model: string;
  ai_api_key: string;
  /** Active provider chosen in Preferences. Defaults to the migrated
   * custom-provider profile derived from the legacy flat AI fields. */
  active_provider: ProviderType;
  /** Independent saved profile for every provider type. Compatibility
   * consumers still read the flat `ai_*` fields, which mirror the active
   * provider's effective values on save. */
  provider_configs: Record<ProviderType, ProviderConfig>;
  ai_timeout_secs: number;
  ai_max_tool_iterations: number;
  ai_max_retry_attempts: number;
  ai_retry_base_delay_ms: number;
  /** When true (default), the agentic tool loop halts after detecting three
   * identical (request, result) iterations in a row. */
  ai_loop_detector_enabled: boolean;
  theme: string;
  hotkey: string;
  max_results: number;
  background_url: string;
  /** Configured A2A agents/hubs whose enabled skills become callable tools. */
  a2a_connections: A2aConnection[];
  /** Default run mode for the agent loop. */
  run_mode: RunMode;
  /** Deprecated compatibility field. Desktop no longer connects to the
   * OmniLauncher REST backend; task/tool execution uses A2A endpoints. */
  backend_url: string;
}

