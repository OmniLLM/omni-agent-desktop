import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, emit } from "../lib/runtime";
import type {
  AppSettings,
  A2aConnection,
  ProviderConfig,
  ProviderType,
  WindowSizePreset,
} from "../types/app";
import CustomProviderFields from "./settings/CustomProviderFields";
import CopilotProviderFields from "./settings/CopilotProviderFields";
import AzureProviderFields from "./settings/AzureProviderFields";
import { validateProviderDraft } from "../lib/providerValidation";
import {
  applyWindowSize,
  normalizeWindowSize,
  normalizeCustomDimension,
  WINDOW_SIZE_OPTIONS,
  CUSTOM_WINDOW_MIN_WIDTH,
  CUSTOM_WINDOW_MIN_HEIGHT,
  CUSTOM_WINDOW_MAX_WIDTH,
  CUSTOM_WINDOW_MAX_HEIGHT,
  DEFAULT_CUSTOM_WINDOW_WIDTH,
  DEFAULT_CUSTOM_WINDOW_HEIGHT,
} from "../lib/windowSize";
import {
  isSafeBackgroundUrl,
  validateBackgroundUrl,
  type BackgroundValidation,
} from "../lib/background";

const BG_PRESETS = [
  { label: "None (solid color)", value: "" },
  {
    label: "Overwatch — White Rabbit",
    value:
      "https://blz-contentstack-images.akamaized.net/v3/assets/bltf408a0557f4e4998/blt27903959c912debc/69fba009d002ee6d7deb5875/shop_carousel_ow_26_s2_mythicskin_desktop.webp?imwidth=1568&imdensity=1",
  },
  {
    label: "World of Warcraft",
    value:
      "https://blz-contentstack-images.akamaized.net/v3/assets/bltf408a0557f4e4998/bltf37ef22c44e74da0/69839a28b521c44554739254/WoW_Shop_HearthsteelHousingVCSKUs_BnetShop_ProductAssetGallery_1920x1080.png?imwidth=1088&imdensity=1",
  },
  {
    label: "Diablo IV",
    value:
      "https://blz-contentstack-images.akamaized.net/v3/assets/bltf408a0557f4e4998/blt524d75eb1bde1557/6920dd20a4d899a8d8ea5985/DIA_DIV_Helix_Bnet_Product_Page_Banners_Bnet_UE_Desktop-1600x500_GG01.png?imwidth=1568&imdensity=1",
  },
  {
    label: "Hearthstone",
    value:
      "https://blz-contentstack-images.akamaized.net/v3/assets/bltf408a0557f4e4998/bltd34bcafef5da9778/69cc0c9401bc870008d78112/HS_35p2_BGPremiumPass_BattleNet_Shop_Browser_DesktopBanner_1600x500_DB02.png?imwidth=1568&imdensity=1",
  },
  { label: "Custom URL…", value: "__custom__" },
];

const TABS = [
  { id: "ai", label: "AI", icon: "🤖" },
  { id: "appearance", label: "Appearance", icon: "🎨" },
  { id: "general", label: "General", icon: "⚙️" },
  { id: "a2a", label: "A2A", icon: "🔗" },
] as const;

const PROVIDERS: { value: ProviderType; label: string }[] = [
  { value: "custom-provider", label: "Custom provider" },
  { value: "github-copilot", label: "GitHub Copilot" },
  { value: "azure-foundry", label: "Azure AI Foundry" },
];

function emptyProviderConfig(): ProviderConfig {
  return {
    endpoint: "",
    api_key: "",
    api_key_stored: false,
    api_shape: "openai-compatible",
    model: "",
    manual_models: "",
  };
}

type TabId = (typeof TABS)[number]["id"];
type SaveStatus = "idle" | "success" | "error";
const SAVE_STATUS_DURATION_MS = 3000;

const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "Control",
  "Meta",
  "Shift",
]);

