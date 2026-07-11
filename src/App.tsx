import { useEffect, useRef, useState } from "react";
import { invoke } from "./lib/runtime";
import ChatPane from "./components/ChatPane";
import Composer from "./components/Composer";
import WelcomeScreen from "./components/WelcomeScreen";
import ScheduledView from "./components/ScheduledView";
import PluginsView from "./components/PluginsView";
import ToolApprovalPrompt from "./components/ToolApprovalPrompt";
import SettingsWindow from "./components/SettingsWindow";
import Sidebar, {
  type WorkspaceView,
  type Project,
} from "./components/Sidebar";
import GlobalKeyframes from "./components/GlobalKeyframes";
import AppShell from "./components/AppShell";
import { useAgent } from "./hooks/useAgent";
import { useTheme } from "./hooks/useTheme";
import type { AppSettings } from "./types/app";
import { applyWindowSize, normalizeWindowSize } from "./lib/windowSize";
import { parseThemeMode } from "./utils/theme";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `p-${Date.now()}`;
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<WorkspaceView>("chat");
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
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
  const projectsLoadedRef = useRef(false);

  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  // Load persisted projects once on mount.
  useEffect(() => {
    invoke<Project[]>("list_projects")
      .then((list) => {
        if (Array.isArray(list)) setProjects(list);
      })
      .catch(() => {})
      .finally(() => {
        projectsLoadedRef.current = true;
      });
  }, []);

  // Persist projects whenever they change (after the initial load).
  useEffect(() => {
    if (!projectsLoadedRef.current) return;
    invoke("save_projects", { projects }).catch(() => {});
  }, [projects]);

  const requestCloseSettings = () => {
    const closer = settingsCloseRef.current;
    if (closer) {
      void closer();
    } else {
      setShowSettings(false);
    }
  };

  useEffect(() => {
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
  }, [setTheme]);

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

  const handleNewProject = () => {
    const name = window.prompt("Project name:")?.trim();
    if (!name) return;
    const project = { id: newId(), name };
    setProjects((prev) => [...prev, project]);
    setCurrentProjectId(project.id);
  };

  const handleNewTask = () => {
    newSession();
    setView("chat");
  };

  const submit = (text: string) => {
    void send(text, approveForMe ? "autopilot" : "ask");
  };

  const currentProject = projects.find((p) => p.id === currentProjectId);
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
        {showSettings ? (
          <div
            className="settings-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) requestCloseSettings();
            }}
          >
            <div className="settings-sheet">
              <SettingsWindow
                onClose={() => setShowSettings(false)}
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
              projects={projects}
              currentProjectId={currentProjectId}
              onSelectProject={setCurrentProjectId}
              onNewProject={handleNewProject}
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
                  model={settings?.ai_model ?? ""}
                  projectName={currentProject?.name ?? null}
                  onChooseProject={() => {
                    if (projects.length === 0) handleNewProject();
                    else
                      setCurrentProjectId(
                        currentProjectId
                          ? null
                          : (projects[0]?.id ?? null),
                      );
                  }}
                  approveForMe={approveForMe}
                  onToggleApprove={setApproveForMe}
                />
              </>
            ) : (
              <div className="workspace-main__scroll">
                {view === "scheduled" ? (
                  <ScheduledView
                    onRun={(prompt) => {
                      setView("chat");
                      submit(prompt);
                    }}
                  />
                ) : (
                  <PluginsView
                    connections={settings?.a2a_connections ?? []}
                    onManage={() => setShowSettings(true)}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </AppShell>
    </>
  );
}
