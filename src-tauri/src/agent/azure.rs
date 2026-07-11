//! Azure AI Foundry deployment adapter.
//!
//! Azure Foundry differs from a plain OpenAI-compatible endpoint in three ways
//! this module owns:
//!
//! 1. Authentication uses an `api-key` header (not a bearer token).
//! 2. The logical model the user picks must be remapped to the concrete Azure
//!    *deployment* name before it is sent on the wire.
//! 3. Requests target the Azure Responses surface at
//!    `{endpoint}/openai/v1/responses`, with the REST `api-version` applied as a
//!    query parameter when configured, and `store: false` so Azure never
//!    retains request/response bodies.
//!
//! Security: the Azure API key is a protected secret. It is never logged, never
//! serialized into settings, and only appears in the outbound `api-key` header
//! of a live request. Error strings surfaced to callers are concise and never
//! echo the key or raw response bodies.

use serde_json::{json, Value};

use crate::agent::copilot::{HttpRequest, HttpResponse, HttpTransport};
use crate::agent::provider::{parse_response, ParsedTurn};
use crate::settings::{ApiShape, ProviderConfig};

// ---------------------------------------------------------------------------
// Pure helpers (exact public API required by the plan)
// ---------------------------------------------------------------------------

/// Normalize and validate an Azure endpoint. Trims surrounding whitespace and a
/// single trailing slash, requires a non-empty value, and enforces an `https://`
/// scheme (Azure Foundry is always TLS). Returns the normalized base URL.
pub fn normalize_endpoint(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Endpoint is required".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("https://") {
        return Err("Endpoint must use https".to_string());
    }
    // Reject a scheme-only URL with no host.
    if trimmed.len() <= "https://".len() {
        return Err("Endpoint is missing a host".to_string());
    }
    Ok(trimmed.to_string())
}

/// Build the Azure Responses URL for `endpoint`:
/// `{normalized_endpoint}/openai/v1/responses`. Validates the endpoint is a
/// non-empty HTTPS URL.
pub fn responses_url(endpoint: &str) -> Result<String, String> {
    let base = normalize_endpoint(endpoint)?;
    Ok(format!("{base}/openai/v1/responses"))
}

/// Remap a logical `model` name to its concrete Azure deployment using the
/// profile's structured `azure_deployments` mappings. Returns a borrowed
/// deployment name tied to `config`. Errors when the model has no mapping or the
/// mapped deployment is blank.
pub fn remap_model<'a>(config: &'a ProviderConfig, model: &str) -> Result<&'a str, String> {
    let wanted = model.trim();
    for mapping in &config.azure_deployments {
        if mapping.model.trim() == wanted {
            let deployment = mapping.deployment.trim();
            if deployment.is_empty() {
                return Err(format!("Azure deployment for model '{wanted}' is empty"));
            }
            return Ok(deployment);
        }
    }
    Err(format!("No Azure deployment mapped for model '{wanted}'"))
}

