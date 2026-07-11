import type { SessionInfo } from "../types/app";

export type WorkspaceView = "chat" | "scheduled";

interface Props {
  collapsed: boolean;
  onToggleCollapse: () => void;
  view: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
  sessions: SessionInfo[];
  currentSessionId: string | null;
  onNewTask: () => void;
  onSelectTask: (id: string) => void;
  onDeleteTask: (id: string) => void;
  onOpenSettings: () => void;
}

const NAV_ITEMS: { view: WorkspaceView; icon: string; label: string }[] = [
  { view: "chat", icon: "✎", label: "New task" },
  { view: "scheduled", icon: "◔", label: "Scheduled" },
];

export default function Sidebar({
  onToggleCollapse,
  view,
  onSelectView,
  sessions,
  currentSessionId,
  onNewTask,
  onSelectTask,
  onDeleteTask,
  onOpenSettings,
}: Props) {
  return (
    <aside className="sidebar" aria-label="Workspace navigation">
      <div className="sidebar__header">
        <button
          type="button"
          className="sidebar__icon-btn"
          aria-label="Hide sidebar"
          title="Hide sidebar"
          onClick={onToggleCollapse}
        >
          ⇤
        </button>
        <span className="sidebar__brand">
          Agent <span className="sidebar__brand-accent">Desktop</span>
        </span>
      </div>

      <nav className="sidebar__nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            type="button"
            className={`sidebar__item${
              view === item.view ? " is-active" : ""
            }`}
            onClick={() => {
              if (item.view === "chat") onNewTask();
              onSelectView(item.view);
            }}
          >
            <span className="sidebar__item-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar__scroll">
        <div className="sidebar__section">Tasks</div>
        {sessions.length === 0 ? (
          <div className="sidebar__empty">No tasks yet</div>
        ) : (
          <div className="sidebar__tasks">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`sidebar__task${
                  session.id === currentSessionId ? " is-active" : ""
                }`}
              >
                <span
                  className="sidebar__task-title"
                  onClick={() => onSelectTask(session.id)}
                  title={session.title}
                >
                  {session.title}
                </span>
                <button
                  type="button"
                  className="sidebar__task-delete"
                  aria-label={`Delete ${session.title}`}
                  onClick={() => onDeleteTask(session.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar__footer">
        <button
          type="button"
          className="sidebar__item"
          style={{ width: "auto", flex: 1 }}
          onClick={onOpenSettings}
        >
          <span className="sidebar__item-icon" aria-hidden="true">
            ⚙
          </span>
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
