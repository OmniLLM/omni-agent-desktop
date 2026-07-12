//! Provider settings model, migration, validation, and atomic persistence.
//!
//! This module owns the desktop's persisted `AppSettings`. It supports three
//! provider types, each with an independent saved profile, while one provider
//! is active at a time. Legacy flat AI fields (`ai_base_url`, `ai_api_key`,
//! `ai_model`) are preserved as compatibility projections of the active
//! provider and are used to migrate pre-existing settings files.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Provider enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderType {
    CustomProvider,
    GithubCopilot,
    AzureFoundry,
}

impl ProviderType {
    pub const ALL: [ProviderType; 3] = [
        ProviderType::CustomProvider,
        ProviderType::GithubCopilot,
        ProviderType::AzureFoundry,
    ];
}

impl Default for ProviderType {
    fn default() -> Self {
        ProviderType::CustomProvider
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApiShape {
    OpenaiCompatible,
    AnthropicMessages,
    OpenaiResponses,
}

impl Default for ApiShape {
    fn default() -> Self {
        ApiShape::OpenaiCompatible
    }
}

// ---------------------------------------------------------------------------
// Window size preset
// ---------------------------------------------------------------------------

/// The persisted window size preset. Serializes as kebab-case. Unknown values
/// (e.g. from a future release) normalize back to `Standard` on load so the
/// setting remains backward/forward compatible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowSizePreset {
    Compact,
    Standard,
    Large,
}

impl Default for WindowSizePreset {
    fn default() -> Self {
        WindowSizePreset::Standard
    }
}

impl<'de> Deserialize<'de> for WindowSizePreset {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Ok(match raw.as_str() {
            "compact" => WindowSizePreset::Compact,
            "large" => WindowSizePreset::Large,
            _ => WindowSizePreset::Standard,
        })
    }
}

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

/// A single Azure Foundry mapping from a logical `model` name to the concrete
/// `deployment` name used by the Azure endpoint. Both fields are non-secret and
/// safe to persist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AzureDeploymentMapping {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub deployment: String,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(default)]
    pub endpoint: String,
    /// Plaintext secret for NON-protected providers only (custom provider). For
    /// protected providers (Azure Foundry, GitHub Copilot) this is empty in
    /// persisted settings and in the frontend view; the real secret lives in the
    /// OS credential store and is hydrated into this field only on native
    /// runtime paths. Never send a protected secret to React.
    #[serde(default)]
    pub api_key: String,
    /// Non-secret presence flag: true when a protected credential exists in the
    /// credential store for this provider. Lets the UI show "key configured"
    /// without ever receiving the secret value. Derived, not authoritative;
    /// omitted from persisted settings when false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub api_key_stored: bool,
    #[serde(default)]
    pub api_shape: ApiShape,
    #[serde(default)]
    pub model: String,
    /// Authoritative Azure model→deployment mappings.
    #[serde(default)]
    pub azure_deployments: Vec<AzureDeploymentMapping>,
    /// Azure REST API version (e.g. "2024-02-01"). Non-secret.
    #[serde(default)]
    pub azure_api_version: String,
    /// Legacy free-text deployment list. Retained only as migration input for
    /// older settings files; not the authoritative Azure contract.
    #[serde(default)]
    pub manual_models: String,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            api_key: String::new(),
            api_key_stored: false,
            api_shape: ApiShape::default(),
            model: String::new(),
            azure_deployments: Vec::new(),
            azure_api_version: String::new(),
            manual_models: String::new(),
        }
    }
}

impl ProviderConfig {
    /// Return the effective Azure deployment mappings for this profile,
    /// migrating from the legacy `manual_models` free-text list when the
    /// structured `azure_deployments` field is empty. In the legacy case each
    /// entry maps a model name to an identically-named deployment.
    pub fn effective_azure_deployments(&self) -> Vec<AzureDeploymentMapping> {
        if !self.azure_deployments.is_empty() {
            return self.azure_deployments.clone();
        }
        parse_manual_models(&self.manual_models)
            .into_iter()
            .map(|name| AzureDeploymentMapping {
                model: name.clone(),
                deployment: name,
            })
            .collect()
    }
}

/// A serde-friendly map of provider profiles. Uses a `BTreeMap` internally so
/// serialization order is stable, while exposing helpers for typed access.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProviderConfigMap(pub BTreeMap<ProviderType, ProviderConfig>);

