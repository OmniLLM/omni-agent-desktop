//! Build provider HTTP requests and parse responses by API shape.

use crate::settings::{ApiShape, ProviderConfig};
use serde_json::{json, Value};

pub struct BuiltRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
    pub shape: ApiShape,
}

/// Normalize an endpoint: strip trailing slashes; append `/v1` only when the URL
/// has no path segment. Never duplicate `/v1`.
pub fn normalize_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    let after_scheme = trimmed.splitn(2, "://").nth(1).unwrap_or(trimmed);
    let has_path = after_scheme.contains('/');
    if has_path {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

/// A normalized chat message.
#[derive(Debug, Clone)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

pub fn build_request(
    config: &ProviderConfig,
    system: &str,
    messages: &[Msg],
    tools: &[Value],
) -> BuiltRequest {
    let base = normalize_endpoint(&config.endpoint);
    match config.api_shape {
        ApiShape::AnthropicMessages => {
            let msgs: Vec<Value> = messages
                .iter()
                .map(|m| json!({"role": m.role, "content": m.content}))
                .collect();
            BuiltRequest {
                url: format!("{base}/messages"),
                headers: vec![
                    ("x-api-key".into(), config.api_key.clone()),
                    ("anthropic-version".into(), "2023-06-01".into()),
                    ("content-type".into(), "application/json".into()),
                ],
                body: json!({"model": config.model, "system": system,
                    "messages": msgs, "max_tokens": 4096}),
                shape: ApiShape::AnthropicMessages,
            }
        }
        ApiShape::OpenaiResponses => {
            let mut input = vec![json!({"role": "system", "content": system})];
            for m in messages {
                input.push(json!({"role": m.role, "content": m.content}));
            }
            BuiltRequest {
                url: format!("{base}/responses"),
                headers: bearer(config),
                body: json!({"model": config.model, "input": input, "tools": tools}),
                shape: ApiShape::OpenaiResponses,
            }
        }
        ApiShape::OpenaiCompatible => {
            let mut msgs = vec![json!({"role": "system", "content": system})];
            for m in messages {
                msgs.push(json!({"role": m.role, "content": m.content}));
            }
            BuiltRequest {
                url: format!("{base}/chat/completions"),
                headers: bearer(config),
                body: json!({"model": config.model, "messages": msgs, "tools": tools}),
                shape: ApiShape::OpenaiCompatible,
            }
        }
    }
}

fn bearer(config: &ProviderConfig) -> Vec<(String, String)> {
    vec![
        (
            "authorization".into(),
            format!("Bearer {}", config.api_key),
        ),
        ("content-type".into(), "application/json".into()),
    ]
}

/// A parsed assistant turn: text plus any tool calls.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedTurn {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

pub fn parse_response(shape: ApiShape, body: &Value) -> ParsedTurn {
    match shape {
        ApiShape::AnthropicMessages => parse_anthropic(body),
        ApiShape::OpenaiResponses => parse_openai_responses(body),
        ApiShape::OpenaiCompatible => parse_openai_chat(body),
    }
}

fn parse_openai_chat(body: &Value) -> ParsedTurn {
    let msg = &body["choices"][0]["message"];
    let text = msg["content"].as_str().unwrap_or("").to_string();
    let mut calls = Vec::new();
    if let Some(arr) = msg["tool_calls"].as_array() {
        for c in arr {
            let name = c["function"]["name"].as_str().unwrap_or("").to_string();
            let raw = c["function"]["arguments"].as_str().unwrap_or("{}");
            let args = serde_json::from_str(raw).unwrap_or(json!({}));
            calls.push(ToolCall {
                id: c["id"].as_str().unwrap_or("").to_string(),
                name,
                args,
            });
        }
    }
    ParsedTurn {
        text,
        tool_calls: calls,
    }
}

/// Parse an OpenAI Responses API result into a [`ParsedTurn`]. Handles the
/// SDK convenience `output_text`, the structured `output[]` array with message
/// items whose `content[]` carries `output_text` parts, and top-level
/// `function_call` items (with `call_id`/`name`/`arguments`). Malformed tool
/// arguments degrade to an empty object rather than failing the turn.
fn parse_openai_responses(body: &Value) -> ParsedTurn {
    let mut text = String::new();
    let mut calls = Vec::new();

    if let Some(arr) = body["output"].as_array() {
        for item in arr {
            match item["type"].as_str() {
                Some("message") => {
                    if let Some(parts) = item["content"].as_array() {
                        for part in parts {
                            // Responses emits `output_text` parts; tolerate a
                            // bare `text` field as well.
                            if let Some(t) = part["text"].as_str() {
                                if part["type"].as_str().unwrap_or("output_text") == "output_text"
                                    || part["type"].is_null()
                                {
                                    text.push_str(t);
                                }
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let name = item["name"].as_str().unwrap_or("").to_string();
                    let raw = item["arguments"].as_str().unwrap_or("{}");
                    let args = serde_json::from_str(raw).unwrap_or(json!({}));
                    let id = item["call_id"]
                        .as_str()
                        .or_else(|| item["id"].as_str())
                        .unwrap_or("")
                        .to_string();
                    calls.push(ToolCall { id, name, args });
                }
                _ => {}
            }
        }
    }

    // Fall back to the top-level convenience field when no message text was
    // assembled from the structured output.
    if text.is_empty() {
        if let Some(t) = body["output_text"].as_str() {
            text.push_str(t);
        }
    }

    ParsedTurn {
        text,
        tool_calls: calls,
    }
}

fn parse_anthropic(body: &Value) -> ParsedTurn {
    let mut text = String::new();
    let mut calls = Vec::new();
    if let Some(arr) = body["content"].as_array() {
        for block in arr {
            match block["type"].as_str() {
                Some("text") => text.push_str(block["text"].as_str().unwrap_or("")),
                Some("tool_use") => calls.push(ToolCall {
                    id: block["id"].as_str().unwrap_or("").to_string(),
                    name: block["name"].as_str().unwrap_or("").to_string(),
                    args: block["input"].clone(),
                }),
                _ => {}
            }
        }
    }
    ParsedTurn {
        text,
        tool_calls: calls,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(shape: ApiShape) -> ProviderConfig {
        ProviderConfig {
            endpoint: "https://api.test.com".into(),
            api_key: "k".into(),
            api_shape: shape,
            model: "m".into(),
            ..ProviderConfig::default()
        }
    }

    #[test]
    fn normalize_adds_v1_only_without_path() {
        assert_eq!(
            normalize_endpoint("https://api.test.com/"),
            "https://api.test.com/v1"
        );
        assert_eq!(
            normalize_endpoint("https://api.test.com/v1"),
            "https://api.test.com/v1"
        );
        assert_eq!(
            normalize_endpoint("https://api.test.com/openai"),
            "https://api.test.com/openai"
        );
    }

    #[test]
    fn openai_request_targets_chat_completions_with_bearer() {
        let r = build_request(&cfg(ApiShape::OpenaiCompatible), "sys", &[], &[]);
        assert_eq!(r.url, "https://api.test.com/v1/chat/completions");
        assert!(r
            .headers
            .iter()
            .any(|(k, v)| k == "authorization" && v == "Bearer k"));
    }

    #[test]
    fn anthropic_request_uses_x_api_key_and_messages() {
        let r = build_request(&cfg(ApiShape::AnthropicMessages), "sys", &[], &[]);
        assert_eq!(r.url, "https://api.test.com/v1/messages");
        assert!(r.headers.iter().any(|(k, v)| k == "x-api-key" && v == "k"));
    }

    #[test]
    fn parse_openai_extracts_text_and_tool_call() {
        let body = json!({"choices":[{"message":{"content":"hi",
            "tool_calls":[{"id":"c1","function":{"name":"read","arguments":"{\"path\":\"x\"}"}}]}}]});
        let t = parse_response(ApiShape::OpenaiCompatible, &body);
        assert_eq!(t.text, "hi");
        assert_eq!(t.tool_calls[0].name, "read");
        assert_eq!(t.tool_calls[0].args["path"], "x");
    }

    #[test]
    fn parse_anthropic_extracts_text_and_tool_use() {
        let body = json!({"content":[{"type":"text","text":"ok"},
            {"type":"tool_use","id":"t1","name":"bash","input":{"command":"ls"}}]});
        let t = parse_response(ApiShape::AnthropicMessages, &body);
        assert_eq!(t.text, "ok");
        assert_eq!(t.tool_calls[0].name, "bash");
        assert_eq!(t.tool_calls[0].args["command"], "ls");
    }

    #[test]
    fn parse_responses_uses_top_level_output_text() {
        // The OpenAI Responses API SDK convenience field.
        let body = json!({"output_text": "hello from responses"});
        let t = parse_response(ApiShape::OpenaiResponses, &body);
        assert_eq!(t.text, "hello from responses");
        assert!(t.tool_calls.is_empty());
    }

    #[test]
    fn parse_responses_extracts_output_message_text() {
        // The structured `output` array with a message item whose content
        // carries `output_text` parts.
        let body = json!({
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "output_text", "text": "part one "},
                        {"type": "output_text", "text": "part two"}
                    ]
                }
            ]
        });
        let t = parse_response(ApiShape::OpenaiResponses, &body);
        assert_eq!(t.text, "part one part two");
        assert!(t.tool_calls.is_empty());
    }

    #[test]
    fn parse_responses_extracts_function_calls() {
        // Responses represents tool calls as top-level `function_call` output
        // items with call_id/name/arguments (arguments is a JSON string).
        let body = json!({
            "output": [
                {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "let me check"}]},
                {"type": "function_call", "call_id": "call_abc",
                 "name": "read", "arguments": "{\"path\":\"/tmp/x\"}"}
            ]
        });
        let t = parse_response(ApiShape::OpenaiResponses, &body);
        assert_eq!(t.text, "let me check");
        assert_eq!(t.tool_calls.len(), 1);
        assert_eq!(t.tool_calls[0].id, "call_abc");
        assert_eq!(t.tool_calls[0].name, "read");
        assert_eq!(t.tool_calls[0].args["path"], "/tmp/x");
    }

    #[test]
    fn parse_responses_malformed_arguments_are_safe() {
        // Malformed JSON arguments must not panic; fall back to empty object.
        let body = json!({
            "output": [
                {"type": "function_call", "call_id": "c1", "name": "bash",
                 "arguments": "{not valid json"}
            ]
        });
        let t = parse_response(ApiShape::OpenaiResponses, &body);
        assert_eq!(t.tool_calls.len(), 1);
        assert_eq!(t.tool_calls[0].name, "bash");
        assert_eq!(t.tool_calls[0].args, json!({}));
    }

    #[test]
    fn parse_responses_empty_body_is_safe() {
        let t = parse_response(ApiShape::OpenaiResponses, &json!({}));
        assert_eq!(t.text, "");
        assert!(t.tool_calls.is_empty());
    }
}
