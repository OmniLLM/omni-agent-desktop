import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types/app";

const THINKING_ICON: Record<string, string> = {
  thought: "💭",
  action: "⚡",
  result: "↳",
};

const THINKING_LABEL: Record<string, string> = {
  thought: "Thinking",
  action: "Action",
  result: "Result",
};

/** Live "working…" indicator with a blinking dot and an elapsed-seconds timer. */
function WorkingIndicator() {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(performance.now());

  useEffect(() => {
    startRef.current = performance.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      setElapsed((performance.now() - startRef.current) / 1000);
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="thinking-indicator" role="status" aria-live="polite">
      <span className="thinking-pulse" aria-hidden="true" />
      <span className="thinking-text">Working…</span>
      <span className="thinking-timer">{elapsed.toFixed(1)}s</span>
    </div>
  );
}

export default function ChatPane({
  messages,
  loading = false,
}: {
  messages: ChatMessage[];
  loading?: boolean;
}) {
  return (
    <div className="chat-pane">
      {messages.map((m, i) => {
        if (m.role === "thinking") {
          const kind = m.kind ?? "thought";
          return (
            <div key={i} className={`trace trace-${kind}`}>
              <span className="trace-icon" aria-hidden="true">
                {THINKING_ICON[kind]}
              </span>
              <span className="trace-label">{THINKING_LABEL[kind]}</span>
              <span className="trace-content">{m.content}</span>
            </div>
          );
        }
        return (
          <div key={i} className={`bubble ${m.role}`}>
            <div className="role">{m.role}</div>
            <div className="content">{m.content}</div>
            {m.tools_used?.length ? (
              <div className="tools">tools: {m.tools_used.join(", ")}</div>
            ) : null}
          </div>
        );
      })}
      {loading ? <WorkingIndicator /> : null}
    </div>
  );
}
