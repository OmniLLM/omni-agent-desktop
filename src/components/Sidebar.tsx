import type { SessionInfo } from "../types/app";
import Icon, { type IconName } from "./Icon";

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

const NAV_ITEMS: { view: WorkspaceView; icon: IconName; label: string }[] = [
  { view: "chat", icon: "compose", label: "New task" },
  { view: "scheduled", icon: "clock", label: "Scheduled" },
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
          title="Hide sidebar (Ctrl+H)"
          onClick={onToggleCollapse}
        >
          <Icon name="sidebar" size={18} />
        </button>
        <span className="sidebar__brand">
          <span className="sidebar__brand-name">Omni Agent</span>
          <span className="sidebar__brand-accent">Your workspace</span>
        </span>
      </div>

      <nav className="sidebar__nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            type="button"
            aria-current={view === item.view ? "page" : undefined}
            className={`sidebar__item${
              view === item.view ? " is-active" : ""
            }`}
            onClick={() => {
              if (item.view === "chat") onNewTask();
              onSelectView(item.view);
            }}
          >
            <span className="sidebar__item-icon" aria-hidden="true">
              <Icon name={item.icon} size={18} />
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
            {sessions.map((session) => {
              const label = session.title?.trim() || "Untitled task";
              return (
              <div
                key={session.id}
                className={`sidebar__task${
                  session.id === currentSessionId ? " is-active" : ""
                }`}
              >
                <button
                  type="button"
                  className="sidebar__task-title"
                  onClick={() => onSelectTask(session.id)}
                  aria-current={session.id === currentSessionId ? "true" : undefined}
                  title={label}
                >
                  {label}
                </button>
                <button
                  type="button"
                  className="sidebar__task-delete"
                  aria-label={`Delete ${label}`}
                  onClick={() => onDeleteTask(session.id)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              );
            })}
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
            <Icon name="settings" size={18} />
          </span>
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
