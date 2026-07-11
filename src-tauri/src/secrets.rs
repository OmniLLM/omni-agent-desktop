//! Secret storage abstraction and OS keyring backend.
//!
//! Sensitive credentials (the GitHub Copilot token and Azure Foundry API keys)
//! must never be written into the plaintext settings file. This module defines
//! a [`SecretStore`] trait so persistence code can write/read secrets through an
//! injectable backend. Production uses [`KeyringSecretStore`], which stores
//! secrets in the OS credential manager under the service
//! `omni-agent-desktop`. Tests use [`InMemorySecretStore`] (optionally
//! configured to surface failures) so credential-store failures are exercised
//! without touching the real keyring.
//!
//! Contract: a credential-store failure must be surfaced as an `Err` to the
//! caller. Callers must never fall back to persisting the plaintext secret.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::settings::{AppSettings, ProviderType};

/// The OS keyring service name under which all desktop secrets are stored.
pub const KEYRING_SERVICE: &str = "omni-agent-desktop";

/// Error returned by a [`SecretStore`] operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretError(pub String);

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for SecretError {}

/// An injectable secret store. Implementations must be thread-safe.
pub trait SecretStore: Send + Sync {
    /// Return the secret for `key`, or `None` if it is not present.
    fn get(&self, key: &str) -> Result<Option<String>, SecretError>;
    /// Store `value` under `key`, replacing any existing value.
    fn set(&self, key: &str, value: &str) -> Result<(), SecretError>;
    /// Delete the secret for `key`. Deleting a missing key is not an error.
    fn delete(&self, key: &str) -> Result<(), SecretError>;
}

// ---------------------------------------------------------------------------
// Secret keys
// ---------------------------------------------------------------------------

/// The keyring account/key for a provider's secret credential (Azure API key
/// or GitHub Copilot token). Custom-provider keys are not treated as protected
/// secrets and are not routed through this scheme.
pub fn secret_key(provider: ProviderType) -> Option<&'static str> {
    match provider {
        ProviderType::AzureFoundry => Some("azure-foundry.api_key"),
        ProviderType::GithubCopilot => Some("github-copilot.token"),
        ProviderType::CustomProvider => None,
    }
}

/// Providers whose credentials are protected secrets, in a stable order.
pub const PROTECTED_PROVIDERS: [ProviderType; 2] =
    [ProviderType::AzureFoundry, ProviderType::GithubCopilot];

// ---------------------------------------------------------------------------
// In-memory store (tests / fallback)
// ---------------------------------------------------------------------------

/// An in-memory [`SecretStore`] used by tests. It can be configured to fail all
/// mutating operations to exercise the "credential store failure" path.
#[derive(Default)]
pub struct InMemorySecretStore {
    map: Mutex<HashMap<String, String>>,
    fail: bool,
}

impl InMemorySecretStore {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            fail: false,
        }
    }

    /// A store whose `set`/`get`/`delete` always fail, to test surfaced
    /// failures.
    pub fn failing() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            fail: true,
        }
    }

    /// Direct read for assertions in tests.
    pub fn peek(&self, key: &str) -> Option<String> {
        self.map.lock().unwrap().get(key).cloned()
    }
}

impl SecretStore for InMemorySecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        if self.fail {
            return Err(SecretError("secret store unavailable".to_string()));
        }
        Ok(self.map.lock().unwrap().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        if self.fail {
            return Err(SecretError("secret store write failed".to_string()));
        }
        self.map
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        if self.fail {
            return Err(SecretError("secret store delete failed".to_string()));
        }
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Keyring backend
// ---------------------------------------------------------------------------

/// OS keyring-backed [`SecretStore`] using the `omni-agent-desktop` service.
pub struct KeyringSecretStore {
    service: String,
}

impl KeyringSecretStore {
    pub fn new() -> Self {
        Self {
            service: KEYRING_SERVICE.to_string(),
        }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(&self.service, key).map_err(|e| SecretError(e.to_string()))
    }
}

impl Default for KeyringSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeyringSecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, SecretError> {
        match self.entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError(e.to_string())),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretError> {
        self.entry(key)?
            .set_password(value)
            .map_err(|e| SecretError(e.to_string()))
    }

    fn delete(&self, key: &str) -> Result<(), SecretError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError(e.to_string())),
        }
    }
}

