import { useEffect, useRef, useState } from "react";
import { invoke } from "./lib/runtime";
import ChatPane from "./components/ChatPane";
import Composer from "./components/Composer";
import ToolApprovalPrompt from "./components/ToolApprovalPrompt";
import SettingsWindow from "./components/SettingsWindow";
import GlobalKeyframes from "./components/GlobalKeyframes";
import AppShell from "./components/AppShell";
import { useAgent } from "./hooks/useAgent";
import { useTheme } from "./hooks/useTheme";
import type { ThemeMode } from "./utils/theme";
import type { AppSettings } from "./types/app";

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [, setSettings] = useState<AppSettings | null>(null);
  const { resolvedTheme, setTheme } = useTheme();
  const { messages, loading, pendingApproval, send, decide } = useAgent();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        setSettings(s);
        if (s?.theme) setTheme(s.theme as ThemeMode);
      })
      .catch(() => {});
  }, [setTheme]);

  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

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
          <button
            className="settings-toggle"
            onClick={() => setShowSettings((v) => !v)}
          >
            {showSettings ? "Close settings" : "Settings"}
          </button>
          {showSettings ? (
            <SettingsWindow onClose={() => setShowSettings(false)} />
          ) : (
            <div className="agent-main" ref={scrollRef}>
              <ChatPane messages={messages} />
              {pendingApproval ? (
                <ToolApprovalPrompt call={pendingApproval} onDecide={decide} />
              ) : null}
              <Composer onSend={send} disabled={loading} />
            </div>
          )}
        </div>
      </AppShell>
    </>
  );
}