impl ProviderConfigMap {
    /// A map with an empty default profile for every provider type.
    pub fn defaults() -> Self {
        let mut map = BTreeMap::new();
        for provider in ProviderType::ALL {
            map.insert(provider, ProviderConfig::default());
        }
        ProviderConfigMap(map)
    }

    pub fn get(&self, provider: ProviderType) -> Option<&ProviderConfig> {
        self.0.get(&provider)
    }

    pub fn get_mut(&mut self, provider: ProviderType) -> &mut ProviderConfig {
        self.0.entry(provider).or_default()
    }

    /// Ensure a profile exists for every provider type, inserting defaults for
    /// any that are missing. Existing profiles are never modified.
    pub fn fill_missing(&mut self) {
        for provider in ProviderType::ALL {
            self.0.entry(provider).or_default();
        }
    }
}

impl Default for ProviderConfigMap {
    fn default() -> Self {
        ProviderConfigMap::defaults()
    }
}

// ---------------------------------------------------------------------------
// Azure deployment mapping contract
// ---------------------------------------------------------------------------

/// The validated Azure mapping contract: a set of unique, non-empty
/// model/deployment mappings, an `api_version`, and the currently selected
/// model (which must be one of the mapped models).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AzureMappingContract {
    pub mappings: Vec<AzureDeploymentMapping>,
    pub api_version: String,
    pub selected_model: String,
}

/// Validate the Azure mapping contract. Rejects empty `model`/`deployment`
/// entries, duplicate models, duplicate deployments, a blank `api_version`, and
/// a `selected_model` that is not among the mapped models.
pub fn validate_azure_mappings(
    mappings: &[AzureDeploymentMapping],
    api_version: &str,
    selected_model: &str,
) -> Result<AzureMappingContract, ValidationError> {
    if mappings.is_empty() {
        return Err(ValidationError(
            "At least one deployment/model mapping is required".to_string(),
        ));
    }
    let mut seen_models = std::collections::HashSet::new();
    let mut seen_deployments = std::collections::HashSet::new();
    for m in mappings {
        let model = m.model.trim();
        let deployment = m.deployment.trim();
        require(model, "Mapping model is required")?;
        require(deployment, "Mapping deployment is required")?;
        if !seen_models.insert(model.to_string()) {
            return Err(ValidationError(format!("Duplicate model mapping: {model}")));
        }
        if !seen_deployments.insert(deployment.to_string()) {
            return Err(ValidationError(format!(
                "Duplicate deployment mapping: {deployment}"
            )));
        }
    }
    require(api_version, "API version is required")?;
    require(selected_model, "Selected model is required")?;
    if !mappings
        .iter()
        .any(|m| m.model.trim() == selected_model.trim())
    {
        return Err(ValidationError(
            "Selected model is not in the mapping list".to_string(),
        ));
    }
    Ok(AzureMappingContract {
        mappings: mappings.to_vec(),
        api_version: api_version.trim().to_string(),
        selected_model: selected_model.trim().to_string(),
    })
}

// ---------------------------------------------------------------------------
// A2A connections
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct A2aConnection {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub endpoint: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub enabled: bool,
    /// Skill ids explicitly disabled by the user.
    #[serde(default)]
    pub disabled_skills: Vec<String>,
}

// ---------------------------------------------------------------------------
// AppSettings
// ---------------------------------------------------------------------------