/// Validate an Azure provider profile for a live request: HTTPS endpoint, a
/// present API key (plaintext or a stored credential), and a unique, non-empty
/// mapping set whose selected model is a member (delegated to the shared Azure
/// mapping contract).
pub fn validate_config(config: &ProviderConfig) -> Result<(), String> {
    normalize_endpoint(&config.endpoint)?;
    if config.api_key.trim().is_empty() && !config.api_key_stored {
        return Err("API key is required".to_string());
    }
    let mappings = config.effective_azure_deployments();
    crate::settings::validate_azure_mappings(&mappings, &config.azure_api_version, &config.model)
        .map_err(|e| e.0)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/// A built Azure request: absolute URL (with `api-version` when configured),
/// headers (including the `api-key`), and a Responses-shaped JSON body with
/// `store: false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AzureRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

/// Resolve a deployment for `model`, tolerating legacy `manual_models` configs
/// via `effective_azure_deployments`. Returns an owned deployment name.
fn resolve_deployment(config: &ProviderConfig, model: &str) -> Result<String, String> {
    let wanted = model.trim();
    for mapping in config.effective_azure_deployments() {
        if mapping.model.trim() == wanted {
            let deployment = mapping.deployment.trim();
            if deployment.is_empty() {
                return Err(format!("Azure deployment for model '{wanted}' is empty"));
            }
            return Ok(deployment.to_string());
        }
    }
    Err(format!("No Azure deployment mapped for model '{wanted}'"))
}

/// Build the Azure Responses request for a turn. Applies the deployment remap,
/// the `api-key` header, the `api-version` query parameter (when configured),
/// and a Responses body with `store: false`.
pub fn build_request(
    config: &ProviderConfig,
    model: &str,
    system: &str,
    messages: &[(String, String)],
    tools: &[Value],
) -> Result<AzureRequest, String> {
    let deployment = resolve_deployment(config, model)?;
    let mut url = responses_url(&config.endpoint)?;
    let api_version = config.azure_api_version.trim();
    if !api_version.is_empty() {
        url.push_str(&format!("?api-version={api_version}"));
    }

    let mut input = vec![json!({"role": "system", "content": system})];
    for (role, content) in messages {
        input.push(json!({"role": role, "content": content}));
    }

    Ok(AzureRequest {
        url,
        headers: vec![
            ("api-key".to_string(), config.api_key.clone()),
            ("content-type".to_string(), "application/json".to_string()),
        ],
        body: json!({
            "model": deployment,
            "input": input,
            "tools": tools,
            "store": false,
        }),
    })
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/// Run one Azure Foundry inference turn. Builds the Responses request (mapped
/// deployment, `api-key` header, `store: false`), sends it through the injected
/// transport, and parses the result with the real Responses parser. Errors are
/// concise and never leak the key or raw body.
pub async fn infer(
    transport: &dyn HttpTransport,
    config: &ProviderConfig,
    model: &str,
    system: &str,
    messages: &[(String, String)],
    tools: &[Value],
) -> Result<ParsedTurn, String> {
    let built = build_request(config, model, system, messages, tools)?;
    let req = HttpRequest {
        method: "POST",
        url: built.url,
        headers: built.headers,
        body: Some(built.body),
    };
    let resp: HttpResponse = transport.send(req).await?;
    if resp.status >= 400 {
        let detail = resp.body["error"]["message"]
            .as_str()
            .map(|m| format!(": {m}"))
            .unwrap_or_default();
        return Err(format!("Azure request failed (HTTP {}){detail}", resp.status));
    }
    Ok(parse_response(ApiShape::OpenaiResponses, &resp.body))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::copilot::FakeTransport;
    use crate::settings::AzureDeploymentMapping;
    use std::sync::Arc;

    fn azure_config() -> ProviderConfig {
        ProviderConfig {
            endpoint: "https://my-resource.openai.azure.com".to_string(),
            api_key: "azure-secret-key".to_string(),
            api_key_stored: false,
            api_shape: ApiShape::OpenaiResponses,
            model: "gpt-4o".to_string(),
            azure_deployments: vec![
                AzureDeploymentMapping {
                    model: "gpt-4o".to_string(),
                    deployment: "prod-4o".to_string(),
                },
                AzureDeploymentMapping {
                    model: "gpt-4o-mini".to_string(),
                    deployment: "prod-mini".to_string(),
                },
            ],
            azure_api_version: "2024-02-01".to_string(),
            manual_models: String::new(),
        }
    }

    fn ok(body: Value) -> HttpResponse {
        HttpResponse { status: 200, body }
    }

    // --- Endpoint validation / normalization -------------------------------

    #[test]
    fn normalize_requires_https() {
        assert!(normalize_endpoint("http://a.openai.azure.com").is_err());
        assert!(normalize_endpoint("ftp://a").is_err());
        assert!(normalize_endpoint("a.openai.azure.com").is_err());
    }

    #[test]
    fn normalize_rejects_empty_and_scheme_only() {
        assert!(normalize_endpoint("").is_err());
        assert!(normalize_endpoint("   ").is_err());
        assert!(normalize_endpoint("https://").is_err());
    }

    #[test]
    fn normalize_trims_trailing_slash_and_whitespace() {
        assert_eq!(
            normalize_endpoint("  https://a.openai.azure.com/  ").unwrap(),
            "https://a.openai.azure.com"
        );
        assert_eq!(
            normalize_endpoint("https://a.openai.azure.com").unwrap(),
            "https://a.openai.azure.com"
        );
    }

    // --- Responses URL ------------------------------------------------------

    #[test]
    fn responses_url_uses_openai_v1_responses_path() {
        assert_eq!(
            responses_url("https://a.openai.azure.com/").unwrap(),
            "https://a.openai.azure.com/openai/v1/responses"
        );
    }

    #[test]
    fn responses_url_rejects_non_https() {
        assert!(responses_url("http://a.openai.azure.com").is_err());
    }

    // --- Model -> deployment remap -----------------------------------------

    #[test]
    fn remap_model_returns_mapped_deployment() {
        let c = azure_config();
        assert_eq!(remap_model(&c, "gpt-4o").unwrap(), "prod-4o");
        assert_eq!(remap_model(&c, "gpt-4o-mini").unwrap(), "prod-mini");
        // Whitespace-tolerant.
        assert_eq!(remap_model(&c, "  gpt-4o  ").unwrap(), "prod-4o");
    }

    #[test]
    fn remap_model_errors_on_unknown_model() {
        let c = azure_config();
        assert!(remap_model(&c, "mystery").is_err());
    }

    #[test]
    fn remap_model_errors_on_blank_deployment() {
        let mut c = azure_config();
        c.azure_deployments = vec![AzureDeploymentMapping {
            model: "m".to_string(),
            deployment: "   ".to_string(),
        }];
        assert!(remap_model(&c, "m").is_err());
    }

    // --- validate_config ----------------------------------------------------

    #[test]
    fn validate_config_accepts_complete_profile() {
        assert!(validate_config(&azure_config()).is_ok());
    }

    #[test]
    fn validate_config_rejects_non_https_endpoint() {
        let mut c = azure_config();
        c.endpoint = "http://insecure".to_string();
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn validate_config_requires_a_key_plaintext_or_stored() {
        let mut c = azure_config();
        c.api_key = String::new();
        c.api_key_stored = false;
        assert!(validate_config(&c).is_err());
        // A stored credential satisfies the requirement.
        c.api_key_stored = true;
        assert!(validate_config(&c).is_ok());
    }

    #[test]
    fn validate_config_rejects_empty_mappings() {
        let mut c = azure_config();
        c.azure_deployments = Vec::new();
        c.manual_models = String::new();
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn validate_config_rejects_duplicate_mappings() {
        let mut c = azure_config();
        c.azure_deployments = vec![
            AzureDeploymentMapping {
                model: "dup".to_string(),
                deployment: "d1".to_string(),
            },
            AzureDeploymentMapping {
                model: "dup".to_string(),
                deployment: "d2".to_string(),
            },
        ];
        c.model = "dup".to_string();
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn validate_config_rejects_selected_model_not_in_mappings() {
        let mut c = azure_config();
        c.model = "not-mapped".to_string();
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn validate_config_requires_api_version() {
        let mut c = azure_config();
        c.azure_api_version = String::new();
        assert!(validate_config(&c).is_err());
    }

    // --- Request construction ----------------------------------------------

    #[test]
    fn build_request_targets_responses_with_api_key_and_store_false() {
        let c = azure_config();
        let r = build_request(&c, "gpt-4o", "sys", &[("user".into(), "hi".into())], &[]).unwrap();
        assert_eq!(
            r.url,
            "https://my-resource.openai.azure.com/openai/v1/responses?api-version=2024-02-01"
        );
        // api-key header, never an Authorization bearer.
        assert!(r
            .headers
            .iter()
            .any(|(k, v)| k == "api-key" && v == "azure-secret-key"));
        assert!(!r
            .headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("authorization")));
        // Body: mapped deployment as model, store:false, system-first input.
        assert_eq!(r.body["model"], "prod-4o");
        assert_eq!(r.body["store"], false);
        assert_eq!(r.body["input"][0]["role"], "system");
        assert_eq!(r.body["input"][1]["role"], "user");
    }

    #[test]
    fn build_request_omits_api_version_when_blank() {
        let mut c = azure_config();
        c.azure_api_version = String::new();
        let r = build_request(&c, "gpt-4o", "sys", &[], &[]).unwrap();
        assert_eq!(
            r.url,
            "https://my-resource.openai.azure.com/openai/v1/responses"
        );
    }

    #[test]
    fn build_request_supports_legacy_manual_models() {
        let mut c = azure_config();
        c.azure_deployments = Vec::new();
        c.manual_models = "legacy-dep".to_string();
        let r = build_request(&c, "legacy-dep", "sys", &[], &[]).unwrap();
        // Legacy migration maps a name to an identically-named deployment.
        assert_eq!(r.body["model"], "legacy-dep");
    }

    #[test]
    fn build_request_errors_on_unmapped_model() {
        let c = azure_config();
        assert!(build_request(&c, "unknown", "sys", &[], &[]).is_err());
    }

    // --- Inference: real Responses parsing ---------------------------------

    #[tokio::test]
    async fn infer_parses_responses_text_and_sends_api_key() {
        let transport = Arc::new(FakeTransport::new(vec![ok(json!({
            "output": [{"type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "azure-answer"}]}]
        }))]));
        let t: Arc<dyn HttpTransport> = transport.clone();
        let c = azure_config();
        let turn = infer(&*t, &c, "gpt-4o", "sys", &[("user".into(), "hi".into())], &[])
            .await
            .unwrap();
        assert_eq!(turn.text, "azure-answer");

        let reqs = transport.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].method, "POST");
        assert!(reqs[0]
            .url
            .starts_with("https://my-resource.openai.azure.com/openai/v1/responses"));
        assert!(reqs[0]
            .headers
            .iter()
            .any(|(k, v)| k == "api-key" && v == "azure-secret-key"));
    }

    #[tokio::test]
    async fn infer_parses_function_calls() {
        let transport = Arc::new(FakeTransport::new(vec![ok(json!({
            "output": [
                {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "checking"}]},
                {"type": "function_call", "call_id": "call_1",
                 "name": "read", "arguments": "{\"path\":\"/tmp/a\"}"}
            ]
        }))]));
        let t: Arc<dyn HttpTransport> = transport.clone();
        let c = azure_config();
        let turn = infer(&*t, &c, "gpt-4o", "sys", &[("user".into(), "hi".into())], &[])
            .await
            .unwrap();
        assert_eq!(turn.text, "checking");
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "read");
        assert_eq!(turn.tool_calls[0].args["path"], "/tmp/a");
    }

    #[tokio::test]
    async fn infer_error_is_concise_and_redacts_secret() {
        let transport = Arc::new(FakeTransport::new(vec![HttpResponse {
            status: 401,
            body: json!({"error": {"message": "Access denied"}}),
        }]));
        let t: Arc<dyn HttpTransport> = transport.clone();
        let c = azure_config();
        let err = infer(&*t, &c, "gpt-4o", "sys", &[("user".into(), "hi".into())], &[])
            .await
            .unwrap_err();
        assert!(err.contains("HTTP 401"));
        // The API key must never appear in a surfaced error.
        assert!(!err.contains("azure-secret-key"));
    }

    #[tokio::test]
    async fn infer_rejects_unmapped_model_before_request() {
        let transport = Arc::new(FakeTransport::new(vec![]));
        let t: Arc<dyn HttpTransport> = transport.clone();
        let c = azure_config();
        assert!(infer(&*t, &c, "unmapped", "sys", &[], &[]).await.is_err());
        // No request was ever sent.
        assert!(transport.requests().is_empty());
    }
}
