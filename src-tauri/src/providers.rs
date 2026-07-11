//! Native provider client: endpoint normalization, request construction,
//! response parsing, error normalization/redaction, model discovery, and
//! provider-specific (GitHub Copilot / Azure) routing.
//!
//! Pure functions (URL/header/body building, parsing, classification,
//! redaction, routing heuristics) are unit-tested without any I/O. Networking
//! (`discover_custom_models`, `list_provider_models`) is exercised by mock-HTTP
//! integration tests against a local `TcpListener`.
//!
//! Secrets never appear in returned diagnostics: header maps are redacted and
//! error bodies are truncated after secret redaction.
//!
//! Some request-building, parsing, and Copilot-routing helpers below are the
//! typed interface the native AI runtime (a later task) will consume; they are
//! fully unit-tested here but not yet called from a Tauri command, so the
//! module opts out of dead-code warnings.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::settings::{parse_manual_models, ApiShape, ProviderConfig, ProviderType};

const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u32 = 4096;
const REDACTED: &str = "<redacted>";
const MAX_ERROR_BODY: usize = 300;

// ---------------------------------------------------------------------------
// Endpoint normalization
// ---------------------------------------------------------------------------

/// Normalize a configured base URL:
/// - trim surrounding whitespace and trailing `/`,
/// - append `/v1` only when the URL has no path component,
/// - never duplicate `/v1` or any existing provider-specific path segment.
pub fn normalize_endpoint(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    let after_scheme = match trimmed.find("://") {
        Some(i) => &trimmed[i + 3..],
        None => trimmed,
    };
    let has_path = after_scheme.contains('/');
    if has_path {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

/// Per-shape chat/completions request path appended to the normalized endpoint.
pub fn request_url(normalized_endpoint: &str, shape: ApiShape) -> String {
    let base = normalized_endpoint.trim_end_matches('/');
    match shape {
        ApiShape::OpenaiCompatible => format!("{base}/chat/completions"),
        ApiShape::AnthropicMessages => format!("{base}/messages"),
        ApiShape::OpenaiResponses => format!("{base}/responses"),
    }
}

/// Model-discovery URL for a normalized endpoint.
pub fn models_url(normalized_endpoint: &str) -> String {
    format!("{}/models", normalized_endpoint.trim_end_matches('/'))
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/// Auth + content headers for a shape. Anthropic uses `x-api-key` plus a
/// version header; everything else uses bearer authorization.
pub fn build_headers(shape: ApiShape, api_key: &str) -> Vec<(String, String)> {
    let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
    match shape {
        ApiShape::AnthropicMessages => {
            headers.push(("x-api-key".to_string(), api_key.to_string()));
            headers.push((
                "anthropic-version".to_string(),
                ANTHROPIC_VERSION.to_string(),
            ));
        }
        _ => {
            headers.push(("authorization".to_string(), format!("Bearer {api_key}")));
        }
    }
    headers
}

/// Header names whose values carry secrets and must be redacted in diagnostics.
fn is_secret_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "authorization" || lower == "x-api-key" || lower.contains("token")
}

/// Return a copy of `headers` with secret-bearing values replaced by a marker.
pub fn redact_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(k, v)| {
            if is_secret_header(k) {
                (k.clone(), REDACTED.to_string())
            } else {
                (k.clone(), v.clone())
            }
        })
        .collect()
}

/// Replace any occurrence of a known secret with a marker, then truncate to at
/// most `MAX_ERROR_BODY` characters for safe logging.
pub fn redact_secrets(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if !secret.is_empty() {
            out = out.replace(secret, REDACTED);
        }
    }
    if out.chars().count() > MAX_ERROR_BODY {
        out.chars().take(MAX_ERROR_BODY).collect()
    } else {
        out
    }
}

// ---------------------------------------------------------------------------
// Copilot / Azure model routing heuristics
// ---------------------------------------------------------------------------

/// Which Copilot request endpoint a model targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopilotRequestKind {
    Chat,
    Responses,
}

/// Known Copilot models that require the Responses API.
const COPILOT_RESPONSES_MODELS: &[&str] = &["gpt-5", "o3", "o3-mini", "o4-mini"];