fn default_ai_timeout_secs() -> u64 {
    120
}
fn default_ai_max_tool_iterations() -> usize {
    10
}
fn default_ai_max_retry_attempts() -> u32 {
    3
}
fn default_ai_retry_base_delay_ms() -> u64 {
    2000
}
fn default_ai_loop_detector_enabled() -> bool {
    true
}
fn default_theme() -> String {
    "system".to_string()
}
fn default_hotkey() -> String {
    "Ctrl+Shift+O".to_string()
}
fn default_max_results() -> usize {
    10
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub ai_base_url: String,
    #[serde(default)]
    pub ai_model: String,
    #[serde(default)]
    pub ai_api_key: String,
    #[serde(default)]
    pub active_provider: ProviderType,
    /// Present only after migration/save. Absence triggers legacy migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_configs: Option<ProviderConfigMap>,
    #[serde(default = "default_ai_timeout_secs")]
    pub ai_timeout_secs: u64,
    #[serde(default = "default_ai_max_tool_iterations")]
    pub ai_max_tool_iterations: usize,
    #[serde(default = "default_ai_max_retry_attempts")]
    pub ai_max_retry_attempts: u32,
    #[serde(default = "default_ai_retry_base_delay_ms")]
    pub ai_retry_base_delay_ms: u64,
    #[serde(default = "default_ai_loop_detector_enabled")]
    pub ai_loop_detector_enabled: bool,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_hotkey")]
    pub hotkey: String,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
    #[serde(default)]
    pub background_url: String,
    #[serde(default)]
    pub a2a_connections: Vec<A2aConnection>,
    #[serde(default)]
    pub run_mode: crate::agent::RunMode,
    /// Deprecated compatibility field. Desktop no longer uses or defaults an
    /// OmniLauncher REST backend URL; task/tool execution is A2A.
    #[serde(default)]
    pub backend_url: String,
    #[serde(default)]
    pub window_size: WindowSizePreset,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            ai_base_url: String::new(),
            ai_model: String::new(),
            ai_api_key: String::new(),
            active_provider: ProviderType::default(),
            provider_configs: Some(ProviderConfigMap::defaults()),
            ai_timeout_secs: default_ai_timeout_secs(),
            ai_max_tool_iterations: default_ai_max_tool_iterations(),
            ai_max_retry_attempts: default_ai_max_retry_attempts(),
            ai_retry_base_delay_ms: default_ai_retry_base_delay_ms(),
            ai_loop_detector_enabled: default_ai_loop_detector_enabled(),
            theme: default_theme(),
            hotkey: default_hotkey(),
            max_results: default_max_results(),
            background_url: String::new(),
            a2a_connections: Vec::new(),
            run_mode: crate::agent::RunMode::default(),
            backend_url: String::new(),
            window_size: WindowSizePreset::default(),
        }
    }
}

impl AppSettings {
    /// Returns the provider config map, migrating from legacy flat fields when
    /// `provider_configs` is absent. Never mutates `self`.
    pub fn effective_provider_configs(&self) -> ProviderConfigMap {
        match &self.provider_configs {
            Some(map) => {
                let mut map = map.clone();
                map.fill_missing();
                map
            }
            None => self.migrated_provider_configs(),
        }
    }

    /// Build a provider config map from legacy flat fields. The custom profile
    /// is derived from `ai_base_url`/`ai_api_key`/`ai_model`; other providers
    /// get empty defaults.
    fn migrated_provider_configs(&self) -> ProviderConfigMap {
        let mut map = ProviderConfigMap::defaults();
        let custom = map.get_mut(ProviderType::CustomProvider);
        custom.endpoint = self.ai_base_url.clone();
        custom.api_key = self.ai_api_key.clone();
        custom.model = self.ai_model.clone();
        custom.api_shape = infer_api_shape(&self.ai_base_url);
        map
    }

    /// Produce a fully-migrated clone: provider configs are materialized,
    /// active provider defaults to custom, and shared fields are preserved.
    /// Loading uses this for the in-memory view but does NOT persist it.
    pub fn migrated(&self) -> AppSettings {
        let mut out = self.clone();
        out.provider_configs = Some(self.effective_provider_configs());
        out
    }
}

/// Infer the API shape for a legacy custom endpoint. The known OmniLLM endpoint
/// serves an Anthropic Messages-compatible API; everything else is treated as
/// OpenAI-compatible.
pub fn infer_api_shape(endpoint: &str) -> ApiShape {
    let lower = endpoint.to_ascii_lowercase();
    if lower.contains("omnillm") {
        ApiShape::AnthropicMessages
    } else {
        ApiShape::OpenaiCompatible
    }
}

// ---------------------------------------------------------------------------
// Manual model list parsing
// ---------------------------------------------------------------------------

