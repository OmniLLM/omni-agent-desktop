//! GitHub Copilot authentication and token lifecycle.
//!
//! Owns the Copilot device-code OAuth flow, the manual GitHub-token fallback,
//! the two-token lifecycle (a long-lived GitHub OAuth token stored in the OS
//! credential store, and a short-lived Copilot API token cached only in memory),
//! and Copilot model-capability discovery / request routing.
//!
//! Security: only the long-lived GitHub token is persisted, through
//! [`crate::secrets::SecretStore`] under the `github-copilot.token` key. The
//! short-lived Copilot token lives in memory and refreshes with a 300-second
//! skew. Public status never carries a token. Tokens and authorization payloads
//! are never logged.

use std::error::Error as _;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use crate::secrets::{secret_key, SecretStore};
use crate::settings::ProviderType;

pub const CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
pub const SCOPE: &str = "read:user";

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";
const MODELS_URL: &str = "https://api.githubcopilot.com/models";
/// Copilot inference API base host. Chat and Responses paths hang off this.
const COPILOT_API_BASE: &str = "https://api.githubcopilot.com";
const COPILOT_INTEGRATION_ID: &str = "vscode-chat";
const COPILOT_EDITOR_VERSION: &str = "omni-agent-desktop/0.1";

/// Refresh the Copilot token when absent or within this many seconds of expiry.
pub const REFRESH_SKEW_SECS: u64 = 300;

fn github_token_key() -> &'static str {
    secret_key(ProviderType::GithubCopilot).expect("copilot is a protected provider")
}

// ---------------------------------------------------------------------------
// Public status
// ---------------------------------------------------------------------------

