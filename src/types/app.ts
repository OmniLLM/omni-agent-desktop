export type RunMode = "plan" | "ask" | "autopilot";

/** Image attached to a user turn. `data_url` is deliberately provider-neutral;
 * the sidecar converts it to each provider's native multimodal content shape. */
export interface ImageAttachment {
  id: string;
  data_url: string;
  mime_type: string;
  name: string;
}

export interface ChatMessage {
  /** "system" turns are local UI notices (e.g. slash-command acknowledgments).
   * They render inline but are excluded from the model context by
   * `conversationHistory`, so they never round-trip to the provider. */
  role: "user" | "assistant" | "thinking" | "system";
  content: string;
  images?: ImageAttachment[];
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

/** How often a scheduled task recurs. Serializes to the exact strings the Rust
 * `Cadence` enum and legacy JSON already use. */
export type Cadence = "Hourly" | "Daily" | "Weekly";

/** The outcome of the most recent run for a scheduled task. Mirrors the Rust
 * `RunStatus` enum. */
export type RunStatus =
  | "Idle"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Cancelled";

/** A persisted scheduled task, mirroring the Rust `ScheduledTask`. All
 * timestamps are Unix seconds. */
export interface ScheduledTask {
  id: string;
  prompt: string;
  cadence: Cadence;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  next_run_at: number;
  last_run_at: number | null;
  last_status: RunStatus;
  last_error: string | null;
}

/** A status event emitted on `scheduler://status` when a task starts, succeeds,
 * or fails. Carries only non-secret, bounded fields. Mirrors the Rust
 * `StatusEvent`. */
export interface SchedulerStatusEvent {
  id: string;
  status: RunStatus;
  last_run_at: number | null;
  next_run_at: number;
  last_error: string | null;
}

export type ProviderType =
  | "custom-provider"
  | "github-copilot"
  | "azure-foundry";

export type ApiShape =
  | "openai-compatible"
  | "anthropic-messages"
  | "openai-responses";

export type WindowSizePreset = "compact" | "standard" | "large" | "custom";

/** Public, frontend-safe GitHub Copilot authentication status. Mirrors the
 * Rust `CopilotAuthStatus` (serde tag = "state"). Never carries a token. */
export type CopilotAuthStatus =
  | { state: "disconnected" }
  | {
      state: "awaiting_user";
      flow_id: string;
      user_code: string;
      verification_uri: string;
      expires_at: number;
    }
  | { state: "connected"; login: string }
  | { state: "expired" }
  | { state: "cancelled" }
  | { state: "error"; message: string };

/** The request shape a Copilot model supports. */
export type CopilotEndpoint = "chat_completions" | "responses";

/** A discovered Copilot model plus its capability routing. */
export interface CopilotModel {
  id: string;
  supported_endpoints: string[];
  endpoint: CopilotEndpoint;
}

/** A single Azure Foundry mapping from a logical model name to the concrete
 * deployment name. Non-secret; safe to persist and mirror in settings. */
export interface AzureDeploymentMapping {
  model: string;
  deployment: string;
}

export interface ProviderConfig {
  endpoint: string;
  /** Non-secret providers only (custom provider). For protected providers
   * (Azure Foundry, GitHub Copilot) the secret lives in the OS credential
   * store; this field is ALWAYS blank in the frontend view and in persisted
   * settings. The frontend never receives the secret value. */
  api_key: string;
  /** Non-secret presence flag: true when a protected credential exists in the
   * credential store. Lets the UI show "key configured" without the value.
   * Optional/false when no credential is stored. */
  api_key_stored?: boolean;
  api_shape: ApiShape;
  model: string;
  /** Authoritative Azure model→deployment mappings. Optional in JSON (serde
   * default on the Rust side); treat absence as an empty list. */
  azure_deployments?: AzureDeploymentMapping[];
  /** Azure REST API version, e.g. "2024-02-01". Non-secret. Optional in JSON. */
  azure_api_version?: string;
  /** Legacy free-text deployment list. Migration input only; not the
   * authoritative Azure contract. */
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
  /** Enables mouse-drag region OCR through Ctrl/Cmd+Shift+T and /select. */
  screen_text_selection_enabled: boolean;
  /** How long to poll an A2A task for a terminal result before giving up, in
   * seconds. Distinct from `ai_timeout_secs` (the provider HTTP timeout) —
   * delegated A2A skills can run far longer than a single model request. */
  a2a_timeout_secs: number;
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
  /** Persisted window size preset applied at startup and via Preferences. */
  window_size: WindowSizePreset;
  /** Custom window width in logical pixels; used when `window_size === "custom"`. */
  window_size_custom_width?: number;
  /** Custom window height in logical pixels; used when `window_size === "custom"`. */
  window_size_custom_height?: number;
}