/// Decide whether a Copilot model uses `/responses` or `/chat/completions`.
/// Known models come from an explicit map; new models fall through to
/// conservative family heuristics (reasoning `o*`/`gpt-5*` families).
pub fn copilot_request_kind(model: &str) -> CopilotRequestKind {
    let m = model.to_ascii_lowercase();
    if COPILOT_RESPONSES_MODELS.iter().any(|k| m == *k) {
        return CopilotRequestKind::Responses;
    }
    if m.starts_with("gpt-5") || m.starts_with("o3") || m.starts_with("o4") {
        return CopilotRequestKind::Responses;
    }
    CopilotRequestKind::Chat
}

/// Whether a model belongs to a reasoning family (uses `max_completion_tokens`).
pub fn is_reasoning_family(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
        || m.starts_with("gpt-5")
}

/// Token-limit parameter name for a given model. Reasoning families (and Azure
/// Foundry `gpt-5.4`) use `max_completion_tokens`; compatible older chat models
/// use `max_tokens`.
pub fn token_limit_param(model: &str) -> &'static str {
    if is_reasoning_family(model) {
        "max_completion_tokens"
    } else {
        "max_tokens"
    }
}

// ---------------------------------------------------------------------------
// Normalized request inputs / built request
// ---------------------------------------------------------------------------

/// A normalized conversation message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedMessage {
    pub role: String,
    pub content: String,
}

impl NormalizedMessage {
    pub fn new(role: &str, content: &str) -> Self {
        Self {
            role: role.to_string(),
            content: content.to_string(),
        }
    }
}

/// A normalized tool declaration (name/description/JSON schema parameters).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// Everything the native runtime needs to issue one provider request.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltRequest {
    pub shape: ApiShape,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl BuiltRequest {
    /// Redacted view of the headers for logging.
    pub fn redacted_headers(&self) -> Vec<(String, String)> {
        redact_headers(&self.headers)
    }
}

/// Build a provider request for a Custom-provider config from normalized
/// messages, an optional system prompt, and optional tools.
pub fn build_custom_request(
    config: &ProviderConfig,
    messages: &[NormalizedMessage],
    system: Option<&str>,
    tools: &[NormalizedTool],
) -> BuiltRequest {
    let endpoint = normalize_endpoint(&config.endpoint);
    let url = request_url(&endpoint, config.api_shape);
    let headers = build_headers(config.api_shape, &config.api_key);
    let body = match config.api_shape {
        ApiShape::OpenaiCompatible => {
            build_chat_body(&config.model, messages, system, tools)
        }
        ApiShape::AnthropicMessages => {
            build_anthropic_body(&config.model, messages, system, tools)
        }
        ApiShape::OpenaiResponses => {
            build_responses_body(&config.model, messages, system, tools)
        }
    };
    BuiltRequest {
        shape: config.api_shape,
        url,
        headers,
        body,
    }
}

/// OpenAI Chat Completions body. The system prompt is prepended as a `system`
/// message. Uses the model-appropriate token-limit parameter.
pub fn build_chat_body(
    model: &str,
    messages: &[NormalizedMessage],
    system: Option<&str>,
    tools: &[NormalizedTool],
) -> Value {
    let mut msgs: Vec<Value> = Vec::new();
    if let Some(sys) = system {
        if !sys.is_empty() {
            msgs.push(json!({ "role": "system", "content": sys }));
        }
    }
    for m in messages {
        msgs.push(json!({ "role": m.role, "content": m.content }));
    }
    let mut body = json!({
        "model": model,
        "messages": msgs,
        token_limit_param(model): DEFAULT_MAX_TOKENS,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|t| json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            }))
            .collect::<Vec<_>>());
    }
    body
}

/// Anthropic Messages body. The system prompt is a top-level `system` string;
/// Anthropic requires `max_tokens`.
pub fn build_anthropic_body(
    model: &str,
    messages: &[NormalizedMessage],
    system: Option<&str>,
    tools: &[NormalizedTool],
) -> Value {
    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({
        "model": model,
        "messages": msgs,
        "max_tokens": DEFAULT_MAX_TOKENS,
    });
    if let Some(sys) = system {
        if !sys.is_empty() {
            body["system"] = json!(sys);
        }
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|t| json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            }))
            .collect::<Vec<_>>());
    }
    body
}

