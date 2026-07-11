import type { SessionInfo } from "../types/app";

export default function SessionBar({
  sessions,
  currentSessionId,
  onNew,
  onSwitch,
  onDelete,
}: {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  onNew: () => void;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="session-bar" aria-label="Conversations">
      <button className="session-new" onClick={onNew}>
        <span aria-hidden="true">＋</span> New chat
      </button>
      <div className="session-list">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${
              s.id === currentSessionId ? "active" : ""
            }`}
          >
            <button
              className="session-open"
              title={s.title}
              onClick={() => onSwitch(s.id)}
            >
              <span className="session-title">{s.title}</span>
              <span className="session-count">{s.message_count}</span>
            </button>
            <button
              className="session-delete"
              title="Delete conversation"
              aria-label="Delete conversation"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
