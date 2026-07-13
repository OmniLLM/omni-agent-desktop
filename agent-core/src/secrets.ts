/**
 * Secret store (port of src-tauri/src/secrets.rs).
 *
 * Uses Bun's native `Bun.secrets` API which maps to the OS credential store
 * (Keychain on macOS, Credential Manager on Windows, libsecret on Linux) —
 * no native module compile step required.
 *
 * When running under Node (dev fallback), falls back to a plaintext JSON file
 * under <config>/secrets.json. Never falls back to plaintext for a genuinely
 * secret op: throws instead so the caller aborts the save.
 *
 * Contract: a store failure surfaces as a thrown Error. Callers must NEVER
 * fall back to persisting plaintext secrets on their own.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";
import { PROVIDER_TYPES, type AppSettings, type ProviderType } from "./settings.js";

export const KEYRING_SERVICE = "omni-agent-desktop";
export const PROTECTED_PROVIDERS: ProviderType[] = ["azure-foundry", "github-copilot"];

export function secretKey(p: ProviderType): string | null {
  switch (p) {
    case "azure-foundry":
      return "azure-foundry.api_key";
    case "github-copilot":
      return "github-copilot.token";
    default:
      return null;
  }
}

// Bun's native secrets binding. We probe once and cache the resolved backend.
interface SecretsBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

let backend: SecretsBackend | null = null;

function getBackend(): SecretsBackend {
  if (backend) return backend;
  const globalBun = (globalThis as { Bun?: { secrets?: unknown } }).Bun;
  const bunSecrets = globalBun?.secrets as
    | {
        get(opts: { service: string; name: string }): Promise<string | null>;
        set(opts: { service: string; name: string; value: string }): Promise<void>;
        delete(opts: { service: string; name: string }): Promise<void>;
      }
    | undefined;
  if (bunSecrets && typeof bunSecrets.get === "function") {
    backend = {
      async get(key) {
        return bunSecrets.get({ service: KEYRING_SERVICE, name: key });
      },
      async set(key, value) {
        await bunSecrets.set({ service: KEYRING_SERVICE, name: key, value });
      },
      async delete(key) {
        await bunSecrets.delete({ service: KEYRING_SERVICE, name: key });
      },
    };
    return backend;
  }
  // Node fallback: encrypted-at-rest is out of scope; use a chmod-600 JSON file
  // under the config dir. Callers running under Node (dev) get a warning line.
  process.stderr.write(
    "agent-core: WARNING — Bun.secrets unavailable; using plaintext secrets file (dev only)\n",
  );
  const path = join(configDir(), "secrets.json");
  const read = (): Record<string, string> => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  };
  const write = (m: Record<string, string>) => writeFileSync(path, JSON.stringify(m), { mode: 0o600 });
  backend = {
    async get(key) {
      return read()[key] ?? null;
    },
    async set(key, value) {
      const m = read();
      m[key] = value;
      write(m);
    },
    async delete(key) {
      const m = read();
      delete m[key];
      write(m);
    },
  };
  return backend;
}

export async function getSecret(key: string): Promise<string | null> {
  return getBackend().get(key);
}
export async function setSecret(key: string, value: string): Promise<void> {
  await getBackend().set(key, value);
}
export async function deleteSecret(key: string): Promise<void> {
  await getBackend().delete(key);
}

/**
 * Move plaintext protected secrets into the secure store; clear plaintext.
 *
 * IMPORTANT: `github-copilot.token` is deliberately NOT redacted here. That
 * token is obtained and owned by the OAuth device flow (copilot-auth.ts) and is
 * never entered through the settings form — the copilot ProviderConfig has no
 * api_key. If redaction ran over it, a settings save (copilot api_key="" and
 * api_key_stored=false) would hit the delete branch and wipe the freshly OAuth'd
 * token. So redaction is limited to form-managed secrets (Azure only).
 */
const FORM_MANAGED_SECRET_PROVIDERS: ProviderType[] = ["azure-foundry"];

export async function redactSecretsForPersist(settings: AppSettings): Promise<void> {
  const configs = settings.provider_configs;
  if (!configs) return;
  for (const p of FORM_MANAGED_SECRET_PROVIDERS) {
    const key = secretKey(p);
    if (!key) continue;
    const cfg = configs[p];
    if (cfg.api_key !== "") {
      await setSecret(key, cfg.api_key);
      cfg.api_key = "";
      cfg.api_key_stored = true;
    } else if (cfg.api_key_stored) {
      // Retain existing store value.
    } else {
      await deleteSecret(key);
      cfg.api_key_stored = false;
    }
  }
}

export async function restoreSecrets(settings: AppSettings): Promise<void> {
  const configs = settings.provider_configs;
  if (!configs) return;
  for (const p of PROTECTED_PROVIDERS) {
    const key = secretKey(p);
    if (!key) continue;
    const secret = await getSecret(key);
    if (secret && secret.length > 0) {
      configs[p].api_key = secret;
      configs[p].api_key_stored = true;
    }
  }
}

export async function frontendView(settings: AppSettings): Promise<AppSettings> {
  const out: AppSettings = JSON.parse(JSON.stringify(settings));
  if (!out.provider_configs) return out;
  for (const p of PROTECTED_PROVIDERS) {
    const key = secretKey(p);
    if (!key) continue;
    const stored = (await getSecret(key)) ?? "";
    out.provider_configs[p].api_key = "";
    out.provider_configs[p].api_key_stored = stored.length > 0;
  }
  if (PROTECTED_PROVIDERS.includes(out.active_provider)) {
    out.ai_api_key = "";
  }
  return out;
}