/// OpenAI Responses body. The system prompt maps to `instructions`; messages
/// map to `input` items.
pub fn build_responses_body(
    model: &str,
    messages: &[NormalizedMessage],
    system: Option<&str>,
    tools: &[NormalizedTool],
) -> Value {
    let input: Vec<Value> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({
        "model": model,
        "input": input,
        token_limit_param(model): DEFAULT_MAX_TOKENS,
    });
    if let Some(sys) = system {
        if !sys.is_empty() {
            body["instructions"] = json!(sys);
        }
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|t| json!({
                "type": "function",
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            }))
            .collect::<Vec<_>>());
    }
    body
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/// A normalized tool-call extracted from a provider response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments string as returned by the provider.
    pub arguments: String,
}

/// A normalized non-streaming response: assistant text plus any tool calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

/// Parse an OpenAI Chat Completions non-streaming response.
pub fn parse_chat_response(json: &Value) -> Result<ParsedResponse, ProviderError> {
    let message = json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .ok_or_else(|| ProviderError::malformed("missing choices[0].message"))?;
    let text = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let mut tool_calls = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(|t| t.as_array()) {
        for call in calls {
            let function = call.get("function");
            tool_calls.push(ToolCall {
                id: call
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                name: function
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                arguments: function
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }
    Ok(ParsedResponse { text, tool_calls })
}

/// Parse an Anthropic Messages non-streaming response (`content[]` blocks).
pub fn parse_anthropic_response(json: &Value) -> Result<ParsedResponse, ProviderError> {
    let blocks = json
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| ProviderError::malformed("missing content array"))?;
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    text.push_str(t);
                }
            }
            Some("tool_use") => {
                tool_calls.push(ToolCall {
                    id: block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    name: block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    arguments: block
                        .get("input")
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "{}".to_string()),
                });
            }
            _ => {}
        }
    }
    Ok(ParsedResponse { text, tool_calls })
}

/// Parse an OpenAI Responses non-streaming response (`output[]` items, with a
/// fallback to a top-level `output_text` string).
pub fn parse_responses_response(json: &Value) -> Result<ParsedResponse, ProviderError> {
    let mut text = String::new();
    let mut tool_calls = Vec::new();

    if let Some(items) = json.get("output").and_then(|o| o.as_array()) {
        for item in items {
            match item.get("type").and_then(|t| t.as_str()) {
                Some("message") => {
                    if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                        for part in content {
                            if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                                text.push_str(t);
                            }
                        }
                    }
                }
                Some("function_call") => {
                    tool_calls.push(ToolCall {
                        id: item
                            .get("call_id")
                            .or_else(|| item.get("id"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        name: item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        arguments: item
                            .get("arguments")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    });
                }
                _ => {}
            }
        }
        return Ok(ParsedResponse { text, tool_calls });
    }

    if let Some(t) = json.get("output_text").and_then(|v| v.as_str()) {
        return Ok(ParsedResponse {
            text: t.to_string(),
            tool_calls,
        });
    }

    Err(ProviderError::malformed("missing output array"))
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/// Actionable provider-error categories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderErrorKind {
    Auth,
    RateLimit,
    Unsupported,
    Network,
    Malformed,
}

/// A normalized, redaction-safe provider error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderError {
    pub kind: ProviderErrorKind,
    pub message: String,
}

