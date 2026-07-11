import { useEffect, useRef, useState } from "react";
import { invoke } from "./lib/runtime";
import ChatPane from "./components/ChatPane";
import Composer from "./components/Composer";
import ToolApprovalPrompt from "./components/ToolApprovalPrompt";
import SettingsWindow from "./components/SettingsWindow";
import SessionToolbar from "./components/SessionToolbar";
import GlobalKeyframes from "./components/GlobalKeyframes";
import AppShell from "./components/AppShell";
import { useAgent } from "./hooks/useAgent";
import { useTheme } from "./hooks/useTheme";
import type { AppSettings } from "./types/app";
import { applyWindowSize, normalizeWindowSize } from "./lib/windowSize";
import { parseThemeMode } from "./utils/theme";

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [, setSettings] = useState<AppSettings | null>(null);
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

  // Settings is invoked by Ctrl/Cmd+, (toggle) and dismissed by Escape —
  // there is no visible settings button.
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

  return (
    <>
      <GlobalKeyframes />
      <AppShell
        resolvedTheme={resolvedTheme}
        backgroundUrl=""
        isCompactMode={false}
        isAiMode={true}
      >
        <div className="agent-root">
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
          <div className="agent-main">
            <SessionToolbar
              sessions={sessions}
              currentSessionId={currentSessionId}
              onNew={newSession}
              onSwitch={switchSession}
              onDelete={deleteSession}
            />
            <div className="chat-scroll" ref={scrollRef}>
              <ChatPane messages={messages} loading={loading} />
            </div>
            {pendingApproval ? (
              <ToolApprovalPrompt call={pendingApproval} onDecide={decide} />
            ) : null}
            <Composer onSend={send} disabled={loading} />
          </div>
        </div>
      </AppShell>
    </>
  );
}