// ---------------------------------------------------------------------------
// Secret migration / redaction
// ---------------------------------------------------------------------------

/// Move protected plaintext secrets (Azure API key, Copilot token) from
/// `settings` into `store`, then clear them from the in-memory struct so they
/// are never serialized to disk.
///
/// Per protected provider, based on the incoming (frontend-supplied) profile:
/// - `api_key` non-empty  → write the new secret, clear plaintext, mark stored.
/// - `api_key` empty + `api_key_stored == true`  → RETAIN the existing stored
///   secret (the frontend never received it and just echoed the presence flag).
/// - `api_key` empty + `api_key_stored == false` → DELETE any existing keyring
///   entry, so a cleared credential does not silently reappear later.
///
/// Writes/deletes are surfaced: on any store failure the error is returned and
/// the caller must abort the save rather than persist plaintext or leave a
/// stale secret. A new secret's plaintext is cleared only after its write
/// succeeds.
pub fn redact_secrets_for_persist(
    settings: &mut AppSettings,
    store: &dyn SecretStore,
) -> Result<(), SecretError> {
    let mut configs = settings.effective_provider_configs();
    for provider in PROTECTED_PROVIDERS {
        let Some(key) = secret_key(provider) else {
            continue;
        };
        let cfg = configs.get_mut(provider);
        if !cfg.api_key.is_empty() {
            // New/updated secret: write first, then clear plaintext.
            let value = cfg.api_key.clone();
            store.set(key, &value)?;
            cfg.api_key = String::new();
            cfg.api_key_stored = true;
        } else if cfg.api_key_stored {
            // Empty secret but presence flag set: keep the existing stored
            // credential untouched (frontend echoed the flag without the value).
        } else {
            // Empty secret and not stored: user cleared the credential. Remove
            // any existing entry so a stale secret cannot reappear.
            store.delete(key)?;
            cfg.api_key_stored = false;
        }
    }
    settings.provider_configs = Some(configs);
    Ok(())
}

/// Build a frontend-safe view of `settings`: protected provider secrets are
/// stripped and replaced with a non-secret `api_key_stored` presence flag
/// sourced from the credential store. This is what `get_settings` returns to
/// React. A store read failure is surfaced (the UI must not silently claim a
/// credential is absent/present).
pub fn frontend_view(
    settings: &AppSettings,
    store: &dyn SecretStore,
) -> Result<AppSettings, SecretError> {
    let mut out = settings.clone();
    let mut configs = out.effective_provider_configs();
    for provider in PROTECTED_PROVIDERS {
        let Some(key) = secret_key(provider) else {
            continue;
        };
        let stored = store.get(key)?.map(|v| !v.is_empty()).unwrap_or(false);
        let cfg = configs.get_mut(provider);
        // Never expose the protected secret to the frontend.
        cfg.api_key = String::new();
        cfg.api_key_stored = stored;
    }
    out.provider_configs = Some(configs);
    // The flat compatibility mirror must never carry a protected secret either.
    if PROTECTED_PROVIDERS.contains(&out.active_provider) {
        out.ai_api_key = String::new();
    }
    Ok(out)
}

/// NATIVE-ONLY: populate the in-memory `settings` with protected secrets read
/// back from `store`. Used by native runtime/request paths (agent execution,
/// model discovery) so live credentials are available in-process. This result
/// must NEVER be returned to the frontend — use [`frontend_view`] for that. A
/// read failure is surfaced.
pub fn restore_secrets(
    settings: &mut AppSettings,
    store: &dyn SecretStore,
) -> Result<(), SecretError> {
    let mut configs = settings.effective_provider_configs();
    for provider in PROTECTED_PROVIDERS {
        let Some(key) = secret_key(provider) else {
            continue;
        };
        if let Some(secret) = store.get(key)? {
            if !secret.is_empty() {
                let cfg = configs.get_mut(provider);
                cfg.api_key = secret;
                cfg.api_key_stored = true;
            }
        }
    }
    settings.provider_configs = Some(configs);
    Ok(())
}

