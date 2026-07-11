export interface QueryResult {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  score: number;
  action_type: string;
  action_data: string;
  source?: string;
}

export interface AiResponse {
  content: string;
  tools_used: string[];
  results: QueryResult[];
  is_ai: boolean;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  tools_used?: string[];
  isStreaming?: boolean;
}

export interface AiSessionInfo {
  id: number;
  title: string;
  created_at: string;
  last_active_at: string;
  message_count: number;
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
   * identical (request, result) iterations in a row. Disable for advanced
   * debugging of long multi-step skills — `ai_max_tool_iterations` is still
   * the upper bound. */
  ai_loop_detector_enabled: boolean;
  theme: string;
  hotkey: string;
  max_results: number;
  background_url: string;
  /** Deprecated compatibility field. Desktop no longer connects to the
   * OmniLauncher REST backend; task/tool execution uses A2A endpoints. */
  backend_url: string;
}

export interface PluginInfo {
  name: string;
  description: string;
  version: string;
  keyword?: string;
  icon?: string;
  entry: string;
  dir_name: string;
}

export interface RuntimeDependency {
  id: string;
  label: string;
  installed: boolean;
  installable: boolean;
  install_command?: string | null;
  detail: string;
}

export interface RuntimeProgressEvent {
  id: string;
  label: string;
  message: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  version: string;
  triggers: string[];
  tags: string[];
  tools_hint: string[];
  path: string;
}
