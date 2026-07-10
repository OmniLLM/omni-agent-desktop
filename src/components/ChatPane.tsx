import type { ChatMessage } from "../types/app";

export default function ChatPane({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="chat-pane">
      {messages.map((m, i) => (
        <div key={i} className={`bubble ${m.role}`}>
          <div className="role">{m.role}</div>
          <div className="content">{m.content}</div>
          {m.tools_used?.length ? (
            <div className="tools">tools: {m.tools_used.join(", ")}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
