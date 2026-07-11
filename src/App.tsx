import { useEffect, useRef, useState } from "react";
import { invoke } from "./lib/runtime";
import ChatPane from "./components/ChatPane";
import Composer from "./components/Composer";
import WelcomeScreen from "./components/WelcomeScreen";
import ScheduledView from "./components/ScheduledView";
import ToolApprovalPrompt from "./components/ToolApprovalPrompt";
import SettingsWindow from "./components/SettingsWindow";
import Sidebar, { type WorkspaceView } from "./components/Sidebar";
import Titlebar from "./components/Titlebar";
import GlobalKeyframes from "./components/GlobalKeyframes";
import AppShell from "./components/AppShell";
import { useAgent } from "./hooks/useAgent";
import { useTheme } from "./hooks/useTheme";
import type { AppSettings, ProviderType } from "./types/app";
import { applyWindowSize, normalizeWindowSize } from "./lib/windowSize";
import { parseThemeMode } from "./utils/theme";

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<WorkspaceView>("chat");
  const [approveForMe, setApproveForMe] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const {
    messages,
    loading,
    pendingApproval,
    sessions,
    currentSessionId,
    send,
    decide,
    newSession,
    switchSession,
    deleteSession,
  } = useAgent();
  const scrollRef = useRef<HTMLDivElement>(null);
  const settingsCloseRef = useRef<(() => Promise<void>) | null>(null);
  const showSettingsRef = useRef(false);

  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  const requestCloseSettings = () => {
    const closer = settingsCloseRef.current;
    if (closer) {
      void closer();
    } else {
      setShowSettings(false);
    }
  };

  const loadSettings = () => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        const preset = normalizeWindowSize(s?.window_size);
        setSettings({ ...s, window_size: preset });
        if (s?.theme) setTheme(parseThemeMode(s.theme));
        void applyWindowSize(preset).catch((error) => {
          console.error("Failed to apply saved window size:", error);
        });
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setShowSettings((v) => !v);
      } else if (e.key === "Escape") {
        if (showSettingsRef.current) requestCloseSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleNewTask = () => {
    newSession();
    setView("chat");
  };

  const submit = (text: string) => {
    void send(text, approveForMe ? "autopilot" : "ask");
  };

  // Change provider/model from the composer picker and persist it, mirroring
  // the values Preferences reads/writes (active_provider + provider_configs).
  const handleModelChange = (provider: ProviderType, model: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next: AppSettings = {
        ...prev,
        active_provider: provider,
        ai_model: model,
        provider_configs: {
          ...prev.provider_configs,
          [provider]: {
            ...prev.provider_configs[provider],
            model,
          },
        },
      };
      const cfg = next.provider_configs[provider];
      next.ai_base_url = cfg?.endpoint ?? "";
      next.ai_api_key = cfg?.api_key ?? "";
      invoke("save_settings_cmd", { settings: next }).catch(() => {});
      return next;
    });
  };

  const isEmpty = messages.length === 0;

  return (
    <>
      <GlobalKeyframes />
      <AppShell
        resolvedTheme={resolvedTheme}
        backgroundUrl=""
        isCompactMode={false}
        isAiMode={true}
      >
        <Titlebar />
        {showSettings ? (
          <div
            className="settings-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) requestCloseSettings();
            }}
          >
            <div className="settings-sheet">
              <SettingsWindow
                onClose={() => {
                  setShowSettings(false);
                  loadSettings();
                }}
                onThemeChange={setTheme}
                registerClose={(fn) => {
                  settingsCloseRef.current = fn;
                }}
              />
            </div>
          </div>
        ) : null}

        <div
          className={`workspace${collapsed ? " workspace--collapsed" : ""}`}
        >
          {collapsed ? null : (
            <Sidebar
              collapsed={collapsed}
              onToggleCollapse={() => setCollapsed((v) => !v)}
              view={view}
              onSelectView={setView}
              sessions={sessions}
              currentSessionId={currentSessionId}
              onNewTask={handleNewTask}
              onSelectTask={(id) => {
                setView("chat");
                void switchSession(id);
              }}
              onDeleteTask={(id) => void deleteSession(id)}
              onOpenSettings={() => setShowSettings(true)}
            />
          )}

          <div className="workspace-main">
            {collapsed ? (
              <button
                type="button"
                className="sidebar-show"
                aria-label="Show sidebar"
                title="Show sidebar"
                onClick={() => setCollapsed(false)}
              >
                ⇥
              </button>
            ) : null}
            {view === "chat" ? (
              <>
                <div className="workspace-main__scroll" ref={scrollRef}>
                  {isEmpty ? (
                    <WelcomeScreen onPick={submit} />
                  ) : (
                    <ChatPane messages={messages} loading={loading} />
                  )}
                </div>
                {pendingApproval ? (
                  <ToolApprovalPrompt call={pendingApproval} onDecide={decide} />
                ) : null}
                <Composer
                  onSend={submit}
                  disabled={loading}
                  settings={settings}
                  onModelChange={handleModelChange}
                  approveForMe={approveForMe}
                  onToggleApprove={setApproveForMe}
                />
              </>
            ) : (
              <div className="workspace-main__scroll">
                <ScheduledView
                  onRun={(prompt) => {
                    setView("chat");
                    submit(prompt);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </AppShell>
    </>
  );
}