function formatHotkeyEvent(
  event: Pick<
    KeyboardEvent,
    "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  >,
): string | null {
  if (!event.key || MODIFIER_KEYS.has(event.key)) {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Cmd");

  const key =
    event.key === " "
      ? "Space"
      : event.key.length === 1
        ? event.key.toUpperCase()
        : event.key;
  parts.push(key);
  return parts.join("+");
}

interface Props {
  onClose?: () => void;
  /** Apply a theme change immediately (before Save) so the UI reflects it live. */
  onThemeChange?: (theme: "dark" | "light") => void;
  /** Register the rollback-aware close handler so the host can route Escape/backdrop through it. */
  registerClose?: (close: () => Promise<void>) => void;
  /**
   * Live-preview a background URL before Save. Pass a valid URL to preview it,
   * or an empty string to clear the preview and fall back to the persisted
   * background. The host owns the preview state so it can restore on cancel.
   */
  onBackgroundPreview?: (url: string) => void;
}

export default function SettingsWindow({
  onClose,
  onThemeChange,
  registerClose,
  onBackgroundPreview,
}: Props = {}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [hotkeyStatus, setHotkeyStatus] = useState<SaveStatus>("idle");
  const [hotkeyError, setHotkeyError] = useState("");
  const [capturingHotkey, setCapturingHotkey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("ai");
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Provider selection + independent per-provider drafts. `activeProvider` is
  // the provider currently being edited in the dialog; `providerDrafts` holds a
  // retained draft for every provider so switching never loses unsaved edits.
  const [activeProvider, setActiveProvider] =
    useState<ProviderType>("custom-provider");
  const [providerDrafts, setProviderDrafts] = useState<
    Record<ProviderType, ProviderConfig>
  >({
    "custom-provider": emptyProviderConfig(),
    "github-copilot": emptyProviderConfig(),
    "azure-foundry": emptyProviderConfig(),
  });

  const updateProviderDraft = useCallback(
    (provider: ProviderType, patch: Partial<ProviderConfig>) => {
      setProviderDrafts((prev) => ({
        ...prev,
        [provider]: { ...prev[provider], ...patch },
      }));
      // Editing a provider clears its stale save-time error.
      setProviderError("");
    },
    [],
  );

  /** Save-time validation error for the active provider (field-level). */
  const [providerError, setProviderError] = useState("");
  /** Whether Copilot currently reports a connected credential. Lifted from the
   * Copilot field component so save-time validation can gate activation. */
  const [copilotConnected, setCopilotConnected] = useState(false);

  const currentBgUrl = settings?.background_url ?? "";
  const isCustomBg =
    currentBgUrl !== "" &&
    !BG_PRESETS.some(
      (p) => p.value === currentBgUrl && p.value !== "__custom__",
    );
  // Sticky "custom URL" mode: once the user is editing a custom URL we keep the
  // text field mounted even if the value momentarily becomes empty (clearing
  // it char-by-char would otherwise unmount the input mid-edit).
  const [customBgMode, setCustomBgMode] = useState(false);
  const showCustomBg = isCustomBg || customBgMode;
  const bgSelectValue = showCustomBg ? "__custom__" : currentBgUrl;

  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [a2aDiscovery, setA2aDiscovery] = useState<Record<string, string>>({});
  const [windowSizeError, setWindowSizeError] = useState("");
  const [bgError, setBgError] = useState("");
  // Runtime image-load failure: the URL is well-formed & safe but the browser
  // could not fetch/decode the image. We warn without discarding the draft.
  const [bgLoadError, setBgLoadError] = useState(false);
  const savedWindowSizeRef = useRef<{
    preset: WindowSizePreset;
    customWidth?: number;
    customHeight?: number;
  }>({ preset: "standard" });
  /** The background URL that is currently persisted on disk. Used to restore
   *  the host's live preview when the user cancels or a save fails. */
  const savedBackgroundRef = useRef<string>("");
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  /** Monotonic token for custom model discovery. Incremented on every new
   * discovery AND on provider switch/unmount, so a slow in-flight result that
   * resolves after the user has moved on is dropped instead of landing stale. */
  const discoveryGenRef = useRef(0);

  useEffect(
    () => () => {
      if (saveStatusTimerRef.current !== null) {
        clearTimeout(saveStatusTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setLoading(true);
    setLoadError("");
    setSettings(null);
    invoke<AppSettings>("get_settings")
      .then((s) => {
        const preset = normalizeWindowSize(s.window_size);
        s.window_size = preset;
        savedWindowSizeRef.current = {
          preset,
          customWidth: s.window_size_custom_width,
          customHeight: s.window_size_custom_height,
        };
        savedBackgroundRef.current = s.background_url ?? "";
        // Seed provider selection + per-provider drafts from loaded settings.
        const loadedActive = s.active_provider ?? "custom-provider";
        setActiveProvider(loadedActive);
        setProviderDrafts({
          "custom-provider":
            s.provider_configs?.["custom-provider"] ?? emptyProviderConfig(),
          "github-copilot":
            s.provider_configs?.["github-copilot"] ?? emptyProviderConfig(),
          "azure-foundry":
            s.provider_configs?.["azure-foundry"] ?? emptyProviderConfig(),
        });
        setSettings(s);
        setModelFilter(s.ai_model);
        setLoading(false);
      })
      .catch((err) => {
        // CRITICAL: Do NOT silently substitute hardcoded defaults here.
        //
        // Historically this catch swapped in `AppSettings.default()`-shaped
        // hardcoded values, which had two terrible effects:
        //
        //   1. Cross-machine connections (WSL backend ↔ Windows frontend) where
        //      the auth token is missing/stale → get_settings returns 401 →
        //      user sees factory defaults in Preferences instead of the
        //      backend's real settings, and assumes "settings page is broken".
        //
        //   2. If the user then clicks Save, the frontend POSTs those defaults
        //      back to the backend, which writes them to settings.json —
        //      silently wiping the user's actual saved settings.
        //
        // Surface the failure honestly. Keep `settings` null so the form
        // doesn't render (preventing a destructive save), and show the real
        // error with a retry affordance.
        const message =
          err instanceof Error ? err.message : String(err ?? "Unknown error");
        console.error("Failed to load settings from backend:", err);
        setLoadError(message || "Failed to load settings from backend");
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAttempt]);

  const fetchModels = useCallback(async () => {
    if (!settings) return;
    // Discover using the CURRENT unsaved custom-provider draft — endpoint and
    // key as edited in the dialog — not the persisted flat ai_* fields. The key
    // is only sent to the local native list_models command, never logged.
    const custom = providerDrafts["custom-provider"];
    const baseUrl = custom?.endpoint ?? settings.ai_base_url;
    const apiKey = custom?.api_key ?? settings.ai_api_key;
    if (!baseUrl) return;
    const gen = ++discoveryGenRef.current;
    setModelsLoading(true);
    setModelsError("");
    try {
      const result = await invoke<string[]>("list_models", {
        baseUrl,
        apiKey,
      });
      // Drop a stale result: the user switched provider / re-triggered / left.
      if (gen !== discoveryGenRef.current) return;
      setModels(result.sort());
    } catch (e) {
      if (gen !== discoveryGenRef.current) return;
      setModelsError(String(e));
      setModels([]);
    } finally {
      if (gen === discoveryGenRef.current) setModelsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerDrafts, settings?.ai_base_url, settings?.ai_api_key]);

  // Invalidate any in-flight custom discovery when the active provider changes
  // (so a late result can't land on another provider's view) and on unmount.
  useEffect(() => {
    discoveryGenRef.current += 1;
    setModelsLoading(false);
    return () => {
      discoveryGenRef.current += 1;
    };
  }, [activeProvider]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filteredModels = models.filter((m) =>
    m.toLowerCase().includes(modelFilter.toLowerCase()),
  );

  const handleModelSelect = (model: string) => {
    setModelFilter(model);
    setSettings((s) => s && { ...s, ai_model: model });
    setShowModelDropdown(false);
  };

  const handleSave = async () => {
    if (!settings) return;
    // Don't persist an invalid background — the inline error is already shown.
    const saveCheck = validateBackgroundUrl(settings.background_url ?? "");
    if (!saveCheck.ok) {
      // strictNullChecks is off in tsconfig, which disables boolean-literal
      // discriminant narrowing, so extract the error-branch type explicitly.
      setBgError(
        (saveCheck as Extract<BackgroundValidation, { ok: false }>).error,
      );
      return;
    }
    // Guard: the active provider's draft must be valid before we activate it.
    // This mirrors the native validation and blocks a doomed round-trip; the
    // drafts are retained and the dialog stays open on failure.
    const providerCheck = validateProviderDraft(
      activeProvider,
      providerDrafts[activeProvider],
      { copilotConnected },
    );
    if (providerCheck) {
      setProviderError(providerCheck);
      return;
    }
    setProviderError("");
    if (saveStatusTimerRef.current !== null) {
      clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }
    setSaveStatus("idle");
    // Provider configs are authoritative. Fold the current per-provider drafts
    // and the active-provider selection into the settings payload. Do NOT author
    // the flat ai_* fields here — Rust projects those from the active provider
    // for backend compatibility.
    const settingsToSave: AppSettings = {
      ...settings,
      active_provider: activeProvider,
      provider_configs: {
        "custom-provider": providerDrafts["custom-provider"],
        "github-copilot": providerDrafts["github-copilot"],
        "azure-foundry": providerDrafts["azure-foundry"],
      },
    };
    try {
      await invoke("save_settings_cmd", { settings: settingsToSave });
      savedWindowSizeRef.current = {
        preset: normalizeWindowSize(settings.window_size),
        customWidth: settings.window_size_custom_width,
        customHeight: settings.window_size_custom_height,
      };
      savedBackgroundRef.current = settings.background_url ?? "";
      setSaveStatus("success");
      saveStatusTimerRef.current = setTimeout(() => {
        setSaveStatus("idle");
        saveStatusTimerRef.current = null;
      }, SAVE_STATUS_DURATION_MS);
      emit("omnilauncher://settings-saved", settingsToSave).catch(() => {});
    } catch (e) {
      console.error("Save error:", e);
      setSaveStatus("error");
      // Save failed — the persisted background is unchanged, so restore the
      // host's live preview to the last-saved URL.
      onBackgroundPreview?.(savedBackgroundRef.current);
    }
  };

  const previewWindowSize = async (
    preset: WindowSizePreset,
    overrides?: { customWidth?: number; customHeight?: number },
  ) => {
    setWindowSizeError("");
    try {
      const nextWidth =
        overrides?.customWidth ??
        settings?.window_size_custom_width ??
        DEFAULT_CUSTOM_WINDOW_WIDTH;
      const nextHeight =
        overrides?.customHeight ??
        settings?.window_size_custom_height ??
        DEFAULT_CUSTOM_WINDOW_HEIGHT;
      await applyWindowSize(preset, {
        customWidth: nextWidth,
        customHeight: nextHeight,
      });
      setSettings(
        (current) =>
          current && {
            ...current,
            window_size: preset,
            window_size_custom_width:
              preset === "custom" || current.window_size_custom_width !== undefined
                ? nextWidth
                : current.window_size_custom_width,
            window_size_custom_height:
              preset === "custom" || current.window_size_custom_height !== undefined
                ? nextHeight
                : current.window_size_custom_height,
          },
      );
    } catch (error) {
      setWindowSizeError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  /**
   * Update the draft background URL and drive the host's live preview.
   * A valid (or empty) URL previews immediately and clears any error; an
   * invalid URL surfaces an inline error and does NOT update the preview,
   * so the last good background stays on screen.
   */
  const changeBackground = (url: string) => {
    setSettings((s) => s && { ...s, background_url: url });
    // A new URL invalidates any prior runtime load failure.
    setBgLoadError(false);
    const result = validateBackgroundUrl(url);
    if (result.ok) {
      setBgError("");
      onBackgroundPreview?.(
        (result as Extract<BackgroundValidation, { ok: true }>).value,
      );
    } else {
      setBgError(
        (result as Extract<BackgroundValidation, { ok: false }>).error,
      );
    }
  };

  const closeSettings = async () => {
    const saved = savedWindowSizeRef.current;
    const draftChanged =
      settings &&
      (settings.window_size !== saved.preset ||
        (saved.preset === "custom" &&
          (settings.window_size_custom_width !== saved.customWidth ||
            settings.window_size_custom_height !== saved.customHeight)));
    if (draftChanged) {
      await applyWindowSize(saved.preset, {
        customWidth: saved.customWidth,
        customHeight: saved.customHeight,
      }).catch((error) => {
        console.error("Failed to restore window size:", error);
      });
    }
    // Discard any unsaved background preview: restore the persisted URL.
    onBackgroundPreview?.(savedBackgroundRef.current);
    onClose?.();
  };

  const closeSettingsRef = useRef(closeSettings);
  closeSettingsRef.current = closeSettings;

  useEffect(() => {
    registerClose?.(() => closeSettingsRef.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateA2a = (index: number, patch: Partial<A2aConnection>) => {
    setSettings(
      (s) =>
        s && {
          ...s,
          a2a_connections: (s.a2a_connections ?? []).map((c, i) =>
            i === index ? { ...c, ...patch } : c,
          ),
        },
    );
  };

  const addA2a = () => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `a2a-${Date.now()}`;
    const conn: A2aConnection = {
      id,
      name: "",
      endpoint: "",
      token: "",
      enabled: true,
      disabled_skills: [],
    };
    setSettings(
      (s) =>
        s && { ...s, a2a_connections: [...(s.a2a_connections ?? []), conn] },
    );
  };

  const removeA2a = (index: number) => {
    setSettings(
      (s) =>
        s && {
          ...s,
          a2a_connections: (s.a2a_connections ?? []).filter(
            (_, i) => i !== index,
          ),
        },
    );
  };

  const discoverA2a = async (connection: A2aConnection) => {
    const key = connection.id;
    setA2aDiscovery((prev) => ({ ...prev, [key]: "discovering…" }));
    try {
      // Pass the live draft endpoint/token so discovery does not depend on the
      // connection already being persisted to settings. Fall back to the saved
      // connectionId lookup on the sidecar if endpoint is somehow empty.
      const card = await invoke<{ skills?: unknown[] }>("a2a_discover_card", {
        connectionId: connection.id,
        endpoint: connection.endpoint,
        token: connection.token,
      });
      const count = Array.isArray(card?.skills) ? card.skills.length : 0;
      setA2aDiscovery((prev) => ({
        ...prev,
        [key]: `${count} skill(s)`,
      }));
    } catch (e) {
      setA2aDiscovery((prev) => ({
        ...prev,
        [key]: `error: ${e instanceof Error ? e.message : String(e)}`,
      }));
    }
  };

  const handleHotkeyCapture = async (event: React.KeyboardEvent) => {
    if (!settings || !capturingHotkey) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setCapturingHotkey(false);
      setHotkeyError("");
      setHotkeyStatus("idle");
      return;
    }

    const hotkey = formatHotkeyEvent(event.nativeEvent);
    if (!hotkey) return;

    const previousHotkey = settings.hotkey;
    const nextSettings = { ...settings, hotkey };
    setSettings(nextSettings);
    setCapturingHotkey(false);
    setHotkeyStatus("idle");
    setHotkeyError("");

    try {
      const savedSettings = await invoke<AppSettings>("set_hotkey_cmd", {
        settings: nextSettings,
      });
      setSettings(savedSettings);
      setHotkeyStatus("success");
      emit("omnilauncher://settings-saved", savedSettings).catch(() => {});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("Hotkey save error:", e);
      setSettings((s) => (s ? { ...s, hotkey: previousHotkey } : s));
      setHotkeyError(message || "Failed to register hotkey");
      setHotkeyStatus("error");
    }
  };

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          background: "transparent",
          color: "var(--sub)",
          fontFamily: "inherit",
          fontSize: 13,
        }}
      >
        Loading settings…
      </div>
    );
  }

  if (loadError || !settings) {
    // Show the failure honestly instead of silently rendering hardcoded
    // defaults — see the long-form comment on the get_settings catch above
    // for why this matters (cross-machine deploys, accidental save-of-defaults).
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          background: "transparent",
          color: "var(--text)",
          fontFamily: "inherit",
          overflow: "hidden",
        }}
      >
        <div data-tauri-drag-region className="omni-titlebar">
          <span className="omni-titlebar__title">
            <span aria-hidden="true">⚙</span>
            <span>Preferences</span>
          </span>
          <button
            className="omni-titlebar__close"
            onClick={() => onClose?.()}
            title="Close"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: "32px 28px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 32 }} aria-hidden="true">
            ⚠
          </div>
          <div style={{ fontSize: 15, color: "var(--text)", fontWeight: 600 }}>
            Could not load settings.
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--sub)",
              maxWidth: 480,
              wordBreak: "break-word",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "10px 12px",
            }}
          >
            {loadError || "No settings returned by the backend."}
          </div>
          <div style={{ fontSize: 12, color: "var(--sub)", maxWidth: 480 }}>
            The Save button is disabled until settings load successfully so a
            partial form can't overwrite your saved configuration.
          </div>
          <button
            type="button"
            className="omni-btn omni-btn--primary"
            onClick={() => setLoadAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const rowStyle = (last = false): React.CSSProperties => ({
    display: "grid",
    gridTemplateColumns: "120px 1fr",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    borderBottom: last ? "none" : "1px solid var(--border)",
  });

  const rowLabelStyle: React.CSSProperties = {
    fontSize: 13,
    color: "var(--sub)",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "transparent",
        color: "var(--text)",
        fontFamily: "inherit",
        overflow: "hidden",
      }}
    >
      <div data-tauri-drag-region className="omni-titlebar">
        <span className="omni-titlebar__title">
          <span aria-hidden="true">⚙</span>
          <span>Preferences</span>
        </span>
        <button
          className="omni-titlebar__close"
          onClick={() => {
            void closeSettings();
          }}
          title="Close"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {/* Body: sidebar + content */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left sidebar */}
        <div
          style={{
            width: 140,
            flexShrink: 0,
            background: "var(--bg-elevated)",
            borderRight: "1px solid var(--border)",
            padding: "12px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`settings-tab${isActive ? " settings-tab--active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                aria-pressed={isActive}
              >
                <span aria-hidden="true">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Right content pane */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
            {activeTab === "ai" && (
              <div>
                <div className="settings-section-header">AI Provider</div>
                <div className="settings-card" style={{ marginBottom: 16 }}>
                  <div style={rowStyle(true)}>
                    <label style={rowLabelStyle} htmlFor="ai-provider-select">
                      AI Provider
                    </label>
                    <select
                      id="ai-provider-select"
                      className="omni-select"
                      style={{ cursor: "pointer" }}
                      value={activeProvider}
                      onChange={(e) =>
                        setActiveProvider(e.target.value as ProviderType)
                      }
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {activeProvider === "custom-provider" && (
                  <CustomProviderFields
                    draft={providerDrafts["custom-provider"]}
                    update={(patch) =>
                      updateProviderDraft("custom-provider", patch)
                    }
                    models={models}
                    modelsLoading={modelsLoading}
                    modelsError={modelsError}
                    onDiscoverModels={fetchModels}
                    rowStyle={rowStyle}
                    rowLabelStyle={rowLabelStyle}
                  />
                )}
                {activeProvider === "github-copilot" && (
                  <CopilotProviderFields
                    draft={providerDrafts["github-copilot"]}
                    update={(patch) =>
                      updateProviderDraft("github-copilot", patch)
                    }
                    onConnectionChange={setCopilotConnected}
                    rowStyle={rowStyle}
                    rowLabelStyle={rowLabelStyle}
                  />
                )}
                {activeProvider === "azure-foundry" && (
                  <AzureProviderFields
                    draft={providerDrafts["azure-foundry"]}
                    update={(patch) =>
                      updateProviderDraft("azure-foundry", patch)
                    }
                    rowStyle={rowStyle}
                    rowLabelStyle={rowLabelStyle}
                  />
                )}

                {providerError ? (
                  <div
                    role="alert"
                    className="window-size-error"
                    style={{ display: "block", marginTop: 12 }}
                  >
                    {providerError}
                  </div>
                ) : null}

                <div
                  className="settings-section-header"
                  style={{ marginTop: 20 }}
                >
                  Advanced
                </div>
                <div className="settings-card">
                  <div style={rowStyle()}>
                    <span style={rowLabelStyle}>Timeout</span>
                    <input
                      className="omni-input"
                      type="number"
                      min={1}
                      max={3600}
                      value={settings.ai_timeout_secs}
                      onChange={(e) =>
                        setSettings(
                          (s) =>
                            s && {
                              ...s,
                              ai_timeout_secs: parseInt(e.target.value) || 120,
                            },
                        )
                      }
                      title="AI request timeout in seconds"
                    />
                  </div>
                  <div style={rowStyle()}>
                    <span style={rowLabelStyle}>A2A Task Timeout</span>
                    <input
                      className="omni-input"
                      type="number"
                      min={1}
                      max={3600}
                      value={settings.a2a_timeout_secs}
                      onChange={(e) =>
                        setSettings(
                          (s) =>
                            s && {
                              ...s,
                              a2a_timeout_secs: parseInt(e.target.value) || 120,
                            },
                        )
                      }
                      title="How long to poll a delegated A2A task for a result before giving up, in seconds. Increase for long-running skills that exceed the 120s default."
                    />
                  </div>
                  <div style={rowStyle()}>
                    <span style={rowLabelStyle}>Tool Iterations</span>
                    <input
                      className="omni-input"
                      type="number"
                      min={1}
                      max={100}
                      value={settings.ai_max_tool_iterations}
                      onChange={(e) =>
                        setSettings(
                          (s) =>
                            s && {
                              ...s,
                              ai_max_tool_iterations:
                                parseInt(e.target.value) || 10,
                            },
                        )
                      }
                      title="Maximum AI tool-call iterations before stopping"
                    />
                  </div>
                  <div style={rowStyle()}>
                    <span style={rowLabelStyle}>Retry Attempts</span>
                    <input
                      className="omni-input"
                      type="number"
                      min={1}
                      max={10}
                      value={settings.ai_max_retry_attempts}
                      onChange={(e) =>
                        setSettings(
                          (s) =>
                            s && {
                              ...s,
                              ai_max_retry_attempts:
                                parseInt(e.target.value) || 3,
                            },
                        )
                      }
                      title="How many times the AI client tries a transient-error request before giving up (1 = no retries)"
                    />
                  </div>
                  <div style={rowStyle()}>
                    <span style={rowLabelStyle}>Retry Base Delay (ms)</span>
                    <input
                      className="omni-input"
                      type="number"
                      min={0}
                      max={60000}
                      step={100}
                      value={settings.ai_retry_base_delay_ms}
                      onChange={(e) =>
                        setSettings(
                          (s) =>
                            s && {
                              ...s,
                              ai_retry_base_delay_ms:
                                parseInt(e.target.value) || 2000,
                            },
                        )
                      }
                      title="Base backoff delay before the first retry; doubles on each subsequent retry plus jitter"
                    />
                  </div>
                  <div style={rowStyle(true)}>
                    <span style={rowLabelStyle}>Loop Detector</span>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        cursor: "pointer",
                      }}
                      title="When on (default), the AI tool loop halts after three identical (request, result) iterations in a row. Disable only when debugging long multi-step skills — Tool Iterations is still the upper bound."
                    >
                      <input
                        type="checkbox"
                        checked={settings.ai_loop_detector_enabled}
                        onChange={(e) =>
                          setSettings(
                            (s) =>
                              s && {
                                ...s,
                                ai_loop_detector_enabled: e.target.checked,
                              },
                          )
                        }
                      />
                      <span>Enable AI loop detector</span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "appearance" && (
              <div>
                <div className="settings-section-header">Appearance</div>
                <div className="settings-card">
                  <div style={rowStyle()}>
                    <span style={rowLabelStyle}>Theme</span>
                    <select
                      className="omni-select"
                      style={{ cursor: "pointer" }}
                      value={settings.theme}
                      onChange={(e) => {
                        const theme = e.target.value;
                        setSettings((s) => s && { ...s, theme });
                        if (theme === "dark" || theme === "light") {
                          onThemeChange?.(theme);
                        }
                      }}
                    >
                      <option value="dark">Dark (Battle Blue)</option>
                      <option value="light">Light (Catppuccin Latte)</option>
                    </select>
                  </div>
                  <div style={rowStyle()}>
                    <span style={rowLabelStyle}>Window size</span>
                    <div>
                      <div
                        className="window-size-options"
                        role="radiogroup"
                        aria-label="Window size"
                      >
                        {WINDOW_SIZE_OPTIONS.map((option) => (
                          <label
                            key={option.value}
                            className="window-size-option"
                          >
                            <input
                              type="radio"
                              name="window-size"
                              value={option.value}
                              checked={settings.window_size === option.value}
                              onChange={() => previewWindowSize(option.value)}
                            />
                            <span>
                              <strong>{option.label}</strong>
                              <small>
                                {option.width} × {option.height}
                              </small>
                            </span>
                          </label>
                        ))}
                        <label className="window-size-option">
                          <input
                            type="radio"
                            name="window-size"
                            value="custom"
                            checked={settings.window_size === "custom"}
                            onChange={() => previewWindowSize("custom")}
                          />
                          <span>
                            <strong>Custom</strong>
                            <small>
                              {settings.window_size_custom_width ??
                                DEFAULT_CUSTOM_WINDOW_WIDTH}{" "}
                              ×{" "}
                              {settings.window_size_custom_height ??
                                DEFAULT_CUSTOM_WINDOW_HEIGHT}
                            </small>
                          </span>
                        </label>
                      </div>
                      {settings.window_size === "custom" ? (
                        <div className="window-size-custom-inputs">
                          <label className="window-size-custom-field">
                            <span>Width</span>
                            <input
                              type="number"
                              className="omni-input"
                              min={CUSTOM_WINDOW_MIN_WIDTH}
                              max={CUSTOM_WINDOW_MAX_WIDTH}
                              step={1}
                              value={
                                settings.window_size_custom_width ??
                                DEFAULT_CUSTOM_WINDOW_WIDTH
                              }
                              onChange={(e) => {
                                const raw = e.target.value;
                                setSettings(
                                  (current) =>
                                    current && {
                                      ...current,
                                      window_size_custom_width:
                                        raw === "" ? undefined : Number(raw),
                                    },
                                );
                              }}
                              onBlur={(e) => {
                                const next = normalizeCustomDimension(
                                  e.target.value,
                                  "width",
                                );
                                void previewWindowSize("custom", {
                                  customWidth: next,
                                });
                              }}
                            />
                          </label>
                          <span className="window-size-custom-x">×</span>
                          <label className="window-size-custom-field">
                            <span>Height</span>
                            <input
                              type="number"
                              className="omni-input"
                              min={CUSTOM_WINDOW_MIN_HEIGHT}
                              max={CUSTOM_WINDOW_MAX_HEIGHT}
                              step={1}
                              value={
                                settings.window_size_custom_height ??
                                DEFAULT_CUSTOM_WINDOW_HEIGHT
                              }
                              onChange={(e) => {
                                const raw = e.target.value;
                                setSettings(
                                  (current) =>
                                    current && {
                                      ...current,
                                      window_size_custom_height:
                                        raw === "" ? undefined : Number(raw),
                                    },
                                );
                              }}
                              onBlur={(e) => {
                                const next = normalizeCustomDimension(
                                  e.target.value,
                                  "height",
                                );
                                void previewWindowSize("custom", {
                                  customHeight: next,
                                });
                              }}
                            />
                          </label>
                          <small className="window-size-custom-hint">
                            {CUSTOM_WINDOW_MIN_WIDTH}–{CUSTOM_WINDOW_MAX_WIDTH}{" "}
                            × {CUSTOM_WINDOW_MIN_HEIGHT}–
                            {CUSTOM_WINDOW_MAX_HEIGHT}
                          </small>
                        </div>
                      ) : null}
                      {windowSizeError ? (
                        <span role="alert" className="window-size-error">
                          {windowSizeError}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div
                    style={rowStyle(!showCustomBg)}
                  >
                    <span style={rowLabelStyle}>Background</span>
                    <select
                      className="omni-select"
                      style={{ cursor: "pointer" }}
                      value={bgSelectValue}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "__custom__") {
                          setCustomBgMode(true);
                        } else {
                          setCustomBgMode(false);
                          changeBackground(val);
                        }
                      }}
                    >
                      {BG_PRESETS.map((p) => (
                        <option key={p.label} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {showCustomBg && (
                    <div style={rowStyle(true)}>
                      <span style={rowLabelStyle}>Image URL</span>
                      <div>
                        <input
                          className="omni-input"
                          value={currentBgUrl}
                          onChange={(e) => {
                            setCustomBgMode(true);
                            changeBackground(e.target.value);
                          }}
                          placeholder="https://example.com/image.jpg"
                          aria-invalid={bgError ? true : undefined}
                        />
                        {bgError ? (
                          <span
                            role="alert"
                            className="window-size-error"
                            style={{ display: "block", marginTop: 6 }}
                          >
                            {bgError}
                          </span>
                        ) : null}
                        {bgLoadError ? (
                          <span
                            role="alert"
                            className="window-size-error"
                            style={{ display: "block", marginTop: 6 }}
                          >
                            Could not load this image. The URL is kept — check
                            it is reachable.
                          </span>
                        ) : null}
                        {/* Hidden probe: detects whether the image actually
                            loads at runtime so we can warn without discarding
                            the user's draft URL. */}
                        {isSafeBackgroundUrl(currentBgUrl) ? (
                          <img
                            data-testid="background-probe"
                            src={currentBgUrl}
                            alt=""
                            aria-hidden="true"
                            style={{
                              position: "absolute",
                              width: 1,
                              height: 1,
                              opacity: 0,
                              pointerEvents: "none",
                            }}
                            onError={() => setBgLoadError(true)}
                            onLoad={() => setBgLoadError(false)}
                          />
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === "general" && (
              <div>
                <div className="settings-section-header">General</div>
                <div className="settings-card">
                  <div style={rowStyle()}>
                    <span style={rowLabelStyle}>Hotkey</span>
                    <button
                      type="button"
                      className="omni-input"
                      onClick={() => {
                        setCapturingHotkey(true);
                        setHotkeyError("");
                        setHotkeyStatus("idle");
                      }}
                      onBlur={() => setCapturingHotkey(false)}
                      onKeyDown={handleHotkeyCapture}
                      style={{
                        color: capturingHotkey ? "var(--accent)" : "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        userSelect: "none",
                      }}
                      aria-label="Edit hotkey"
                    >
                      {capturingHotkey ? "Press new hotkey…" : settings.hotkey}
                    </button>
                    {hotkeyStatus === "success" && (
                      <span
                        className="omni-status omni-status--success"
                        style={{ gridColumn: "2" }}
                      >
                        ✓ Hotkey saved
                      </span>
                    )}
                    {hotkeyStatus === "error" && (
                      <span
                        className="omni-status omni-status--error"
                        style={{ gridColumn: "2" }}
                        title={hotkeyError}
                      >
                        ✗ {hotkeyError || "Hotkey failed"}
                      </span>
                    )}
                  </div>
                  <div style={rowStyle()}>
                    <span style={rowLabelStyle}>Screen text selection</span>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        cursor: "pointer",
                      }}
                      title="When enabled, Ctrl/Cmd+Shift+T or /select opens a mouse-drag region selector and inserts recognized text into the message box"
                    >
                      <input
                        type="checkbox"
                        checked={settings.screen_text_selection_enabled}
                        onChange={(e) =>
                          setSettings(
                            (s) =>
                              s && {
                                ...s,
                                screen_text_selection_enabled: e.target.checked,
                              },
                          )
                        }
                      />
                      <span>Enable selecting screen text with the mouse</span>
                    </label>
                  </div>
                  <div style={rowStyle(true)}>
                    <span style={rowLabelStyle}>Max Results</span>
                    <input
                      className="omni-input"
                      type="number"
                      min={1}
                      max={50}
                      value={settings.max_results}
                      onChange={(e) =>
                        setSettings(
                          (s) =>
                            s && {
                              ...s,
                              max_results: parseInt(e.target.value) || 10,
                            },
                        )
                      }
                    />
                  </div>
                </div>
              </div>
            )}

            {activeTab === "a2a" && (
              <div>
                <div className="settings-section-header">A2A Connections</div>
                <div
                  style={{ color: "var(--sub)", fontSize: 13, marginBottom: 12 }}
                >
                  Connect to omni-agent-hub or direct A2A agents. Each enabled
                  connection's skills become callable tools for the agent.
                </div>
                {(settings.a2a_connections ?? []).map((conn, idx) => (
                  <div
                    key={conn.id}
                    className="settings-card"
                    style={{ marginBottom: 12 }}
                  >
                    <div style={rowStyle()}>
                      <span style={rowLabelStyle}>Name</span>
                      <input
                        className="omni-input"
                        aria-label={`name-${idx}`}
                        value={conn.name}
                        onChange={(e) =>
                          updateA2a(idx, { name: e.target.value })
                        }
                      />
                    </div>
                    <div style={rowStyle()}>
                      <span style={rowLabelStyle}>Endpoint</span>
                      <input
                        className="omni-input"
                        aria-label={`endpoint-${idx}`}
                        placeholder="http://127.0.0.1:8222"
                        value={conn.endpoint}
                        onChange={(e) =>
                          updateA2a(idx, { endpoint: e.target.value })
                        }
                      />
                    </div>
                    <div style={rowStyle()}>
                      <span style={rowLabelStyle}>Token</span>
                      <input
                        className="omni-input"
                        type="password"
                        aria-label={`token-${idx}`}
                        placeholder="(optional bearer token)"
                        value={conn.token}
                        onChange={(e) =>
                          updateA2a(idx, { token: e.target.value })
                        }
                      />
                    </div>
                    <div style={rowStyle(true)}>
                      <span style={rowLabelStyle}>Enabled</span>
                      <div
                        style={{ display: "flex", gap: 10, alignItems: "center" }}
                      >
                        <input
                          type="checkbox"
                          aria-label={`enabled-${idx}`}
                          checked={conn.enabled}
                          onChange={(e) =>
                            updateA2a(idx, { enabled: e.target.checked })
                          }
                        />
                        <button
                          type="button"
                          className="omni-btn"
                          onClick={() => discoverA2a(conn)}
                        >
                          Discover
                        </button>
                        <button
                          type="button"
                          className="omni-btn"
                          onClick={() => removeA2a(idx)}
                        >
                          Remove
                        </button>
                        {a2aDiscovery[conn.id] ? (
                          <span
                            style={{ fontSize: 12, color: "var(--sub)" }}
                          >
                            {a2aDiscovery[conn.id]}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="omni-btn omni-btn--primary"
                  onClick={addA2a}
                >
                  Add connection
                </button>
              </div>
            )}
          </div>

          {/* Save bar */}
          <div
            style={{
              padding: "12px 28px",
              flexShrink: 0,
              borderTop: "1px solid var(--border)",
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: 10,
            }}
          >
            {saveStatus === "success" && (
              <span
                role="status"
                aria-live="polite"
                className="omni-status omni-status--success"
              >
                ✓ Saved
              </span>
            )}
            {saveStatus === "error" && (
              <span role="alert" className="omni-status omni-status--error">
                ✗ Save failed
              </span>
            )}
            <button
              type="button"
              className="omni-btn omni-btn--primary"
              onClick={handleSave}
              disabled={saveStatus === "success"}
              aria-disabled={saveStatus === "success"}
            >
              {saveStatus === "success" ? "✓ Saved" : "Save Settings"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