/// Parse a newline- or comma-separated model/deployment list: trim whitespace,
/// drop empty entries, and de-duplicate while retaining first-seen order.
pub fn parse_manual_models(raw: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for token in raw.split(['\n', '\r', ',']) {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            out.push(trimmed.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError(pub String);

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Validate a provider profile for activation.
///
/// GitHub Copilot connectivity is decided by an injected `copilot_connected`
/// flag, because authentication state lives outside settings (a later task).
pub fn validate_provider(
    provider: ProviderType,
    config: &ProviderConfig,
    copilot_connected: bool,
) -> Result<(), ValidationError> {
    match provider {
        ProviderType::CustomProvider => {
            require(&config.endpoint, "Endpoint is required")?;
            require(&config.api_key, "API key is required")?;
            require(&config.model, "Model is required")?;
            Ok(())
        }
        ProviderType::GithubCopilot => {
            if !copilot_connected {
                return Err(ValidationError(
                    "GitHub Copilot is not connected".to_string(),
                ));
            }
            require(&config.model, "Model is required")?;
            Ok(())
        }
        ProviderType::AzureFoundry => {
            require(&config.endpoint, "Endpoint is required")?;
            // A protected credential is satisfied by either a live plaintext key
            // (pre-redaction save) or a credential already in the store.
            if config.api_key.trim().is_empty() && !config.api_key_stored {
                return Err(ValidationError("API key is required".to_string()));
            }
            // Authoritative Azure contract: structured mappings + api version +
            // selected model membership. Legacy `manual_models` is migrated by
            // `effective_azure_deployments`.
            let mappings = config.effective_azure_deployments();
            validate_azure_mappings(&mappings, &config.azure_api_version, &config.model)?;
            Ok(())
        }
    }
}

fn require(value: &str, message: &str) -> Result<(), ValidationError> {
    if value.trim().is_empty() {
        Err(ValidationError(message.to_string()))
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Compatibility projection
// ---------------------------------------------------------------------------

/// Project the active provider's effective values onto the legacy flat
/// compatibility fields. Copilot has no endpoint/api key, so those are cleared
/// while the model is still mirrored.
pub fn project_compatibility_fields(settings: &mut AppSettings) {
    let configs = settings.effective_provider_configs();
    if let Some(active) = configs.get(settings.active_provider) {
        match settings.active_provider {
            ProviderType::GithubCopilot => {
                settings.ai_base_url = String::new();
                settings.ai_api_key = String::new();
                settings.ai_model = active.model.clone();
            }
            _ => {
                settings.ai_base_url = active.endpoint.clone();
                settings.ai_api_key = active.api_key.clone();
                settings.ai_model = active.model.clone();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// Load settings from `path`, falling back to `legacy_path`, then to defaults.
/// Migration is applied in memory only; the file is not rewritten here.
pub fn load_settings(path: &Path, legacy_path: &Path) -> AppSettings {
    read_settings_from(path)
        .or_else(|| read_settings_from(legacy_path))
        .map(|s| s.migrated())
        .unwrap_or_default()
}

fn read_settings_from(path: &Path) -> Option<AppSettings> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<AppSettings>(&text).ok())
}

/// Validate the active provider, project compatibility fields, and atomically
/// persist. On failure the previous file is left untouched.
#[cfg(test)]
pub fn save_settings(
    path: &Path,
    mut settings: AppSettings,
    copilot_connected: bool,
) -> Result<AppSettings, String> {
    // Materialize provider configs so the persisted file is self-describing.
    settings.provider_configs = Some(settings.effective_provider_configs());

    let active_config = settings
        .provider_configs
        .as_ref()
        .and_then(|m| m.get(settings.active_provider))
        .cloned()
        .unwrap_or_default();
    validate_provider(settings.active_provider, &active_config, copilot_connected)
        .map_err(|e| e.0)?;

    project_compatibility_fields(&mut settings);

    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    atomic_write(path, &json)?;
    Ok(settings)
}

/// Write `contents` to `path` atomically: write to a sibling temp file, then
/// rename over the target. On Windows `fs::rename` fails if the destination
/// exists, so fall back to remove+rename.
pub fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = temp_sibling(path);
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Windows: destination exists. Remove then rename.
            let _ = fs::remove_file(path);
            fs::rename(&tmp, path).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                e.to_string()
            })
        }
    }
}

fn temp_sibling(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "settings.json".to_string());
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    name.push_str(&format!(".{pid}.{nanos}.tmp"));
    match path.parent() {
        Some(parent) => parent.join(name),
        None => PathBuf::from(name),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omni-settings-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a2a_connections_default_empty_and_roundtrip() {
        let s: AppSettings = serde_json::from_str("{}").unwrap();
        assert!(s.a2a_connections.is_empty());
        assert_eq!(s.run_mode, crate::agent::RunMode::Ask);
    }

    // --- Window size preset -------------------------------------------------

    #[test]
    fn window_size_defaults_to_standard() {
        let s: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.window_size, WindowSizePreset::Standard);
    }

    #[test]
    fn window_size_presets_roundtrip() {
        for preset in [
            WindowSizePreset::Compact,
            WindowSizePreset::Standard,
            WindowSizePreset::Large,
        ] {
            let json = serde_json::to_string(&preset).unwrap();
            let back: WindowSizePreset = serde_json::from_str(&json).unwrap();
            assert_eq!(back, preset);
        }
    }

    #[test]
    fn unknown_window_size_normalizes_to_standard() {
        let s: AppSettings = serde_json::from_str(r#"{"window_size":"future-size"}"#).unwrap();
        assert_eq!(s.window_size, WindowSizePreset::Standard);
    }

    // --- Legacy migration ---------------------------------------------------

    #[test]
    fn legacy_flat_settings_migrate_into_custom_profile() {
        let legacy = r#"{
            "ai_base_url": "https://api.example.com",
            "ai_model": "gpt-4",
            "ai_api_key": "sk-legacy"
        }"#;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();
        assert!(settings.provider_configs.is_none());

        let configs = settings.effective_provider_configs();
        let custom = configs.get(ProviderType::CustomProvider).unwrap();
        assert_eq!(custom.endpoint, "https://api.example.com");
        assert_eq!(custom.api_key, "sk-legacy");
        assert_eq!(custom.model, "gpt-4");
        assert_eq!(custom.api_shape, ApiShape::OpenaiCompatible);
        assert_eq!(settings.active_provider, ProviderType::CustomProvider);
        // Other profiles default and empty.
        assert_eq!(
            configs.get(ProviderType::AzureFoundry).unwrap(),
            &ProviderConfig::default()
        );
    }

    #[test]
    fn legacy_omnillm_endpoint_infers_anthropic_messages() {
        let legacy = r#"{
            "ai_base_url": "https://omnillm.internal/api",
            "ai_model": "claude",
            "ai_api_key": "sk-x"
        }"#;
        let settings: AppSettings = serde_json::from_str(legacy).unwrap();
        let configs = settings.effective_provider_configs();
        let custom = configs.get(ProviderType::CustomProvider).unwrap();
        assert_eq!(custom.api_shape, ApiShape::AnthropicMessages);
    }

    #[test]
    fn loading_legacy_does_not_rewrite_file() {
        let dir = tmp_dir();
        let path = dir.join("settings.json");
        let legacy = "{\n  \"ai_base_url\": \"https://api.example.com\",\n  \"ai_model\": \"gpt-4\",\n  \"ai_api_key\": \"sk-legacy\"\n}";
        fs::write(&path, legacy).unwrap();

        let missing = dir.join("nope.json");
        let loaded = load_settings(&path, &missing);
        // In-memory view is migrated.
        assert!(loaded.provider_configs.is_some());
        // File on disk is unchanged.
        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(after, legacy);
    }

    // --- Profile precedence -------------------------------------------------

    #[test]
    fn existing_profiles_win_over_legacy_flat_fields() {
        let json = r#"{
            "ai_base_url": "https://legacy.example.com",
            "ai_model": "legacy-model",
            "ai_api_key": "sk-legacy",
            "active_provider": "azure-foundry",
            "provider_configs": {
                "custom-provider": {
                    "endpoint": "https://saved.example.com",
                    "api_key": "sk-saved",
                    "api_shape": "openai-responses",
                    "model": "saved-model",
                    "manual_models": ""
                }
            }
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        let configs = settings.effective_provider_configs();
        let custom = configs.get(ProviderType::CustomProvider).unwrap();
        // Saved profile is not overwritten by legacy flat fields.
        assert_eq!(custom.endpoint, "https://saved.example.com");
        assert_eq!(custom.model, "saved-model");
        assert_eq!(custom.api_shape, ApiShape::OpenaiResponses);
        // Missing profiles are backfilled with defaults.
        assert_eq!(
            configs.get(ProviderType::GithubCopilot).unwrap(),
            &ProviderConfig::default()
        );
        assert_eq!(settings.active_provider, ProviderType::AzureFoundry);
    }

    // --- Serde defaults / roundtrip ----------------------------------------

    #[test]
    fn serde_defaults_fill_shared_fields() {
        let settings: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.ai_timeout_secs, 120);
        assert_eq!(settings.ai_max_tool_iterations, 10);
        assert_eq!(settings.ai_max_retry_attempts, 3);
        assert_eq!(settings.ai_retry_base_delay_ms, 2000);
        assert!(settings.ai_loop_detector_enabled);
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.hotkey, "Ctrl+Shift+O");
        assert_eq!(settings.max_results, 10);
        assert_eq!(settings.active_provider, ProviderType::CustomProvider);
    }

    #[test]
    fn roundtrip_preserves_provider_configs() {
        let mut settings = AppSettings::default();
        settings.active_provider = ProviderType::AzureFoundry;
        {
            let configs = settings.provider_configs.as_mut().unwrap();
            let azure = configs.get_mut(ProviderType::AzureFoundry);
            azure.endpoint = "https://azure.example.com".to_string();
            azure.api_key = "sk-azure".to_string();
            azure.manual_models = "m1, m2".to_string();
            azure.model = "m1".to_string();
        }
        let json = serde_json::to_string(&settings).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, settings);
    }

    #[test]
    fn provider_type_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ProviderType::GithubCopilot).unwrap(),
            "\"github-copilot\""
        );
        assert_eq!(
            serde_json::to_string(&ApiShape::AnthropicMessages).unwrap(),
            "\"anthropic-messages\""
        );
    }

    // --- Compatibility projection ------------------------------------------

    #[test]
    fn projection_mirrors_active_custom_provider() {
        let mut settings = AppSettings::default();
        settings.active_provider = ProviderType::CustomProvider;
        {
            let c = settings
                .provider_configs
                .as_mut()
                .unwrap()
                .get_mut(ProviderType::CustomProvider);
            c.endpoint = "https://c.example.com".to_string();
            c.api_key = "sk-c".to_string();
            c.model = "cm".to_string();
        }
        project_compatibility_fields(&mut settings);
        assert_eq!(settings.ai_base_url, "https://c.example.com");
        assert_eq!(settings.ai_api_key, "sk-c");
        assert_eq!(settings.ai_model, "cm");
    }

    #[test]
    fn projection_clears_endpoint_for_copilot() {
        let mut settings = AppSettings::default();
        settings.active_provider = ProviderType::GithubCopilot;
        {
            let c = settings
                .provider_configs
                .as_mut()
                .unwrap()
                .get_mut(ProviderType::GithubCopilot);
            c.model = "copilot-model".to_string();
        }
        settings.ai_base_url = "stale".to_string();
        settings.ai_api_key = "stale".to_string();
        project_compatibility_fields(&mut settings);
        assert_eq!(settings.ai_base_url, "");
        assert_eq!(settings.ai_api_key, "");
        assert_eq!(settings.ai_model, "copilot-model");
    }

    // --- Validation ---------------------------------------------------------

    #[test]
    fn custom_validation_requires_endpoint_key_model() {
        let mut c = ProviderConfig::default();
        assert!(validate_provider(ProviderType::CustomProvider, &c, false).is_err());
        c.endpoint = "https://e".to_string();
        assert!(validate_provider(ProviderType::CustomProvider, &c, false).is_err());
        c.api_key = "k".to_string();
        assert!(validate_provider(ProviderType::CustomProvider, &c, false).is_err());
        c.model = "m".to_string();
        assert!(validate_provider(ProviderType::CustomProvider, &c, false).is_ok());
    }

    #[test]
    fn copilot_validation_uses_injected_connected_flag() {
        let mut c = ProviderConfig::default();
        c.model = "m".to_string();
        // Not connected: invalid even with a model.
        assert!(validate_provider(ProviderType::GithubCopilot, &c, false).is_err());
        // Connected but no model: invalid.
        let empty = ProviderConfig::default();
        assert!(validate_provider(ProviderType::GithubCopilot, &empty, true).is_err());
        // Connected + model: valid.
        assert!(validate_provider(ProviderType::GithubCopilot, &c, true).is_ok());
    }

    #[test]
    fn azure_validation_legacy_manual_models_still_validates() {
        // Legacy path: manual_models migrates into structured mappings.
        let mut c = ProviderConfig::default();
        c.endpoint = "https://a".to_string();
        c.api_key = "k".to_string();
        c.azure_api_version = "2024-02-01".to_string();
        // Empty list.
        assert!(validate_provider(ProviderType::AzureFoundry, &c, false).is_err());
        c.manual_models = " , \n ".to_string();
        assert!(validate_provider(ProviderType::AzureFoundry, &c, false).is_err());
        c.manual_models = "dep1, dep2".to_string();
        // No selected model.
        assert!(validate_provider(ProviderType::AzureFoundry, &c, false).is_err());
        // Model not in list.
        c.model = "dep3".to_string();
        assert!(validate_provider(ProviderType::AzureFoundry, &c, false).is_err());
        // Model in list.
        c.model = "dep2".to_string();
        assert!(validate_provider(ProviderType::AzureFoundry, &c, false).is_ok());
    }

    #[test]
    fn azure_validation_uses_structured_mappings() {
        let mut c = ProviderConfig::default();
        c.endpoint = "https://a".to_string();
        c.api_key = "k".to_string();
        c.azure_api_version = "2024-02-01".to_string();
        c.azure_deployments = vec![
            AzureDeploymentMapping {
                model: "gpt-4o".to_string(),
                deployment: "dep-4o".to_string(),
            },
            AzureDeploymentMapping {
                model: "gpt-4o-mini".to_string(),
                deployment: "dep-mini".to_string(),
            },
        ];
        // Missing api version fails.
        c.model = "gpt-4o".to_string();
        let mut no_ver = c.clone();
        no_ver.azure_api_version = String::new();
        assert!(validate_provider(ProviderType::AzureFoundry, &no_ver, false).is_err());
        // Selected model not in mappings.
        let mut bad_model = c.clone();
        bad_model.model = "nope".to_string();
        assert!(validate_provider(ProviderType::AzureFoundry, &bad_model, false).is_err());
        // Valid.
        assert!(validate_provider(ProviderType::AzureFoundry, &c, false).is_ok());
        // Structured mappings win over legacy manual_models.
        let mut with_legacy = c.clone();
        with_legacy.manual_models = "legacy-only".to_string();
        assert!(validate_provider(ProviderType::AzureFoundry, &with_legacy, false).is_ok());
    }

    #[test]
    fn azure_validation_accepts_stored_credential_without_plaintext() {
        let mut c = ProviderConfig::default();
        c.endpoint = "https://a".to_string();
        c.api_key = String::new();
        c.api_key_stored = true; // credential lives in the store
        c.azure_api_version = "2024-02-01".to_string();
        c.azure_deployments = vec![AzureDeploymentMapping {
            model: "m".to_string(),
            deployment: "d".to_string(),
        }];
        c.model = "m".to_string();
        assert!(validate_provider(ProviderType::AzureFoundry, &c, false).is_ok());
        // Neither plaintext nor stored -> invalid.
        let mut missing = c.clone();
        missing.api_key_stored = false;
        assert!(validate_provider(ProviderType::AzureFoundry, &missing, false).is_err());
    }

    #[test]
    fn effective_azure_deployments_migrates_manual_models() {
        let mut c = ProviderConfig::default();
        c.manual_models = "a, b, a".to_string();
        let m = c.effective_azure_deployments();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].model, "a");
        assert_eq!(m[0].deployment, "a");
        // Structured field takes precedence when present.
        c.azure_deployments = vec![AzureDeploymentMapping {
            model: "x".to_string(),
            deployment: "y".to_string(),
        }];
        let m2 = c.effective_azure_deployments();
        assert_eq!(m2.len(), 1);
        assert_eq!(m2[0].deployment, "y");
    }

    // --- Manual model normalization ----------------------------------------

    #[test]
    fn azure_mapping_contract_accepts_unique_nonempty() {
        let mappings = vec![
            AzureDeploymentMapping {
                model: "gpt-4o".to_string(),
                deployment: "dep-4o".to_string(),
            },
            AzureDeploymentMapping {
                model: "gpt-4o-mini".to_string(),
                deployment: "dep-mini".to_string(),
            },
        ];
        let c = validate_azure_mappings(&mappings, "2024-02-01", "gpt-4o").unwrap();
        assert_eq!(c.selected_model, "gpt-4o");
        assert_eq!(c.api_version, "2024-02-01");
        assert_eq!(c.mappings.len(), 2);
    }

    #[test]
    fn azure_mapping_contract_rejects_empty_and_dupes() {
        // Empty list.
        assert!(validate_azure_mappings(&[], "v", "m").is_err());
        // Empty model.
        let m = vec![AzureDeploymentMapping {
            model: "".to_string(),
            deployment: "d".to_string(),
        }];
        assert!(validate_azure_mappings(&m, "v", "m").is_err());
        // Duplicate model.
        let dup_model = vec![
            AzureDeploymentMapping {
                model: "a".to_string(),
                deployment: "d1".to_string(),
            },
            AzureDeploymentMapping {
                model: "a".to_string(),
                deployment: "d2".to_string(),
            },
        ];
        assert!(validate_azure_mappings(&dup_model, "v", "a").is_err());
        // Duplicate deployment.
        let dup_dep = vec![
            AzureDeploymentMapping {
                model: "a".to_string(),
                deployment: "d".to_string(),
            },
            AzureDeploymentMapping {
                model: "b".to_string(),
                deployment: "d".to_string(),
            },
        ];
        assert!(validate_azure_mappings(&dup_dep, "v", "a").is_err());
    }

    #[test]
    fn azure_mapping_contract_requires_api_version_and_member_selected() {
        let mappings = vec![AzureDeploymentMapping {
            model: "a".to_string(),
            deployment: "d".to_string(),
        }];
        // Blank api version.
        assert!(validate_azure_mappings(&mappings, "  ", "a").is_err());
        // Selected model not in mappings.
        assert!(validate_azure_mappings(&mappings, "v", "zzz").is_err());
        // Valid.
        assert!(validate_azure_mappings(&mappings, "v", "a").is_ok());
    }

    #[test]
    fn azure_deployment_mapping_roundtrips() {
        let m = AzureDeploymentMapping {
            model: "gpt-4o".to_string(),
            deployment: "dep".to_string(),
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: AzureDeploymentMapping = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }
    #[test]
    fn parse_manual_models_trims_dedups_first_seen() {
        let raw = "a, b\n c , a\r\nb,, d ";
        assert_eq!(parse_manual_models(raw), vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn parse_manual_models_empty_is_empty() {
        assert!(parse_manual_models("  , \n\r ").is_empty());
    }

    // --- Atomic persistence -------------------------------------------------

    #[test]
    fn save_settings_persists_and_validates() {
        let dir = tmp_dir();
        let path = dir.join("settings.json");
        let mut settings = AppSettings::default();
        settings.active_provider = ProviderType::CustomProvider;
        {
            let c = settings
                .provider_configs
                .as_mut()
                .unwrap()
                .get_mut(ProviderType::CustomProvider);
            c.endpoint = "https://e".to_string();
            c.api_key = "k".to_string();
            c.model = "m".to_string();
        }
        let saved = save_settings(&path, settings, false).unwrap();
        // Compatibility fields projected.
        assert_eq!(saved.ai_base_url, "https://e");
        assert_eq!(saved.ai_model, "m");
        // Round-trips from disk.
        let loaded = load_settings(&path, &dir.join("none.json"));
        assert_eq!(
            loaded
                .provider_configs
                .unwrap()
                .get(ProviderType::CustomProvider)
                .unwrap()
                .endpoint,
            "https://e"
        );
    }

    #[test]
    fn save_settings_invalid_does_not_overwrite_existing_file() {
        let dir = tmp_dir();
        let path = dir.join("settings.json");
        // Seed a valid file.
        let mut good = AppSettings::default();
        good.active_provider = ProviderType::CustomProvider;
        {
            let c = good
                .provider_configs
                .as_mut()
                .unwrap()
                .get_mut(ProviderType::CustomProvider);
            c.endpoint = "https://good".to_string();
            c.api_key = "k".to_string();
            c.model = "m".to_string();
        }
        save_settings(&path, good, false).unwrap();
        let before = fs::read_to_string(&path).unwrap();

        // Attempt an invalid save (missing custom fields).
        let bad = AppSettings::default();
        let result = save_settings(&path, bad, false);
        assert!(result.is_err());
        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(before, after, "invalid save must preserve old file");
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let dir = tmp_dir();
        let path = dir.join("f.json");
        atomic_write(&path, "one").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "one");
        atomic_write(&path, "two").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        // No leftover temp files.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files should be cleaned up");
    }
}