impl ProviderError {
    pub fn new(kind: ProviderErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    pub fn auth(m: impl Into<String>) -> Self {
        Self::new(ProviderErrorKind::Auth, m)
    }
    pub fn rate_limit(m: impl Into<String>) -> Self {
        Self::new(ProviderErrorKind::RateLimit, m)
    }
    pub fn unsupported(m: impl Into<String>) -> Self {
        Self::new(ProviderErrorKind::Unsupported, m)
    }
    pub fn network(m: impl Into<String>) -> Self {
        Self::new(ProviderErrorKind::Network, m)
    }
    pub fn malformed(m: impl Into<String>) -> Self {
        Self::new(ProviderErrorKind::Malformed, m)
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

/// Classify a non-2xx HTTP status + response body into a normalized error.
/// `secrets` are redacted from the truncated body before it is stored.
pub fn classify_http_status(status: u16, body: &str, secrets: &[&str]) -> ProviderError {
    let redacted = redact_secrets(body, secrets);
    let kind = match status {
        401 | 403 => ProviderErrorKind::Auth,
        429 => ProviderErrorKind::RateLimit,
        400 | 404 | 422 => ProviderErrorKind::Unsupported,
        _ => ProviderErrorKind::Malformed,
    };
    ProviderError::new(kind, format!("HTTP {status}: {redacted}"))
}

// ---------------------------------------------------------------------------
// Model discovery parsing
// ---------------------------------------------------------------------------

/// Parse a `/models` response, accepting either `data[].id` (OpenAI) or
/// `models[].name` (alternate) shapes. De-duplicates while keeping order.
pub fn parse_models_list(json: &Value) -> Result<Vec<String>, ProviderError> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut push = |id: &str| {
        let trimmed = id.trim();
        if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
            out.push(trimmed.to_string());
        }
    };

    if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
        for item in data {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                push(id);
            }
        }
    }
    if let Some(models) = json.get("models").and_then(|m| m.as_array()) {
        for item in models {
            let name = item
                .get("name")
                .or_else(|| item.get("id"))
                .and_then(|v| v.as_str());
            if let Some(name) = name {
                push(name);
            }
        }
    }

    if out.is_empty() {
        return Err(ProviderError::malformed(
            "no models found in data[].id or models[].name",
        ));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Networking: model discovery
// ---------------------------------------------------------------------------

/// Discover models for a Custom-provider draft config by GETting the normalized
/// `/models` endpoint with shape-appropriate auth. Failures are normalized and
/// redaction-safe.
pub async fn discover_custom_models(
    client: &reqwest::Client,
    config: &ProviderConfig,
) -> Result<Vec<String>, ProviderError> {
    let endpoint = normalize_endpoint(&config.endpoint);
    let url = models_url(&endpoint);
    let headers = build_headers(config.api_shape, &config.api_key);

    let mut request = client.get(&url);
    for (k, v) in &headers {
        request = request.header(k, v);
    }

    let response = request
        .send()
        .await
        .map_err(|e| ProviderError::network(redact_secrets(&e.to_string(), &[&config.api_key])))?;

    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| ProviderError::network(redact_secrets(&e.to_string(), &[&config.api_key])))?;

    if !(200..300).contains(&status) {
        return Err(classify_http_status(status, &body, &[&config.api_key]));
    }

    let value: Value = serde_json::from_str(&body).map_err(|e| {
        ProviderError::malformed(redact_secrets(&e.to_string(), &[&config.api_key]))
    })?;
    parse_models_list(&value)
}

// ---------------------------------------------------------------------------
// list_provider_models: typed command core
// ---------------------------------------------------------------------------

/// Result of a provider model listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderModelsResult {
    pub models: Vec<String>,
}

