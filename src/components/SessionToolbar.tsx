import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "../types/app";

interface Props {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  onNew: () => void;
  onSwitch: (id: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
}

function messageLabel(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"}`;
}

export default function SessionToolbar({
  sessions,
  currentSessionId,
  onNew,
  onSwitch,
  onDelete,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find(
    (session) => session.id === currentSessionId,
  );
  const activeTitle = activeSession?.title ?? "New conversation";

  useEffect(() => {
    if (!pickerOpen && !actionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
        setActionsOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPickerOpen(false);
        setActionsOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen, actionsOpen]);

  const handleSwitch = async (id: string) => {
    setPickerOpen(false);
    setError("");
    try {
      await onSwitch(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    setActionsOpen(false);
    if (!currentSessionId) return;
    if (
      !window.confirm("Delete this conversation? This cannot be undone.")
    ) {
      return;
    }
    setError("");
    try {
      await onDelete(currentSessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="session-toolbar" ref={rootRef}>
      <div className="session-picker">
        <button
          type="button"
          className="session-picker__trigger"
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          onClick={() => {
            setActionsOpen(false);
            setPickerOpen((open) => !open);
          }}
        >
          <span className="session-picker__title">{activeTitle}</span>
          <span aria-hidden="true">▾</span>
        </button>
        {pickerOpen ? (
          <ul className="session-picker__menu" role="listbox">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={session.id === currentSessionId}
                  className="session-picker__option"
                  onClick={() => handleSwitch(session.id)}
                >
                  <span className="session-picker__option-title">
                    {session.title}
                  </span>
                  <span className="session-picker__option-count">
                    {messageLabel(session.message_count)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <button
        type="button"
        className="session-toolbar__new"
        onClick={() => {
          setPickerOpen(false);
          setActionsOpen(false);
          onNew();
        }}
      >
        <span aria-hidden="true">＋</span> <span>New chat</span>
      </button>

      <div className="session-actions">
        <button
          type="button"
          className="session-toolbar__more"
          aria-haspopup="menu"
          aria-expanded={actionsOpen}
          aria-label="Conversation actions"
          onClick={() => {
            setPickerOpen(false);
            setActionsOpen((open) => !open);
          }}
        >
          <span aria-hidden="true">⋯</span>
        </button>
        {actionsOpen ? (
          <div className="session-actions__menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="session-actions__item"
              disabled={!currentSessionId}
              onClick={handleDelete}
            >
              Delete current
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <span className="session-toolbar__status" role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}