/// Validate, redact protected secrets into `store`, project compatibility
/// fields, and atomically persist `settings` to `path` with no plaintext
/// secrets on disk.
///
/// Ordering is critical: secrets are redacted into the store BEFORE the
/// compatibility projection runs, so the flat `ai_api_key` mirror of an active
/// protected provider is also cleared and never persisted. A credential-store
/// failure surfaces as `Err` and aborts the save (the previous file is left
/// untouched); the code never falls back to writing plaintext.
pub fn save_settings_secure(
    path: &std::path::Path,
    mut settings: AppSettings,
    store: &dyn SecretStore,
    copilot_connected: bool,
) -> Result<AppSettings, String> {
    // Validate the active provider first so an invalid config never touches the
    // credential store.
    settings.provider_configs = Some(settings.effective_provider_configs());
    let active_config = settings
        .provider_configs
        .as_ref()
        .and_then(|m| m.get(settings.active_provider))
        .cloned()
        .unwrap_or_default();
    crate::settings::validate_provider(settings.active_provider, &active_config, copilot_connected)
        .map_err(|e| e.0)?;

    // Move protected secrets to the store and clear plaintext. On failure the
    // error is surfaced and nothing is persisted.
    redact_secrets_for_persist(&mut settings, store).map_err(|e| e.0)?;

    // Now project + persist. Because protected api_keys are already cleared, the
    // flat compatibility fields cannot carry a protected secret to disk.
    crate::settings::project_compatibility_fields(&mut settings);
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    crate::settings::atomic_write(path, &json)?;
    Ok(settings)
}