/// Core of the `list_provider_models` command, independent of Tauri. Custom
/// discovery hits the network; Azure returns the normalized manual list
/// locally; Copilot returns an actionable disconnected error until the auth
/// module is wired up.
pub async fn list_provider_models_core(
    client: &reqwest::Client,
    provider_type: ProviderType,
    draft_config: &ProviderConfig,
) -> Result<ProviderModelsResult, ProviderError> {
    match provider_type {
        ProviderType::CustomProvider => {
            let models = discover_custom_models(client, draft_config).await?;
            Ok(ProviderModelsResult { models })
        }
        ProviderType::AzureFoundry => Ok(ProviderModelsResult {
            models: parse_manual_models(&draft_config.manual_models),
        }),
        ProviderType::GithubCopilot => Err(ProviderError::auth(
            "GitHub Copilot is not connected. Sign in before listing models.",
        )),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    // --- Endpoint normalization -------------------------------------------

    #[test]
    fn normalize_adds_v1_when_no_path() {
        assert_eq!(
            normalize_endpoint("https://api.example.com"),
            "https://api.example.com/v1"
        );
        assert_eq!(
            normalize_endpoint("https://api.example.com/"),
            "https://api.example.com/v1"
        );
        assert_eq!(
            normalize_endpoint("  https://api.example.com///  "),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn normalize_keeps_existing_path_and_never_duplicates() {
        assert_eq!(
            normalize_endpoint("https://api.example.com/v1"),
            "https://api.example.com/v1"
        );
        assert_eq!(
            normalize_endpoint("https://api.example.com/v1/"),
            "https://api.example.com/v1"
        );
        assert_eq!(
            normalize_endpoint("https://api.example.com/openai/v1"),
            "https://api.example.com/openai/v1"
        );
    }

    #[test]
    fn request_urls_per_shape() {
        let e = "https://api.example.com/v1";
        assert_eq!(
            request_url(e, ApiShape::OpenaiCompatible),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            request_url(e, ApiShape::AnthropicMessages),
            "https://api.example.com/v1/messages"
        );
        assert_eq!(
            request_url(e, ApiShape::OpenaiResponses),
            "https://api.example.com/v1/responses"
        );
        assert_eq!(models_url(e), "https://api.example.com/v1/models");
    }

    // --- Headers & redaction ----------------------------------------------

    #[test]
    fn anthropic_headers_use_x_api_key_and_version() {
        let h = build_headers(ApiShape::AnthropicMessages, "sk-secret");
        assert!(h.contains(&("x-api-key".to_string(), "sk-secret".to_string())));
        assert!(h.contains(&("anthropic-version".to_string(), ANTHROPIC_VERSION.to_string())));
        assert!(!h.iter().any(|(k, _)| k == "authorization"));
    }

    #[test]
    fn openai_headers_use_bearer() {
        let h = build_headers(ApiShape::OpenaiCompatible, "sk-secret");
        assert!(h.contains(&("authorization".to_string(), "Bearer sk-secret".to_string())));
        let r = build_headers(ApiShape::OpenaiResponses, "sk-secret");
        assert!(r.contains(&("authorization".to_string(), "Bearer sk-secret".to_string())));
    }

    #[test]
    fn redact_headers_masks_secret_values() {
        let h = build_headers(ApiShape::OpenaiCompatible, "sk-secret");
        let red = redact_headers(&h);
        assert!(red.contains(&("authorization".to_string(), REDACTED.to_string())));
        // content-type is preserved.
        assert!(red.contains(&("content-type".to_string(), "application/json".to_string())));
        // x-api-key path
        let a = redact_headers(&build_headers(ApiShape::AnthropicMessages, "sk-x"));
        assert!(a.contains(&("x-api-key".to_string(), REDACTED.to_string())));
    }

    #[test]
    fn redact_secrets_replaces_and_truncates() {
        let text = "error with key sk-secret in body".to_string();
        let red = redact_secrets(&text, &["sk-secret"]);
        assert!(!red.contains("sk-secret"));
        assert!(red.contains(REDACTED));
        let long = "x".repeat(500);
        assert_eq!(redact_secrets(&long, &[]).chars().count(), MAX_ERROR_BODY);
    }

    // --- Copilot / Azure routing ------------------------------------------

    #[test]
    fn copilot_known_responses_models_route_to_responses() {
        assert_eq!(copilot_request_kind("gpt-5"), CopilotRequestKind::Responses);
        assert_eq!(copilot_request_kind("o3-mini"), CopilotRequestKind::Responses);
        assert_eq!(copilot_request_kind("o4-mini"), CopilotRequestKind::Responses);
    }

    #[test]
    fn copilot_chat_models_route_to_chat() {
        assert_eq!(copilot_request_kind("gpt-4o"), CopilotRequestKind::Chat);
        assert_eq!(copilot_request_kind("gpt-4"), CopilotRequestKind::Chat);
        assert_eq!(
            copilot_request_kind("claude-3.5-sonnet"),
            CopilotRequestKind::Chat
        );
    }

    #[test]
    fn copilot_new_model_family_heuristic() {
        // Unknown gpt-5 family falls through to Responses.
        assert_eq!(
            copilot_request_kind("gpt-5.4-turbo"),
            CopilotRequestKind::Responses
        );
    }

    #[test]
    fn token_limit_param_rules() {
        assert_eq!(token_limit_param("gpt-4o"), "max_tokens");
        assert_eq!(token_limit_param("gpt-3.5-turbo"), "max_tokens");
        assert_eq!(token_limit_param("o1-preview"), "max_completion_tokens");
        assert_eq!(token_limit_param("o3-mini"), "max_completion_tokens");
        // Azure Foundry gpt-5.4 behavior.
        assert_eq!(token_limit_param("gpt-5.4"), "max_completion_tokens");
    }

    // --- Request bodies ----------------------------------------------------

    fn msgs() -> Vec<NormalizedMessage> {
        vec![NormalizedMessage::new("user", "hello")]
    }

    fn cfg(shape: ApiShape, model: &str) -> ProviderConfig {
        ProviderConfig {
            endpoint: "https://api.example.com".to_string(),
            api_key: "sk-secret".to_string(),
            api_shape: shape,
            model: model.to_string(),
            manual_models: String::new(),
        }
    }

    #[test]
    fn chat_body_prepends_system_and_uses_max_tokens() {
        let body = build_chat_body("gpt-4o", &msgs(), Some("be nice"), &[]);
        let arr = body["messages"].as_array().unwrap();
        assert_eq!(arr[0]["role"], "system");
        assert_eq!(arr[0]["content"], "be nice");
        assert_eq!(arr[1]["role"], "user");
        assert!(body.get("max_tokens").is_some());
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn chat_body_reasoning_uses_max_completion_tokens() {
        let body = build_chat_body("o3-mini", &msgs(), None, &[]);
        assert!(body.get("max_completion_tokens").is_some());
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn anthropic_body_uses_system_field_and_max_tokens() {
        let body = build_anthropic_body("claude", &msgs(), Some("sys"), &[]);
        assert_eq!(body["system"], "sys");
        assert!(body.get("max_tokens").is_some());
        // No system message injected into messages array.
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn responses_body_uses_instructions_and_input() {
        let body = build_responses_body("gpt-4o", &msgs(), Some("sys"), &[]);
        assert_eq!(body["instructions"], "sys");
        assert!(body.get("input").is_some());
    }

    #[test]
    fn build_custom_request_routes_url_and_headers() {
        let req = build_custom_request(&cfg(ApiShape::AnthropicMessages, "claude"), &msgs(), None, &[]);
        assert_eq!(req.url, "https://api.example.com/v1/messages");
        assert!(req
            .headers
            .iter()
            .any(|(k, _)| k == "x-api-key"));
        // Redacted view hides the secret.
        assert!(req
            .redacted_headers()
            .iter()
            .any(|(k, v)| k == "x-api-key" && v == REDACTED));
    }

    #[test]
    fn tools_included_per_shape() {
        let tool = NormalizedTool {
            name: "calc".to_string(),
            description: "adds".to_string(),
            parameters: json!({"type": "object"}),
        };
        let chat = build_chat_body("gpt-4o", &msgs(), None, std::slice::from_ref(&tool));
        assert_eq!(chat["tools"][0]["function"]["name"], "calc");
        let anth = build_anthropic_body("claude", &msgs(), None, std::slice::from_ref(&tool));
        assert_eq!(anth["tools"][0]["name"], "calc");
        assert!(anth["tools"][0]["input_schema"].is_object());
        let resp = build_responses_body("gpt-4o", &msgs(), None, std::slice::from_ref(&tool));
        assert_eq!(resp["tools"][0]["name"], "calc");
    }

    // --- Response parsing --------------------------------------------------

    #[test]
    fn parse_chat_text_and_tool_calls() {
        let json = json!({
            "choices": [{
                "message": {
                    "content": "hi there",
                    "tool_calls": [{
                        "id": "call_1",
                        "function": { "name": "calc", "arguments": "{\"a\":1}" }
                    }]
                }
            }]
        });
        let parsed = parse_chat_response(&json).unwrap();
        assert_eq!(parsed.text, "hi there");
        assert_eq!(parsed.tool_calls.len(), 1);
        assert_eq!(parsed.tool_calls[0].name, "calc");
        assert_eq!(parsed.tool_calls[0].arguments, "{\"a\":1}");
    }

    #[test]
    fn parse_chat_missing_choices_is_malformed() {
        let err = parse_chat_response(&json!({})).unwrap_err();
        assert_eq!(err.kind, ProviderErrorKind::Malformed);
    }

    #[test]
    fn parse_anthropic_text_and_tool_use() {
        let json = json!({
            "content": [
                { "type": "text", "text": "hello " },
                { "type": "text", "text": "world" },
                { "type": "tool_use", "id": "t1", "name": "calc", "input": {"a": 1} }
            ]
        });
        let parsed = parse_anthropic_response(&json).unwrap();
        assert_eq!(parsed.text, "hello world");
        assert_eq!(parsed.tool_calls[0].name, "calc");
        assert_eq!(parsed.tool_calls[0].arguments, "{\"a\":1}");
    }

    #[test]
    fn parse_responses_output_and_function_call() {
        let json = json!({
            "output": [
                { "type": "message", "content": [{ "type": "output_text", "text": "done" }] },
                { "type": "function_call", "call_id": "c1", "name": "calc", "arguments": "{}" }
            ]
        });
        let parsed = parse_responses_response(&json).unwrap();
        assert_eq!(parsed.text, "done");
        assert_eq!(parsed.tool_calls[0].id, "c1");
        assert_eq!(parsed.tool_calls[0].name, "calc");
    }

    #[test]
    fn parse_responses_output_text_fallback() {
        let json = json!({ "output_text": "quick" });
        let parsed = parse_responses_response(&json).unwrap();
        assert_eq!(parsed.text, "quick");
    }

    // --- Error classification ---------------------------------------------

    #[test]
    fn classify_statuses_into_categories() {
        assert_eq!(
            classify_http_status(401, "nope", &[]).kind,
            ProviderErrorKind::Auth
        );
        assert_eq!(
            classify_http_status(403, "nope", &[]).kind,
            ProviderErrorKind::Auth
        );
        assert_eq!(
            classify_http_status(429, "slow", &[]).kind,
            ProviderErrorKind::RateLimit
        );
        assert_eq!(
            classify_http_status(404, "no model", &[]).kind,
            ProviderErrorKind::Unsupported
        );
        assert_eq!(
            classify_http_status(500, "boom", &[]).kind,
            ProviderErrorKind::Malformed
        );
    }

    #[test]
    fn classify_redacts_secret_in_body() {
        let err = classify_http_status(401, "bad key sk-secret", &["sk-secret"]);
        assert!(!err.message.contains("sk-secret"));
        assert!(err.message.contains(REDACTED));
    }

    // --- Models parsing ----------------------------------------------------

    #[test]
    fn parse_models_from_data_id() {
        let json = json!({ "data": [{ "id": "gpt-4" }, { "id": "gpt-3.5" }] });
        assert_eq!(parse_models_list(&json).unwrap(), vec!["gpt-4", "gpt-3.5"]);
    }

    #[test]
    fn parse_models_from_models_name() {
        let json = json!({ "models": [{ "name": "claude-3" }, { "name": "claude-2" }] });
        assert_eq!(
            parse_models_list(&json).unwrap(),
            vec!["claude-3", "claude-2"]
        );
    }

    #[test]
    fn parse_models_dedupes_and_rejects_empty() {
        let json = json!({ "data": [{ "id": "a" }, { "id": "a" }] });
        assert_eq!(parse_models_list(&json).unwrap(), vec!["a"]);
        assert!(parse_models_list(&json!({})).is_err());
    }

    // --- Mock HTTP integration --------------------------------------------

    /// Spawn a one-shot HTTP server returning `status`/`body`. Returns the base
    /// URL (`http://127.0.0.1:PORT`) and captured request text via channel.
    fn spawn_http_once(
        status_line: &'static str,
        body: &'static str,
    ) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let _ = tx.send(request);
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}"), rx)
    }

    fn discovery_cfg(base: &str, shape: ApiShape) -> ProviderConfig {
        ProviderConfig {
            endpoint: base.to_string(),
            api_key: "sk-secret".to_string(),
            api_shape: shape,
            model: String::new(),
            manual_models: String::new(),
        }
    }

    #[tokio::test]
    async fn discover_custom_models_openai_shape() {
        let (base, rx) = spawn_http_once("200 OK", r#"{"data":[{"id":"gpt-4"},{"id":"gpt-4o"}]}"#);
        let client = reqwest::Client::new();
        let models = discover_custom_models(&client, &discovery_cfg(&base, ApiShape::OpenaiCompatible))
            .await
            .unwrap();
        assert_eq!(models, vec!["gpt-4", "gpt-4o"]);
        let request = rx.recv().unwrap();
        // Endpoint had no path, so /v1/models is requested with bearer auth.
        assert!(request.contains("GET /v1/models"));
        assert!(request.to_ascii_lowercase().contains("authorization: bearer sk-secret"));
    }

    #[tokio::test]
    async fn discover_custom_models_anthropic_uses_x_api_key() {
        let (base, rx) = spawn_http_once("200 OK", r#"{"models":[{"name":"claude-3"}]}"#);
        let client = reqwest::Client::new();
        let models = discover_custom_models(&client, &discovery_cfg(&base, ApiShape::AnthropicMessages))
            .await
            .unwrap();
        assert_eq!(models, vec!["claude-3"]);
        let request = rx.recv().unwrap();
        assert!(request.to_ascii_lowercase().contains("x-api-key: sk-secret"));
        assert!(!request.to_ascii_lowercase().contains("authorization: bearer"));
    }

    #[tokio::test]
    async fn discover_custom_models_auth_failure_classified_and_redacted() {
        let (base, _rx) = spawn_http_once("401 Unauthorized", r#"{"error":"bad key sk-secret"}"#);
        let client = reqwest::Client::new();
        let err = discover_custom_models(&client, &discovery_cfg(&base, ApiShape::OpenaiCompatible))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProviderErrorKind::Auth);
        assert!(!err.message.contains("sk-secret"));
    }

    #[tokio::test]
    async fn discover_custom_models_rate_limit_classified() {
        let (base, _rx) = spawn_http_once("429 Too Many Requests", r#"{"error":"slow down"}"#);
        let client = reqwest::Client::new();
        let err = discover_custom_models(&client, &discovery_cfg(&base, ApiShape::OpenaiCompatible))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProviderErrorKind::RateLimit);
    }

    #[tokio::test]
    async fn discover_custom_models_malformed_body() {
        let (base, _rx) = spawn_http_once("200 OK", "not json");
        let client = reqwest::Client::new();
        let err = discover_custom_models(&client, &discovery_cfg(&base, ApiShape::OpenaiCompatible))
            .await
            .unwrap_err();
        assert_eq!(err.kind, ProviderErrorKind::Malformed);
    }

    #[tokio::test]
    async fn list_provider_models_azure_returns_manual_list() {
        let client = reqwest::Client::new();
        let mut config = ProviderConfig::default();
        config.manual_models = "dep1, dep2\n dep1 ".to_string();
        let result = list_provider_models_core(&client, ProviderType::AzureFoundry, &config)
            .await
            .unwrap();
        assert_eq!(result.models, vec!["dep1", "dep2"]);
    }

    #[tokio::test]
    async fn list_provider_models_copilot_disconnected_error() {
        let client = reqwest::Client::new();
        let err = list_provider_models_core(
            &client,
            ProviderType::GithubCopilot,
            &ProviderConfig::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, ProviderErrorKind::Auth);
        assert!(err.message.to_lowercase().contains("not connected"));
    }

    #[tokio::test]
    async fn list_provider_models_custom_discovers() {
        let (base, _rx) = spawn_http_once("200 OK", r#"{"data":[{"id":"m1"}]}"#);
        let client = reqwest::Client::new();
        let result = list_provider_models_core(
            &client,
            ProviderType::CustomProvider,
            &discovery_cfg(&base, ApiShape::OpenaiCompatible),
        )
        .await
        .unwrap();
        assert_eq!(result.models, vec!["m1"]);
    }
}