/// Public, frontend-safe Copilot authentication status; never carries a token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CopilotAuthStatus {
    Disconnected,
    AwaitingUser {
        flow_id: String,
        user_code: String,
        verification_uri: String,
        expires_at: u64,
    },
    Connected {
        login: String,
    },
    Expired,
    Cancelled,
    Error {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// Injectable clock and HTTP transport
// ---------------------------------------------------------------------------

/// A source of wall-clock time (unix seconds). Injected for deterministic tests.
pub trait Clock: Send + Sync {
    fn now_unix(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

#[cfg(test)]
pub struct FixedClock(pub std::sync::atomic::AtomicU64);

#[cfg(test)]
impl Clock for FixedClock {
    fn now_unix(&self) -> u64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Value,
}

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Injectable async HTTP transport. Production wraps `reqwest`; tests script it.
pub trait HttpTransport: Send + Sync {
    fn send(&self, req: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, String>>;
}

// ---------------------------------------------------------------------------
// Pure parsing / state helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCodeFlow {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

pub fn parse_device_code(body: &Value) -> Result<DeviceCodeFlow, String> {
    let device_code = body["device_code"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("device flow response missing device_code")?
        .to_string();
    let user_code = body["user_code"].as_str().unwrap_or("").to_string();
    let verification_uri = body["verification_uri"]
        .as_str()
        .or_else(|| body["verification_url"].as_str())
        .unwrap_or("https://github.com/login/device")
        .to_string();
    let expires_in = body["expires_in"].as_u64().unwrap_or(900);
    let interval = body["interval"].as_u64().unwrap_or(5);
    Ok(DeviceCodeFlow {
        device_code,
        user_code,
        verification_uri,
        expires_in,
        interval,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    Pending,
    SlowDown { interval: u64 },
    Denied,
    Expired,
    Success { access_token: String },
    Error { message: String },
}

pub fn parse_poll(body: &Value) -> PollOutcome {
    if let Some(token) = body["access_token"].as_str() {
        if !token.is_empty() {
            return PollOutcome::Success {
                access_token: token.to_string(),
            };
        }
    }
    match body["error"].as_str() {
        Some("authorization_pending") => PollOutcome::Pending,
        Some("slow_down") => PollOutcome::SlowDown {
            interval: body["interval"].as_u64().unwrap_or(0),
        },
        Some("access_denied") => PollOutcome::Denied,
        Some("expired_token") => PollOutcome::Expired,
        Some(other) => PollOutcome::Error {
            message: other.to_string(),
        },
        None => PollOutcome::Error {
            message: "unrecognized poll response".to_string(),
        },
    }
}

/// Next poll interval after `slow_down`: honor a larger explicit interval,
/// otherwise add 5s. Never decreases below the current interval.
pub fn next_poll_interval(current: u64, outcome: &PollOutcome) -> u64 {
    match outcome {
        PollOutcome::SlowDown { interval } if *interval > current => *interval,
        PollOutcome::SlowDown { .. } => current + 5,
        _ => current,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopilotToken {
    pub token: String,
    pub expires_at: u64,
}

/// True when the cached Copilot token is absent or within the refresh skew.
pub fn token_needs_refresh(token: Option<&CopilotToken>, now: u64) -> bool {
    match token {
        None => true,
        Some(t) => t.expires_at <= now + REFRESH_SKEW_SECS,
    }
}

pub fn parse_copilot_token(body: &Value, now: u64) -> Result<CopilotToken, String> {
    let token = body["token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("copilot token response missing token")?
        .to_string();
    let expires_at = body["expires_at"].as_u64().unwrap_or(now + 1800);
    Ok(CopilotToken { token, expires_at })
}

// ---------------------------------------------------------------------------
// Model capability discovery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CopilotEndpoint {
    ChatCompletions,
    Responses,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CopilotModel {
    pub id: String,
    pub supported_endpoints: Vec<String>,
    pub endpoint: CopilotEndpoint,
}

/// Route a model: Responses-only models go to `/responses`, otherwise prefer
/// Chat Completions.
pub fn select_endpoint(supported: &[String]) -> CopilotEndpoint {
    let has_chat = supported
        .iter()
        .any(|e| e.contains("chat") || e == "/chat/completions");
    let has_responses = supported.iter().any(|e| e.contains("responses"));
    if has_responses && !has_chat {
        CopilotEndpoint::Responses
    } else {
        CopilotEndpoint::ChatCompletions
    }
}

pub fn parse_models(body: &Value) -> Vec<CopilotModel> {
    let arr = body["data"]
        .as_array()
        .or_else(|| body["models"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for m in &arr {
        let id = m["id"]
            .as_str()
            .or_else(|| m["name"].as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let supported: Vec<String> = m["supported_endpoints"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let endpoint = select_endpoint(&supported);
        out.push(CopilotModel {
            id,
            supported_endpoints: supported,
            endpoint,
        });
    }
    out
}

/// Cryptographically random request id (16 bytes / 32 hex chars) from the OS
/// RNG. Copilot requires a per-request id.
pub fn request_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes.copy_from_slice(&nanos.to_le_bytes());
    }
    let mut s = String::with_capacity(32);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// A built Copilot inference request: absolute URL, headers (including a crypto
/// request id and the bearer Copilot token), and JSON body. Never carries the
/// raw GitHub token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopilotRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
    pub endpoint: CopilotEndpoint,
}

/// Look up the routing endpoint for `model` among discovered `models`. Unknown
/// models default to Chat Completions (the broadly-supported shape).
pub fn endpoint_for_model(models: &[CopilotModel], model: &str) -> CopilotEndpoint {
    models
        .iter()
        .find(|m| m.id == model)
        .map(|m| m.endpoint)
        .unwrap_or(CopilotEndpoint::ChatCompletions)
}

/// Build a Copilot inference request for the given endpoint, model, system
/// prompt and messages. `copilot_token` is the short-lived Copilot API token
/// (NOT the GitHub token). A fresh crypto request id is attached per call.
pub fn build_copilot_request(
    endpoint: CopilotEndpoint,
    copilot_token: &str,
    model: &str,
    system: &str,
    messages: &[(String, String)],
    tools: &[Value],
) -> CopilotRequest {
    let headers = vec![
        ("Authorization".to_string(), format!("Bearer {copilot_token}")),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "application/json".to_string()),
        ("Copilot-Integration-Id".to_string(), COPILOT_INTEGRATION_ID.to_string()),
        ("Editor-Version".to_string(), COPILOT_EDITOR_VERSION.to_string()),
        ("X-Request-Id".to_string(), request_id()),
    ];
    match endpoint {
        CopilotEndpoint::Responses => {
            let mut input = vec![json!({"role": "system", "content": system})];
            for (role, content) in messages {
                input.push(json!({"role": role, "content": content}));
            }
            CopilotRequest {
                url: format!("{COPILOT_API_BASE}/responses"),
                headers,
                body: json!({"model": model, "input": input, "tools": tools, "store": false}),
                endpoint,
            }
        }
        CopilotEndpoint::ChatCompletions => {
            let mut msgs = vec![json!({"role": "system", "content": system})];
            for (role, content) in messages {
                msgs.push(json!({"role": role, "content": content}));
            }
            CopilotRequest {
                url: format!("{COPILOT_API_BASE}/chat/completions"),
                headers,
                body: json!({"model": model, "messages": msgs, "tools": tools}),
                endpoint,
            }
        }
    }
}

/// Detect GitHub's "this model does not support chat/completions" style errors
/// in an HTTP body so inference can fall back to the Responses endpoint once.
pub fn is_unsupported_chat(status: u16, body: &Value) -> bool {
    if status != 400 && status != 404 && status != 422 {
        return false;
    }
    let msg = body["error"]["message"]
        .as_str()
        .or_else(|| body["error"].as_str())
        .or_else(|| body["message"].as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let code = body["error"]["code"].as_str().unwrap_or("").to_ascii_lowercase();
    (msg.contains("responses") && (msg.contains("only") || msg.contains("unsupported") || msg.contains("not support")))
        || msg.contains("unsupported_endpoint")
        || code.contains("unsupported")
        || (msg.contains("chat") && msg.contains("not support"))
}

// ---------------------------------------------------------------------------
// Auth service
// ---------------------------------------------------------------------------

struct Inner {
    status: CopilotAuthStatus,
    cancelled: bool,
    device_code: Option<String>,
    poll_interval: u64,
    copilot_token: Option<CopilotToken>,
    /// Discovered models, cached from `list_models`, used to route inference to
    /// the correct endpoint for the selected model.
    models: Vec<CopilotModel>,
}

/// Copilot authentication service: owns public status, the in-memory Copilot
/// token cache, and injected transport/clock/store.
pub struct CopilotAuth {
    transport: Arc<dyn HttpTransport>,
    clock: Arc<dyn Clock>,
    store: Arc<dyn SecretStore>,
    inner: Mutex<Inner>,
}

impl CopilotAuth {
    pub fn new(
        transport: Arc<dyn HttpTransport>,
        clock: Arc<dyn Clock>,
        store: Arc<dyn SecretStore>,
    ) -> Self {
        Self {
            transport,
            clock,
            store,
            inner: Mutex::new(Inner {
                status: CopilotAuthStatus::Disconnected,
                cancelled: false,
                device_code: None,
                poll_interval: 5,
                copilot_token: None,
                models: Vec::new(),
            }),
        }
    }

    pub fn status(&self) -> CopilotAuthStatus {
        self.inner.lock().unwrap().status.clone()
    }

    pub fn poll_interval(&self) -> u64 {
        self.inner.lock().unwrap().poll_interval
    }

    /// True when a long-lived GitHub credential is present in the store. Lets
    /// settings validation decide connectivity without exposing the token.
    pub fn credential_present(&self) -> bool {
        self.store
            .get(github_token_key())
            .ok()
            .flatten()
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    }

    /// Cancel any in-flight flow. Network-free so a poll loop stops immediately.
    pub fn cancel(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.cancelled = true;
        inner.device_code = None;
        if matches!(inner.status, CopilotAuthStatus::AwaitingUser { .. }) {
            inner.status = CopilotAuthStatus::Cancelled;
        }
    }

    fn set_status(&self, status: CopilotAuthStatus) {
        self.inner.lock().unwrap().status = status;
    }

    /// Start the device-code flow, record the device code, return display status.
    pub async fn start_device_flow(&self) -> Result<CopilotAuthStatus, String> {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.cancelled = false;
            inner.copilot_token = None;
        }
        let req = HttpRequest {
            method: "POST",
            url: DEVICE_CODE_URL.to_string(),
            headers: vec![
                ("Accept".into(), "application/json".into()),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: Some(json!({ "client_id": CLIENT_ID, "scope": SCOPE })),
        };
        let resp = self.transport.send(req).await?;
        if resp.status >= 400 {
            let status = CopilotAuthStatus::Error {
                message: format!("device flow HTTP {}", resp.status),
            };
            self.set_status(status.clone());
            return Ok(status);
        }
        let flow = parse_device_code(&resp.body)?;
        let expires_at = self.clock.now_unix() + flow.expires_in;
        let status = CopilotAuthStatus::AwaitingUser {
            flow_id: flow.device_code.clone(),
            user_code: flow.user_code.clone(),
            verification_uri: flow.verification_uri.clone(),
            expires_at,
        };
        {
            let mut inner = self.inner.lock().unwrap();
            inner.device_code = Some(flow.device_code);
            inner.poll_interval = flow.interval.max(1);
            inner.status = status.clone();
        }
        Ok(status)
    }

    /// Poll the access-token endpoint once, updating status/interval.
    pub async fn poll_once(&self) -> Result<PollOutcome, String> {
        let device_code = {
            let inner = self.inner.lock().unwrap();
            if inner.cancelled {
                return Ok(PollOutcome::Error {
                    message: "cancelled".into(),
                });
            }
            match &inner.device_code {
                Some(c) => c.clone(),
                None => return Err("no active device flow".to_string()),
            }
        };
        let req = HttpRequest {
            method: "POST",
            url: ACCESS_TOKEN_URL.to_string(),
            headers: vec![
                ("Accept".into(), "application/json".into()),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: Some(json!({
                "client_id": CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            })),
        };
        let resp = self.transport.send(req).await?;
        let outcome = parse_poll(&resp.body);
        match &outcome {
            PollOutcome::Pending => {}
            PollOutcome::SlowDown { .. } => {
                let mut inner = self.inner.lock().unwrap();
                inner.poll_interval = next_poll_interval(inner.poll_interval, &outcome);
            }
            PollOutcome::Denied => self.set_status(CopilotAuthStatus::Error {
                message: "authorization denied".into(),
            }),
            PollOutcome::Expired => self.set_status(CopilotAuthStatus::Expired),
            PollOutcome::Error { message } => self.set_status(CopilotAuthStatus::Error {
                message: message.clone(),
            }),
            PollOutcome::Success { access_token } => {
                self.complete_with_github_token(access_token).await?;
            }
        }
        Ok(outcome)
    }

    /// Manual fallback: validate a supplied GitHub token via user lookup,
    /// persist it, and mark Connected (same path as device completion).
    pub async fn connect_with_token(&self, github_token: &str) -> Result<CopilotAuthStatus, String> {
        let token = github_token.trim();
        if token.is_empty() {
            return Err("GitHub token is required".to_string());
        }
        self.complete_with_github_token(token).await?;
        Ok(self.status())
    }

    /// Shared success path: resolve the user login (validates the token), store
    /// the GitHub token, and mark Connected. On lookup failure nothing persists.
    async fn complete_with_github_token(&self, github_token: &str) -> Result<(), String> {
        let login = self.fetch_login(github_token).await?;
        self.store
            .set(github_token_key(), github_token)
            .map_err(|e| e.to_string())?;
        let mut inner = self.inner.lock().unwrap();
        inner.cancelled = false;
        inner.device_code = None;
        inner.copilot_token = None;
        inner.status = CopilotAuthStatus::Connected { login };
        Ok(())
    }

    async fn fetch_login(&self, github_token: &str) -> Result<String, String> {
        let req = HttpRequest {
            method: "GET",
            url: USER_URL.to_string(),
            headers: vec![
                ("Authorization".into(), format!("token {github_token}")),
                ("Accept".into(), "application/vnd.github+json".into()),
                ("User-Agent".into(), "omni-agent-desktop".into()),
            ],
            body: None,
        };
        let resp = self.transport.send(req).await?;
        if resp.status >= 400 {
            return Err(format!("GitHub user lookup failed (HTTP {})", resp.status));
        }
        resp.body["login"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .ok_or_else(|| "GitHub user response missing login".to_string())
    }

    /// Disconnect: delete the persisted GitHub token, clear the in-memory
    /// Copilot token, cancel any flow, and reset to Disconnected.
    pub fn disconnect(&self) -> Result<(), String> {
        self.store
            .delete(github_token_key())
            .map_err(|e| e.to_string())?;
        let mut inner = self.inner.lock().unwrap();
        inner.cancelled = true;
        inner.device_code = None;
        inner.copilot_token = None;
        inner.status = CopilotAuthStatus::Disconnected;
        Ok(())
    }

    /// Ensure a fresh Copilot token, exchanging when absent or near expiry (300s
    /// skew). `force` bypasses the cache for a post-401/403 refresh.
    async fn ensure_copilot_token(&self, force: bool) -> Result<String, String> {
        let now = self.clock.now_unix();
        {
            let inner = self.inner.lock().unwrap();
            if !force && !token_needs_refresh(inner.copilot_token.as_ref(), now) {
                return Ok(inner.copilot_token.as_ref().unwrap().token.clone());
            }
        }
        let github_token = self
            .store
            .get(github_token_key())
            .map_err(|e| e.to_string())?
            .filter(|v| !v.is_empty())
            .ok_or("not connected to GitHub Copilot")?;
        let req = HttpRequest {
            method: "GET",
            url: COPILOT_TOKEN_URL.to_string(),
            headers: vec![
                ("Authorization".into(), format!("token {github_token}")),
                ("Accept".into(), "application/json".into()),
                ("User-Agent".into(), "omni-agent-desktop".into()),
            ],
            body: None,
        };
        let resp = self.transport.send(req).await?;
        if resp.status >= 400 {
            return Err(format!("Copilot token exchange failed (HTTP {})", resp.status));
        }
        let token = parse_copilot_token(&resp.body, now)?;
        let value = token.token.clone();
        self.inner.lock().unwrap().copilot_token = Some(token);
        Ok(value)
    }

    /// List Copilot models. Exchanges/refreshes the Copilot token, then GETs the
    /// models endpoint. One 401/403 forces exactly one refresh and one retry.
    pub async fn list_models(&self) -> Result<Vec<CopilotModel>, String> {
        let mut token = self.ensure_copilot_token(false).await?;
        let mut forced = false;
        loop {
            let req = HttpRequest {
                method: "GET",
                url: MODELS_URL.to_string(),
                headers: vec![
                    ("Authorization".into(), format!("Bearer {token}")),
                    ("Accept".into(), "application/json".into()),
                    ("Copilot-Integration-Id".into(), COPILOT_INTEGRATION_ID.into()),
                    ("Editor-Version".into(), COPILOT_EDITOR_VERSION.into()),
                    ("X-Request-Id".into(), request_id()),
                    ("User-Agent".into(), "omni-agent-desktop".into()),
                ],
                body: None,
            };
            let resp = self.transport.send(req).await?;
            if (resp.status == 401 || resp.status == 403) && !forced {
                forced = true;
                token = self.ensure_copilot_token(true).await?;
                continue;
            }
            if resp.status >= 400 {
                return Err(format!("Copilot models request failed (HTTP {})", resp.status));
            }
            let models = parse_models(&resp.body);
            self.inner.lock().unwrap().models = models.clone();
            return Ok(models);
        }
    }

    /// Run one Copilot inference turn for `model`. Obtains a short-lived Copilot
    /// token (never sends the raw GitHub token to the inference host), routes to
    /// the model's supported endpoint (Responses-only vs Chat preference), and
    /// applies bounded recovery: exactly one forced token refresh + retry on
    /// 401/403, and exactly one Chat->Responses fallback on an explicit
    /// unsupported-chat response. Returns a parsed assistant turn.
    pub async fn infer(
        &self,
        model: &str,
        system: &str,
        messages: &[(String, String)],
        tools: &[Value],
    ) -> Result<crate::agent::provider::ParsedTurn, String> {
        // Ensure we know the model's capability. Discover once if the cache is
        // empty so routing is correct even before an explicit list_models call.
        let cached_empty = self.inner.lock().unwrap().models.is_empty();
        if cached_empty {
            let _ = self.list_models().await;
        }
        let mut endpoint = {
            let inner = self.inner.lock().unwrap();
            endpoint_for_model(&inner.models, model)
        };

        let mut token = self.ensure_copilot_token(false).await?;
        let mut auth_retried = false;
        let mut fallback_used = false;
        loop {
            let built =
                build_copilot_request(endpoint, &token, model, system, messages, tools);
            let req = HttpRequest {
                method: "POST",
                url: built.url,
                headers: built.headers,
                body: Some(built.body),
            };
            let resp = self.transport.send(req).await?;
            if (resp.status == 401 || resp.status == 403) && !auth_retried {
                auth_retried = true;
                token = self.ensure_copilot_token(true).await?;
                continue;
            }
            if endpoint == CopilotEndpoint::ChatCompletions
                && !fallback_used
                && is_unsupported_chat(resp.status, &resp.body)
            {
                fallback_used = true;
                endpoint = CopilotEndpoint::Responses;
                continue;
            }
            if resp.status >= 400 {
                let detail = resp.body["error"]["message"]
                    .as_str()
                    .map(|m| format!(": {m}"))
                    .unwrap_or_default();
                return Err(format!("Copilot inference failed (HTTP {}){detail}", resp.status));
            }
            let shape = match endpoint {
                CopilotEndpoint::Responses => crate::settings::ApiShape::OpenaiResponses,
                CopilotEndpoint::ChatCompletions => crate::settings::ApiShape::OpenaiCompatible,
            };
            return Ok(crate::agent::provider::parse_response(shape, &resp.body));
        }
    }
}

// ---------------------------------------------------------------------------
// Production reqwest transport
// ---------------------------------------------------------------------------

/// Production HTTP transport backed by a shared `reqwest` client.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

fn reqwest_error(error: reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

impl HttpTransport for ReqwestTransport {
    fn send(&self, req: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, String>> {
        let client = self.client.clone();
        Box::pin(async move {
            let mut builder = match req.method {
                "POST" => client.post(&req.url),
                _ => client.get(&req.url),
            };
            for (k, v) in &req.headers {
                builder = builder.header(k, v);
            }
            if let Some(body) = &req.body {
                builder = builder.json(body);
            }
            let resp = builder.send().await.map_err(reqwest_error)?;
            let status = resp.status().as_u16();
            let text = resp.text().await.map_err(reqwest_error)?;
            let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            Ok(HttpResponse { status, body })
        })
    }
}

// ---------------------------------------------------------------------------
// Test-only fake transport
// ---------------------------------------------------------------------------

#[cfg(test)]
use std::collections::VecDeque;

#[cfg(test)]
pub struct FakeTransport {
    pub requests: Mutex<Vec<HttpRequest>>,
    responses: Mutex<VecDeque<HttpResponse>>,
}

#[cfg(test)]
impl FakeTransport {
    pub fn new(responses: Vec<HttpResponse>) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            responses: Mutex::new(responses.into_iter().collect()),
        }
    }

    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[cfg(test)]
impl HttpTransport for FakeTransport {
    fn send(&self, req: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, String>> {
        self.requests.lock().unwrap().push(req.clone());
        let next = self.responses.lock().unwrap().pop_front();
        Box::pin(async move { next.ok_or_else(|| format!("no scripted response for {}", req.url)) })
    }
}

#[cfg(test)]
fn ok(body: Value) -> HttpResponse {
    HttpResponse { status: 200, body }
}

// ---------------------------------------------------------------------------
// Pure state-machine tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod pure_tests {
    use super::*;

    #[test]
    fn parses_device_code_response() {
        let body = json!({
            "device_code": "dc-123",
            "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 899,
            "interval": 5
        });
        let flow = parse_device_code(&body).unwrap();
        assert_eq!(flow.device_code, "dc-123");
        assert_eq!(flow.user_code, "ABCD-1234");
        assert_eq!(flow.verification_uri, "https://github.com/login/device");
        assert_eq!(flow.expires_in, 899);
        assert_eq!(flow.interval, 5);
    }

    #[test]
    fn device_code_missing_code_is_error() {
        assert!(parse_device_code(&json!({"user_code": "x"})).is_err());
    }

    #[test]
    fn poll_authorization_pending() {
        assert_eq!(
            parse_poll(&json!({"error": "authorization_pending"})),
            PollOutcome::Pending
        );
    }

    #[test]
    fn poll_slow_down_increases_interval() {
        let out = parse_poll(&json!({"error": "slow_down", "interval": 10}));
        assert_eq!(out, PollOutcome::SlowDown { interval: 10 });
        assert_eq!(next_poll_interval(5, &out), 10);
        let out2 = parse_poll(&json!({"error": "slow_down"}));
        assert_eq!(next_poll_interval(5, &out2), 10);
        assert_eq!(next_poll_interval(20, &out), 25);
    }

    #[test]
    fn poll_denied_and_expired() {
        assert_eq!(parse_poll(&json!({"error": "access_denied"})), PollOutcome::Denied);
        assert_eq!(parse_poll(&json!({"error": "expired_token"})), PollOutcome::Expired);
    }

    #[test]
    fn poll_success_extracts_token() {
        assert_eq!(
            parse_poll(&json!({"access_token": "gho_abc", "token_type": "bearer"})),
            PollOutcome::Success { access_token: "gho_abc".into() }
        );
    }

    #[test]
    fn cancellation_marks_status_cancelled() {
        let store: Arc<dyn SecretStore> = Arc::new(crate::secrets::InMemorySecretStore::new());
        let clock: Arc<dyn Clock> = Arc::new(FixedClock(0.into()));
        let transport: Arc<dyn HttpTransport> = Arc::new(FakeTransport::new(vec![]));
        let auth = CopilotAuth::new(transport, clock, store);
        auth.set_status(CopilotAuthStatus::AwaitingUser {
            flow_id: "f".into(),
            user_code: "U".into(),
            verification_uri: "v".into(),
            expires_at: 10,
        });
        auth.cancel();
        assert_eq!(auth.status(), CopilotAuthStatus::Cancelled);
    }

    #[test]
    fn copilot_token_refresh_skew_at_300s() {
        assert!(token_needs_refresh(None, 1000));
        let t = CopilotToken { token: "cop".into(), expires_at: 1000 };
        assert!(token_needs_refresh(Some(&t), 700));
        assert!(!token_needs_refresh(Some(&t), 699));
        assert!(token_needs_refresh(Some(&t), 1001));
    }

    #[test]
    fn endpoint_selection_prefers_chat_unless_responses_only() {
        assert_eq!(select_endpoint(&["/responses".into()]), CopilotEndpoint::Responses);
        assert_eq!(
            select_endpoint(&["/chat/completions".into(), "/responses".into()]),
            CopilotEndpoint::ChatCompletions
        );
        assert_eq!(select_endpoint(&["/chat/completions".into()]), CopilotEndpoint::ChatCompletions);
        assert_eq!(select_endpoint(&[]), CopilotEndpoint::ChatCompletions);
    }

    #[test]
    fn parses_models_with_supported_endpoints() {
        let body = json!({"data": [
            {"id": "gpt-4o", "supported_endpoints": ["/chat/completions", "/responses"]},
            {"id": "o1-resp", "supported_endpoints": ["/responses"]},
            {"id": ""}
        ]});
        let models = parse_models(&body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].endpoint, CopilotEndpoint::ChatCompletions);
        assert_eq!(models[1].endpoint, CopilotEndpoint::Responses);
    }

    #[test]
    fn request_id_is_random_hex() {
        let a = request_id();
        let b = request_id();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn status_never_serializes_a_token() {
        let s = CopilotAuthStatus::Connected { login: "octocat".into() };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("octocat"));
        assert!(!json.to_lowercase().contains("token"));
    }

    #[test]
    fn endpoint_for_model_uses_discovered_capability() {
        let models = vec![
            CopilotModel { id: "gpt-4o".into(), supported_endpoints: vec!["/chat/completions".into()], endpoint: CopilotEndpoint::ChatCompletions },
            CopilotModel { id: "o1".into(), supported_endpoints: vec!["/responses".into()], endpoint: CopilotEndpoint::Responses },
        ];
        assert_eq!(endpoint_for_model(&models, "gpt-4o"), CopilotEndpoint::ChatCompletions);
        assert_eq!(endpoint_for_model(&models, "o1"), CopilotEndpoint::Responses);
        // Unknown model defaults to chat.
        assert_eq!(endpoint_for_model(&models, "mystery"), CopilotEndpoint::ChatCompletions);
    }

    #[test]
    fn build_chat_request_targets_chat_path_with_bearer_and_request_id() {
        let r = build_copilot_request(
            CopilotEndpoint::ChatCompletions,
            "cop_tok",
            "gpt-4o",
            "sys",
            &[("user".into(), "hi".into())],
            &[],
        );
        assert_eq!(r.url, "https://api.githubcopilot.com/chat/completions");
        assert!(r.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer cop_tok"));
        assert!(r.headers.iter().any(|(k, _)| k == "X-Request-Id"));
        // GitHub token must never appear anywhere in the request.
        assert!(!format!("{r:?}").contains("gho_"));
        assert_eq!(r.body["model"], "gpt-4o");
        assert_eq!(r.body["messages"][0]["role"], "system");
    }

    #[test]
    fn build_responses_request_targets_responses_path_with_store_false() {
        let r = build_copilot_request(
            CopilotEndpoint::Responses,
            "cop_tok",
            "o1",
            "sys",
            &[("user".into(), "hi".into())],
            &[],
        );
        assert_eq!(r.url, "https://api.githubcopilot.com/responses");
        assert_eq!(r.body["store"], false);
        assert_eq!(r.body["input"][0]["role"], "system");
    }

    #[test]
    fn unsupported_chat_detection() {
        assert!(is_unsupported_chat(400, &json!({"error": {"message": "This model only supports the responses endpoint"}})));
        assert!(is_unsupported_chat(404, &json!({"error": {"code": "unsupported_endpoint"}})));
        // A normal auth error is not an unsupported-chat signal.
        assert!(!is_unsupported_chat(401, &json!({"error": {"message": "unauthorized"}})));
        // 200 never triggers fallback.
        assert!(!is_unsupported_chat(200, &json!({})));
    }
}

// ---------------------------------------------------------------------------
// HTTP-client tests (injectable transport, no real network)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod http_tests {
    use super::*;

    type Svc = (
        Arc<CopilotAuth>,
        Arc<FakeTransport>,
        Arc<crate::secrets::InMemorySecretStore>,
    );

    fn service(responses: Vec<HttpResponse>) -> Svc {
        let transport = Arc::new(FakeTransport::new(responses));
        let store = Arc::new(crate::secrets::InMemorySecretStore::new());
        let clock: Arc<dyn Clock> = Arc::new(FixedClock(1_000.into()));
        let t: Arc<dyn HttpTransport> = transport.clone();
        let s: Arc<dyn SecretStore> = store.clone();
        let auth = Arc::new(CopilotAuth::new(t, clock, s));
        (auth, transport, store)
    }

    #[tokio::test]
    async fn start_device_flow_posts_expected_fields() {
        let (auth, transport, _s) = service(vec![ok(json!({
            "device_code": "dc-1",
            "user_code": "WXYZ-9999",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900,
            "interval": 5
        }))]);
        let status = auth.start_device_flow().await.unwrap();
        match status {
            CopilotAuthStatus::AwaitingUser { user_code, expires_at, .. } => {
                assert_eq!(user_code, "WXYZ-9999");
                assert_eq!(expires_at, 1_900);
            }
            other => panic!("expected AwaitingUser, got {other:?}"),
        }
        let reqs = transport.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].url, DEVICE_CODE_URL);
        let body = reqs[0].body.as_ref().unwrap();
        assert_eq!(body["client_id"], CLIENT_ID);
        assert_eq!(body["scope"], SCOPE);
    }

    #[tokio::test]
    async fn poll_interval_increases_after_slow_down() {
        let (auth, _t, _s) = service(vec![
            ok(json!({"device_code": "dc-1", "user_code": "U", "interval": 5, "expires_in": 900})),
            ok(json!({"error": "authorization_pending"})),
            ok(json!({"error": "slow_down", "interval": 12})),
        ]);
        auth.start_device_flow().await.unwrap();
        assert_eq!(auth.poll_interval(), 5);
        assert_eq!(auth.poll_once().await.unwrap(), PollOutcome::Pending);
        assert_eq!(auth.poll_interval(), 5);
        assert_eq!(auth.poll_once().await.unwrap(), PollOutcome::SlowDown { interval: 12 });
        assert_eq!(auth.poll_interval(), 12);
    }

    #[tokio::test]
    async fn poll_success_stores_token_and_looks_up_user() {
        let (auth, transport, store) = service(vec![
            ok(json!({"device_code": "dc-1", "user_code": "U", "interval": 5, "expires_in": 900})),
            ok(json!({"access_token": "gho_secret"})),
            ok(json!({"login": "octocat"})),
        ]);
        auth.start_device_flow().await.unwrap();
        let outcome = auth.poll_once().await.unwrap();
        assert_eq!(outcome, PollOutcome::Success { access_token: "gho_secret".into() });
        assert_eq!(auth.status(), CopilotAuthStatus::Connected { login: "octocat".into() });
        assert_eq!(store.peek("github-copilot.token"), Some("gho_secret".into()));
        let reqs = transport.requests();
        let user_req = reqs.iter().find(|r| r.url == USER_URL).expect("user lookup");
        assert_eq!(user_req.method, "GET");
        assert!(user_req.headers.iter().any(|(k, v)| k == "Authorization" && v == "token gho_secret"));
    }

    #[tokio::test]
    async fn poll_denied_sets_error_status() {
        let (auth, _t, _s) = service(vec![
            ok(json!({"device_code": "dc-1", "user_code": "U", "interval": 5, "expires_in": 900})),
            ok(json!({"error": "access_denied"})),
        ]);
        auth.start_device_flow().await.unwrap();
        assert_eq!(auth.poll_once().await.unwrap(), PollOutcome::Denied);
        assert!(matches!(auth.status(), CopilotAuthStatus::Error { .. }));
    }

    #[tokio::test]
    async fn poll_expired_sets_expired_status() {
        let (auth, _t, _s) = service(vec![
            ok(json!({"device_code": "dc-1", "user_code": "U", "interval": 5, "expires_in": 900})),
            ok(json!({"error": "expired_token"})),
        ]);
        auth.start_device_flow().await.unwrap();
        assert_eq!(auth.poll_once().await.unwrap(), PollOutcome::Expired);
        assert_eq!(auth.status(), CopilotAuthStatus::Expired);
    }

    #[tokio::test]
    async fn cancel_stops_polling() {
        let (auth, _t, _s) = service(vec![
            ok(json!({"device_code": "dc-1", "user_code": "U", "interval": 5, "expires_in": 900})),
        ]);
        auth.start_device_flow().await.unwrap();
        auth.cancel();
        assert_eq!(auth.status(), CopilotAuthStatus::Cancelled);
        let outcome = auth.poll_once().await.unwrap();
        assert!(matches!(outcome, PollOutcome::Error { .. }));
    }

    #[tokio::test]
    async fn manual_token_connect_validates_and_persists() {
        let (auth, transport, store) = service(vec![ok(json!({"login": "manualuser"}))]);
        let status = auth.connect_with_token("  ghp_manual  ").await.unwrap();
        assert_eq!(status, CopilotAuthStatus::Connected { login: "manualuser".into() });
        assert_eq!(store.peek("github-copilot.token"), Some("ghp_manual".into()));
        assert_eq!(transport.requests()[0].url, USER_URL);
    }

    #[tokio::test]
    async fn list_models_exchanges_token_then_lists() {
        let (auth, transport, store) = service(vec![
            ok(json!({"token": "cop_abc", "expires_at": 9_999_999})),
            ok(json!({"data": [{"id": "gpt-4o", "supported_endpoints": ["/chat/completions"]}]})),
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        let models = auth.list_models().await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-4o");
        let reqs = transport.requests();
        let tok = reqs.iter().find(|r| r.url == COPILOT_TOKEN_URL).expect("token exchange");
        assert!(tok.headers.iter().any(|(k, v)| k == "Authorization" && v == "token gho_secret"));
        let m = reqs.iter().find(|r| r.url == MODELS_URL).expect("models call");
        assert!(m.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer cop_abc"));
        assert!(m.headers.iter().any(|(k, v)| k == "Copilot-Integration-Id" && v == COPILOT_INTEGRATION_ID));
        assert!(m.headers.iter().any(|(k, v)| k == "Editor-Version" && v == COPILOT_EDITOR_VERSION));
        assert!(m.headers.iter().any(|(k, _)| k == "X-Request-Id"));
        assert!(!m.headers.iter().any(|(_, v)| v.contains("gho_secret")));
    }

    #[tokio::test]
    async fn list_models_forces_single_refresh_on_401() {
        let (auth, transport, store) = service(vec![
            ok(json!({"token": "cop_stale", "expires_at": 9_999_999})),
            HttpResponse { status: 401, body: json!({"error": "unauthorized"}) },
            ok(json!({"token": "cop_fresh", "expires_at": 9_999_999})),
            ok(json!({"data": [{"id": "gpt-4o", "supported_endpoints": []}]})),
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        let models = auth.list_models().await.unwrap();
        assert_eq!(models.len(), 1);
        let reqs = transport.requests();
        assert_eq!(reqs.iter().filter(|r| r.url == COPILOT_TOKEN_URL).count(), 2);
        assert_eq!(reqs.iter().filter(|r| r.url == MODELS_URL).count(), 2);
        let last = reqs.iter().rev().find(|r| r.url == MODELS_URL).unwrap();
        assert!(last.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer cop_fresh"));
    }

    #[tokio::test]
    async fn list_models_does_not_retry_twice_on_repeated_403() {
        let (auth, _t, store) = service(vec![
            ok(json!({"token": "cop_stale", "expires_at": 9_999_999})),
            HttpResponse { status: 403, body: json!({"error": "forbidden"}) },
            ok(json!({"token": "cop_fresh", "expires_at": 9_999_999})),
            HttpResponse { status: 403, body: json!({"error": "forbidden"}) },
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        assert!(auth.list_models().await.is_err());
    }

    #[tokio::test]
    async fn disconnect_clears_credential_and_status() {
        let (auth, _t, store) = service(vec![ok(json!({"login": "u"}))]);
        auth.connect_with_token("ghp_x").await.unwrap();
        assert!(auth.credential_present());
        auth.disconnect().unwrap();
        assert_eq!(auth.status(), CopilotAuthStatus::Disconnected);
        assert_eq!(store.peek("github-copilot.token"), None);
        assert!(!auth.credential_present());
    }

    #[tokio::test]
    async fn cached_copilot_token_reused_within_skew() {
        let (auth, transport, store) = service(vec![
            ok(json!({"token": "cop_abc", "expires_at": 9_999_999})),
            ok(json!({"data": []})),
            ok(json!({"data": []})),
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        auth.list_models().await.unwrap();
        auth.list_models().await.unwrap();
        assert_eq!(
            transport.requests().iter().filter(|r| r.url == COPILOT_TOKEN_URL).count(),
            1
        );
    }

    const CHAT_URL: &str = "https://api.githubcopilot.com/chat/completions";
    const RESP_URL: &str = "https://api.githubcopilot.com/responses";

    #[tokio::test]
    async fn infer_routes_chat_model_and_never_sends_github_token() {
        let (auth, transport, store) = service(vec![
            // list_models discovery (cache empty on first infer)
            ok(json!({"token": "cop_abc", "expires_at": 9_999_999})),
            ok(json!({"data": [{"id": "gpt-4o", "supported_endpoints": ["/chat/completions"]}]})),
            // inference
            ok(json!({"choices": [{"message": {"content": "hello"}}]})),
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        let turn = auth.infer("gpt-4o", "sys", &[("user".into(), "hi".into())], &[]).await.unwrap();
        assert_eq!(turn.text, "hello");
        let reqs = transport.requests();
        let chat = reqs.iter().find(|r| r.url == CHAT_URL).expect("chat inference call");
        // Uses the exchanged Copilot token, never the GitHub token.
        assert!(chat.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer cop_abc"));
        assert!(chat.headers.iter().any(|(k, _)| k == "X-Request-Id"));
        let dump = format!("{reqs:?}");
        // GitHub token was only ever sent to github.com hosts (token exchange),
        // never to the inference host.
        assert!(!chat.headers.iter().any(|(_, v)| v.contains("gho_secret")));
        assert!(!chat.body.as_ref().map(|b| b.to_string().contains("gho_secret")).unwrap_or(false));
        let _ = dump;
    }

    #[tokio::test]
    async fn infer_routes_responses_only_model() {
        let (auth, transport, store) = service(vec![
            ok(json!({"token": "cop_abc", "expires_at": 9_999_999})),
            ok(json!({"data": [{"id": "o1", "supported_endpoints": ["/responses"]}]})),
            ok(json!({"output": [{"type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "resp-ans"}]}]})),
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        let turn = auth.infer("o1", "sys", &[("user".into(), "hi".into())], &[]).await.unwrap();
        assert_eq!(turn.text, "resp-ans");
        let reqs = transport.requests();
        assert!(reqs.iter().any(|r| r.url == RESP_URL), "responses-only model must hit /responses");
        assert!(!reqs.iter().any(|r| r.url == CHAT_URL));
    }

    #[tokio::test]
    async fn infer_forces_single_refresh_on_401() {
        let (auth, transport, store) = service(vec![
            ok(json!({"token": "cop_stale", "expires_at": 9_999_999})),
            ok(json!({"data": [{"id": "gpt-4o", "supported_endpoints": ["/chat/completions"]}]})),
            // inference -> 401
            HttpResponse { status: 401, body: json!({"error": {"message": "unauthorized"}}) },
            // forced token refresh
            ok(json!({"token": "cop_fresh", "expires_at": 9_999_999})),
            // retry -> 200
            ok(json!({"choices": [{"message": {"content": "ok"}}]})),
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        let turn = auth.infer("gpt-4o", "sys", &[("user".into(), "hi".into())], &[]).await.unwrap();
        assert_eq!(turn.text, "ok");
        let reqs = transport.requests();
        assert_eq!(reqs.iter().filter(|r| r.url == CHAT_URL).count(), 2);
        let last = reqs.iter().rev().find(|r| r.url == CHAT_URL).unwrap();
        assert!(last.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer cop_fresh"));
    }

    #[tokio::test]
    async fn infer_does_not_retry_twice_on_repeated_401() {
        let (auth, _t, store) = service(vec![
            ok(json!({"token": "cop_stale", "expires_at": 9_999_999})),
            ok(json!({"data": [{"id": "gpt-4o", "supported_endpoints": ["/chat/completions"]}]})),
            HttpResponse { status: 401, body: json!({"error": {"message": "unauthorized"}}) },
            ok(json!({"token": "cop_fresh", "expires_at": 9_999_999})),
            HttpResponse { status: 401, body: json!({"error": {"message": "unauthorized"}}) },
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        assert!(auth.infer("gpt-4o", "sys", &[("user".into(), "hi".into())], &[]).await.is_err());
    }

    #[tokio::test]
    async fn infer_falls_back_to_responses_once_on_unsupported_chat() {
        let (auth, transport, store) = service(vec![
            ok(json!({"token": "cop_abc", "expires_at": 9_999_999})),
            // Discovery routes gpt-x to chat, but the server rejects chat.
            ok(json!({"data": [{"id": "gpt-x", "supported_endpoints": ["/chat/completions"]}]})),
            HttpResponse { status: 400, body: json!({"error": {"message": "This model only supports the responses endpoint"}}) },
            // fallback to responses -> 200 (realistic Responses output shape)
            ok(json!({"output": [{"type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "fallback-ok"}]}]})),
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        let turn = auth.infer("gpt-x", "sys", &[("user".into(), "hi".into())], &[]).await.unwrap();
        assert_eq!(turn.text, "fallback-ok");
        let reqs = transport.requests();
        assert_eq!(reqs.iter().filter(|r| r.url == CHAT_URL).count(), 1);
        assert_eq!(reqs.iter().filter(|r| r.url == RESP_URL).count(), 1);
    }

    #[tokio::test]
    async fn infer_responses_tool_call_maps_to_parsed_turn() {
        let (auth, _t, store) = service(vec![
            ok(json!({"token": "cop_abc", "expires_at": 9_999_999})),
            ok(json!({"data": [{"id": "o1", "supported_endpoints": ["/responses"]}]})),
            ok(json!({"output": [
                {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "checking"}]},
                {"type": "function_call", "call_id": "call_1",
                 "name": "read", "arguments": "{\"path\":\"/tmp/a\"}"}
            ]})),
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        let turn = auth.infer("o1", "sys", &[("user".into(), "hi".into())], &[]).await.unwrap();
        assert_eq!(turn.text, "checking");
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "read");
        assert_eq!(turn.tool_calls[0].args["path"], "/tmp/a");
    }

    #[tokio::test]
    async fn infer_fallback_is_bounded_to_once() {
        let (auth, _t, store) = service(vec![
            ok(json!({"token": "cop_abc", "expires_at": 9_999_999})),
            ok(json!({"data": [{"id": "gpt-x", "supported_endpoints": ["/chat/completions"]}]})),
            HttpResponse { status: 400, body: json!({"error": {"message": "only supports responses, unsupported chat"}}) },
            // responses also errors with unsupported-chat-ish text; must NOT loop.
            HttpResponse { status: 400, body: json!({"error": {"message": "still only responses unsupported"}}) },
        ]);
        store.set("github-copilot.token", "gho_secret").unwrap();
        assert!(auth.infer("gpt-x", "sys", &[("user".into(), "hi".into())], &[]).await.is_err());
    }
}