#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;

    fn settings_with_secrets() -> AppSettings {
        let mut s = AppSettings::default();
        {
            let configs = s.provider_configs.as_mut().unwrap();
            let azure = configs.get_mut(ProviderType::AzureFoundry);
            azure.endpoint = "https://azure".to_string();
            azure.api_key = "azure-secret".to_string();
            let copilot = configs.get_mut(ProviderType::GithubCopilot);
            copilot.api_key = "gh-token".to_string();
        }
        s
    }

    #[test]
    fn in_memory_store_roundtrips() {
        let store = InMemorySecretStore::new();
        assert_eq!(store.get("k").unwrap(), None);
        store.set("k", "v").unwrap();
        assert_eq!(store.get("k").unwrap(), Some("v".to_string()));
        store.delete("k").unwrap();
        assert_eq!(store.get("k").unwrap(), None);
        // Deleting a missing key is not an error.
        store.delete("k").unwrap();
    }

    #[test]
    fn failing_store_surfaces_errors() {
        let store = InMemorySecretStore::failing();
        assert!(store.set("k", "v").is_err());
        assert!(store.get("k").is_err());
        assert!(store.delete("k").is_err());
    }

    #[test]
    fn redact_moves_secrets_and_clears_plaintext() {
        let store = InMemorySecretStore::new();
        let mut s = settings_with_secrets();
        redact_secrets_for_persist(&mut s, &store).unwrap();

        // Secrets are in the store.
        assert_eq!(
            store.peek("azure-foundry.api_key"),
            Some("azure-secret".to_string())
        );
        assert_eq!(
            store.peek("github-copilot.token"),
            Some("gh-token".to_string())
        );

        // Plaintext cleared from the struct; presence flag set.
        let configs = s.provider_configs.as_ref().unwrap();
        assert_eq!(configs.get(ProviderType::AzureFoundry).unwrap().api_key, "");
        assert_eq!(configs.get(ProviderType::GithubCopilot).unwrap().api_key, "");
        assert!(configs.get(ProviderType::AzureFoundry).unwrap().api_key_stored);
        assert!(configs.get(ProviderType::GithubCopilot).unwrap().api_key_stored);
    }

    #[test]
    fn redacted_settings_never_serialize_secret_values() {
        let store = InMemorySecretStore::new();
        let mut s = settings_with_secrets();
        redact_secrets_for_persist(&mut s, &store).unwrap();
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("azure-secret"), "azure key leaked: {json}");
        assert!(!json.contains("gh-token"), "copilot token leaked: {json}");
    }

    #[test]
    fn redact_failure_is_surfaced_and_leaves_plaintext_untouched() {
        let store = InMemorySecretStore::failing();
        let mut s = settings_with_secrets();
        let err = redact_secrets_for_persist(&mut s, &store);
        assert!(err.is_err(), "store failure must surface, never fall back");
        // The caller aborts the save; the in-memory plaintext remains (it is
        // simply never persisted), so nothing is silently lost.
        let configs = s.provider_configs.as_ref().unwrap();
        assert_eq!(
            configs.get(ProviderType::AzureFoundry).unwrap().api_key,
            "azure-secret"
        );
    }

    #[test]
    fn redact_clears_credential_when_empty_and_not_stored() {
        // Existing secret in store, but the incoming profile has an empty
        // api_key and api_key_stored=false -> user cleared it -> delete entry.
        let store = InMemorySecretStore::new();
        store.set("azure-foundry.api_key", "old-secret").unwrap();

        let mut s = AppSettings::default();
        s.active_provider = ProviderType::AzureFoundry;
        {
            let azure = s
                .provider_configs
                .as_mut()
                .unwrap()
                .get_mut(ProviderType::AzureFoundry);
            azure.api_key = String::new();
            azure.api_key_stored = false;
        }
        redact_secrets_for_persist(&mut s, &store).unwrap();

        // Keyring entry deleted; a subsequent restore finds nothing.
        assert_eq!(store.peek("azure-foundry.api_key"), None);
        let mut restored = AppSettings::default();
        restore_secrets(&mut restored, &store).unwrap();
        let azure = restored
            .provider_configs
            .as_ref()
            .unwrap()
            .get(ProviderType::AzureFoundry)
            .unwrap();
        assert_eq!(azure.api_key, "");
        assert!(!azure.api_key_stored);
    }

    #[test]
    fn redact_retains_credential_when_empty_but_stored_flag_set() {
        // Frontend echoes empty api_key with api_key_stored=true: the value was
        // never sent to the UI, so the existing secret must be RETAINED.
        let store = InMemorySecretStore::new();
        store.set("azure-foundry.api_key", "keep-me").unwrap();

        let mut s = AppSettings::default();
        {
            let azure = s
                .provider_configs
                .as_mut()
                .unwrap()
                .get_mut(ProviderType::AzureFoundry);
            azure.api_key = String::new();
            azure.api_key_stored = true;
        }
        redact_secrets_for_persist(&mut s, &store).unwrap();

        assert_eq!(
            store.peek("azure-foundry.api_key"),
            Some("keep-me".to_string()),
            "existing secret must be retained, not deleted"
        );
    }

    #[test]
    fn redact_delete_failure_is_surfaced() {
        // A store that fails delete must surface the error, never silently
        // succeed and leave a stale secret.
        let store = InMemorySecretStore::failing();
        let mut s = AppSettings::default();
        {
            let azure = s
                .provider_configs
                .as_mut()
                .unwrap()
                .get_mut(ProviderType::AzureFoundry);
            azure.api_key = String::new();
            azure.api_key_stored = false;
        }
        assert!(redact_secrets_for_persist(&mut s, &store).is_err());
    }

    #[test]
    fn clear_credential_full_roundtrip_via_secure_save() {
        // 1) Save a settings with an Azure secret -> stored in keyring.
        let path = tmp_path();
        let store = InMemorySecretStore::new();
        save_settings_secure(&path, azure_active_settings(), &store, false).unwrap();
        assert_eq!(
            store.peek("azure-foundry.api_key"),
            Some("azure-secret".to_string())
        );

        // 2) User later clears the Azure credential (empty key, flag false) but
        //    keeps a valid provider config; switch active away from Azure so the
        //    save still validates.
        let mut cleared = azure_active_settings();
        cleared.active_provider = ProviderType::CustomProvider;
        {
            let configs = cleared.provider_configs.as_mut().unwrap();
            let custom = configs.get_mut(ProviderType::CustomProvider);
            custom.endpoint = "https://c".to_string();
            custom.api_key = "ck".to_string();
            custom.model = "cm".to_string();
            let azure = configs.get_mut(ProviderType::AzureFoundry);
            azure.api_key = String::new();
            azure.api_key_stored = false;
        }
        save_settings_secure(&path, cleared, &store, false).unwrap();

        // 3) The stale Azure secret is gone from the keyring.
        assert_eq!(store.peek("azure-foundry.api_key"), None);
    }

    #[test]
    fn custom_provider_key_is_not_protected() {
        assert_eq!(secret_key(ProviderType::CustomProvider), None);
        let store = InMemorySecretStore::new();
        let mut s = AppSettings::default();
        s.provider_configs
            .as_mut()
            .unwrap()
            .get_mut(ProviderType::CustomProvider)
            .api_key = "custom-key".to_string();
        redact_secrets_for_persist(&mut s, &store).unwrap();
        // Custom provider key is retained (not a protected secret).
        assert_eq!(
            s.provider_configs
                .as_ref()
                .unwrap()
                .get(ProviderType::CustomProvider)
                .unwrap()
                .api_key,
            "custom-key"
        );
    }

    #[test]
    fn restore_repopulates_in_memory_secrets() {
        let store = InMemorySecretStore::new();
        store.set("azure-foundry.api_key", "azure-secret").unwrap();
        store.set("github-copilot.token", "gh-token").unwrap();

        let mut s = AppSettings::default();
        restore_secrets(&mut s, &store).unwrap();
        let configs = s.provider_configs.as_ref().unwrap();
        assert_eq!(
            configs.get(ProviderType::AzureFoundry).unwrap().api_key,
            "azure-secret"
        );
        assert_eq!(
            configs.get(ProviderType::GithubCopilot).unwrap().api_key,
            "gh-token"
        );
    }

    #[test]
    fn restore_failure_is_surfaced() {
        let store = InMemorySecretStore::failing();
        let mut s = AppSettings::default();
        assert!(restore_secrets(&mut s, &store).is_err());
    }

    #[test]
    fn restore_sets_stored_flag_for_native_runtime() {
        let store = InMemorySecretStore::new();
        store.set("azure-foundry.api_key", "azure-secret").unwrap();
        let mut s = AppSettings::default();
        restore_secrets(&mut s, &store).unwrap();
        let azure = s
            .provider_configs
            .as_ref()
            .unwrap()
            .get(ProviderType::AzureFoundry)
            .unwrap();
        assert_eq!(azure.api_key, "azure-secret");
        assert!(azure.api_key_stored);
    }

    #[test]
    fn frontend_view_strips_secrets_and_sets_presence_flag() {
        // Secrets already live in the store; settings on disk have no plaintext.
        let store = InMemorySecretStore::new();
        store.set("azure-foundry.api_key", "azure-secret").unwrap();
        store.set("github-copilot.token", "gh-token").unwrap();

        let mut s = AppSettings::default();
        s.active_provider = ProviderType::AzureFoundry;
        let view = frontend_view(&s, &store).unwrap();

        let configs = view.provider_configs.as_ref().unwrap();
        let azure = configs.get(ProviderType::AzureFoundry).unwrap();
        let copilot = configs.get(ProviderType::GithubCopilot).unwrap();
        // No secret values.
        assert_eq!(azure.api_key, "");
        assert_eq!(copilot.api_key, "");
        // Presence flags reflect the store.
        assert!(azure.api_key_stored);
        assert!(copilot.api_key_stored);
        // Flat compat mirror cleared for a protected active provider.
        assert_eq!(view.ai_api_key, "");
    }

    #[test]
    fn frontend_view_serialization_has_no_protected_secrets() {
        let store = InMemorySecretStore::new();
        store.set("azure-foundry.api_key", "azure-secret").unwrap();
        store.set("github-copilot.token", "gh-token").unwrap();

        // Even if the in-memory settings somehow still carried plaintext (e.g.
        // freshly typed by the user before save), the frontend view must scrub.
        let mut s = AppSettings::default();
        {
            let configs = s.provider_configs.as_mut().unwrap();
            configs.get_mut(ProviderType::AzureFoundry).api_key = "azure-secret".to_string();
            configs.get_mut(ProviderType::GithubCopilot).api_key = "gh-token".to_string();
        }
        let view = frontend_view(&s, &store).unwrap();
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("azure-secret"), "azure key leaked: {json}");
        assert!(!json.contains("gh-token"), "copilot token leaked: {json}");
    }

    #[test]
    fn frontend_view_absent_credential_reports_not_stored() {
        let store = InMemorySecretStore::new(); // empty
        let s = AppSettings::default();
        let view = frontend_view(&s, &store).unwrap();
        let azure = view
            .provider_configs
            .as_ref()
            .unwrap()
            .get(ProviderType::AzureFoundry)
            .unwrap();
        assert!(!azure.api_key_stored);
        assert_eq!(azure.api_key, "");
    }

    #[test]
    fn frontend_view_surfaces_keyring_failure() {
        let store = InMemorySecretStore::failing();
        let s = AppSettings::default();
        assert!(frontend_view(&s, &store).is_err());
    }

    #[test]
    fn native_hydration_after_secure_save_roundtrip() {
        // Save (redacts to store), then a native runtime load must recover the
        // live secret so agent execution can authenticate.
        let path = tmp_path();
        let store = InMemorySecretStore::new();
        save_settings_secure(&path, azure_active_settings(), &store, false).unwrap();

        // Simulate native load: read redacted file + restore secrets.
        let disk: AppSettings =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let mut runtime = disk.migrated();
        restore_secrets(&mut runtime, &store).unwrap();
        let azure = runtime
            .provider_configs
            .as_ref()
            .unwrap()
            .get(ProviderType::AzureFoundry)
            .unwrap();
        assert_eq!(azure.api_key, "azure-secret");
    }

    fn tmp_path() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omni-secrets-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    fn azure_active_settings() -> AppSettings {
        let mut s = AppSettings::default();
        s.active_provider = ProviderType::AzureFoundry;
        let configs = s.provider_configs.as_mut().unwrap();
        let azure = configs.get_mut(ProviderType::AzureFoundry);
        azure.endpoint = "https://azure".to_string();
        azure.api_key = "azure-secret".to_string();
        azure.azure_api_version = "2024-02-01".to_string();
        azure.azure_deployments = vec![
            crate::settings::AzureDeploymentMapping {
                model: "dep1".to_string(),
                deployment: "dep1-x".to_string(),
            },
            crate::settings::AzureDeploymentMapping {
                model: "dep2".to_string(),
                deployment: "dep2-x".to_string(),
            },
        ];
        azure.model = "dep1".to_string();
        s
    }

    #[test]
    fn save_secure_writes_no_plaintext_secret_to_disk() {
        let path = tmp_path();
        let store = InMemorySecretStore::new();
        let s = azure_active_settings();
        let saved = save_settings_secure(&path, s, &store, false).unwrap();

        // Secret is in the store.
        assert_eq!(
            store.peek("azure-foundry.api_key"),
            Some("azure-secret".to_string())
        );
        // Returned struct has the flat compat api key cleared for a protected
        // active provider.
        assert_eq!(saved.ai_api_key, "");

        // Nothing on disk contains the secret.
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("azure-secret"), "secret leaked: {disk}");
    }

    #[test]
    fn save_secure_aborts_and_preserves_file_on_store_failure() {
        let path = tmp_path();
        // Seed a valid prior file via a working store.
        let good_store = InMemorySecretStore::new();
        save_settings_secure(&path, azure_active_settings(), &good_store, false).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();

        // Now a failing store must abort without overwriting.
        let failing = InMemorySecretStore::failing();
        let res = save_settings_secure(&path, azure_active_settings(), &failing, false);
        assert!(res.is_err(), "store failure must surface");
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(before, after, "failed save must not overwrite file");
    }

    #[test]
    fn save_secure_rejects_invalid_before_touching_store() {
        let path = tmp_path();
        let store = InMemorySecretStore::new();
        // Azure active but no models/model -> invalid.
        let mut s = AppSettings::default();
        s.active_provider = ProviderType::AzureFoundry;
        s.provider_configs
            .as_mut()
            .unwrap()
            .get_mut(ProviderType::AzureFoundry)
            .api_key = "azure-secret".to_string();
        let res = save_settings_secure(&path, s, &store, false);
        assert!(res.is_err());
        // Store was never written because validation failed first.
        assert_eq!(store.peek("azure-foundry.api_key"), None);
    }
}
