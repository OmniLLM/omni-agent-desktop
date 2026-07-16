import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "./lib/runtime";
import ChatPane from "./components/ChatPane";
import Composer from "./components/Composer";
import WelcomeScreen from "./components/WelcomeScreen";
import ScheduledView from "./components/ScheduledView";
import ToolApprovalPrompt from "./components/ToolApprovalPrompt";
import SettingsWindow from "./components/SettingsWindow";
import HelpPanel from "./components/HelpPanel";
import SkillsPanel from "./components/SkillsPanel";
import ToastHost from "./components/ToastHost";
import Sidebar, { type WorkspaceView } from "./components/Sidebar";
import Titlebar from "./components/Titlebar";
import GlobalKeyframes from "./components/GlobalKeyframes";
import AppShell from "./components/AppShell";
import { useAgent } from "./hooks/useAgent";
import { useToasts } from "./hooks/useToasts";
import { useTheme } from "./hooks/useTheme";
import type { AppSettings, ProviderType, RunMode } from "./types/app";
import type { SlashContext, SlashCommand } from "./lib/slashCommands";
import { applyWindowSize, normalizeWindowSize } from "./lib/windowSize";
import { parseThemeMode } from "./utils/theme";

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Live background preview while Settings is open. `null` means "no active
  // preview — use the persisted settings background". Kept separate from
  // `settings` so an unsaved draft never mutates persisted state.
  const [backgroundPreview, setBackgroundPreview] = useState<string | null>(
    null,
  );
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<WorkspaceView>("chat");
  const [approveForMe, setApproveForMe] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  // Agent run mode chosen via `/agent`. Seeded from persisted settings; falls
  // back to the Approve-for-me toggle when unset so behavior is unchanged for
  // users who never invoke the command.
  const [runMode, setRunMode] = useState<RunMode | null>(null);
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
    renameSession,
    stop,
    compact,
    notify,
  } = useAgent();
  const { toasts, pushToast, dismissToast } = useToasts();
  const scrollRef = useRef<HTMLDivElement>(null);
  const settingsCloseRef = useRef<(() => Promise<void>) | null>(null);
  const showSettingsRef = useRef(false);
  const showHelpRef = useRef(false);
  const composerRef = useRef<{ setText: (text: string) => void } | null>(null);

  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  useEffect(() => {
    showHelpRef.current = showHelp;
  }, [showHelp]);

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
        void applyWindowSize(preset, {
          customWidth: s?.window_size_custom_width,
          customHeight: s?.window_size_custom_height,
        }).catch((error) => {
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
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "h" || e.key === "H")) {
        e.preventDefault();
        setCollapsed((v) => !v);
      } else if (e.key === "Escape") {
        if (showHelpRef.current) setShowHelp(false);
        else if (showSettingsRef.current) requestCloseSettings();
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
    // Precedence: an explicit `/agent` choice wins; otherwise fall back to the
    // Approve-for-me toggle (autopilot vs. ask), preserving prior behavior.
    const mode: RunMode = runMode ?? (approveForMe ? "autopilot" : "ask");
    void send(text, mode);
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

  // Runtime surface handed to the slash-command registry. Rebuilt when the
  // handlers/state it captures change so commands always act on current state.
  const slashContext: SlashContext = useMemo(
    () => ({
      newSession: handleNewTask,
      clearSession: newSession,
      renameSession: (title) => {
        if (currentSessionId) return renameSession(currentSessionId, title);
      },
      setRunMode,
      stopRun: stop,
      compact,
      openSettings: () => setShowSettings(true),
      openHelp: () => setShowHelp(true),
      openSkills: () => setShowSkills(true),
      notify,
      toast: pushToast,
      loading,
    }),
    [
      newSession,
      currentSessionId,
      renameSession,
      stop,
      compact,
      notify,
      pushToast,
      loading,
    ],
  );

  // The background actually shown: an active live preview takes precedence over
  // the persisted setting; otherwise fall back to the saved background.
  const effectiveBackground =
    backgroundPreview ?? settings?.background_url ?? "";

  return (
    <>
      <GlobalKeyframes />
      <AppShell
        resolvedTheme={resolvedTheme}
        backgroundUrl={effectiveBackground}
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
                  setBackgroundPreview(null);
                  loadSettings();
                }}
                onThemeChange={setTheme}
                onBackgroundPreview={setBackgroundPreview}
                registerClose={(fn) => {
                  settingsCloseRef.current = fn;
                }}
              />
            </div>
          </div>
        ) : null}

        {showHelp ? (
          <HelpPanel
            onClose={() => setShowHelp(false)}
            onPick={(cmd: SlashCommand) => {
              setShowHelp(false);
              // Argument commands need input from the user, so prefill the
              // composer and let them finish typing. All other commands run
              // immediately via the shared slash-context handlers.
              if (cmd.kind === "argument") {
                composerRef.current?.setText(`/${cmd.name} `);
                return;
              }
              const ctx: SlashContext = {
                ...slashContext,
                openModelMenu: () => {
                  /* handled inside the composer; not reachable from help */
                },
              };
              void cmd.run(ctx, "");
            }}
          />
        ) : null}

        {showSkills ? (
          <SkillsPanel onClose={() => setShowSkills(false)} />
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
                title="Show sidebar (Ctrl+H)"
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
                  slash={slashContext}
                  loading={loading}
                  onCancel={stop}
                  composerRef={composerRef}
                />
              </>
            ) : (
              <div className="workspace-main__scroll">
                <ScheduledView />
              </div>
            )}
          </div>
        </div>
      </AppShell>
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
