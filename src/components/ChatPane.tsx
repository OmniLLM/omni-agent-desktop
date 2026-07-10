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

export default function ChatPane({ messages }: { messages: ChatMessage[] }) {
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
    </div>
  );
}
