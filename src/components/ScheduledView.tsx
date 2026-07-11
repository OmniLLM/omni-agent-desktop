import { useEffect, useState } from "react";
import { invoke, listen } from "../lib/runtime";
import type {
  Cadence,
  ScheduledTask,
  SchedulerStatusEvent,
} from "../types/app";

const CADENCES: Cadence[] = ["Hourly", "Daily", "Weekly"];

/** Format a Unix-seconds timestamp (or null) as a readable local string. */
function formatTime(ts: number | null): string {
  if (!ts) return "never";
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return "never";
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Something went wrong";
}

export default function ScheduledView(_props: {
  onRun?: (prompt: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState<Cadence>("Daily");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Merge one authoritative task into the list (replace if present, else append).
  const reconcile = (task: ScheduledTask) =>
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id);
      if (idx === -1) return [...prev, task];
      const next = prev.slice();
      next[idx] = task;
      return next;
    });

  useEffect(() => {
    invoke<ScheduledTask[]>("list_scheduled")
      .then((list) => {
        if (Array.isArray(list)) setTasks(list);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  // Subscribe to authoritative status events; update only the matching task.
  // Guard against updates after unmount and against a late `listen` promise
  // resolving after teardown (async listen race), preventing duplicate
  // listeners and post-unmount state updates.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    listen<SchedulerStatusEvent>("scheduler://status", ({ payload }) => {
      if (!active) return;
      setTasks((prev) =>
        prev.map((t) =>
          t.id === payload.id
            ? {
                ...t,
                last_status: payload.status,
                last_run_at: payload.last_run_at,
                next_run_at: payload.next_run_at,
                last_error: payload.last_error,
              }
            : t,
        ),
      );
    })
      .then((fn) => {
        if (!active) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, []);

  const resetForm = () => {
    setPrompt("");
    setCadence("Daily");
    setEditingId(null);
  };

  const submitForm = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        const existing = tasks.find((t) => t.id === editingId);
        const updated = await invoke<ScheduledTask>("update_scheduled", {
          id: editingId,
          prompt: trimmed,
          cadence,
          enabled: existing ? existing.enabled : true,
        });
        reconcile(updated);
      } else {
        const created = await invoke<ScheduledTask>("create_scheduled", {
          prompt: trimmed,
          cadence,
          enabled: true,
        });
        reconcile(created);
      }
      resetForm();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (task: ScheduledTask) => {
    setEditingId(task.id);
    setPrompt(task.prompt);
    setCadence(task.cadence);
    setError(null);
  };

  const toggleEnabled = async (task: ScheduledTask) => {
    setError(null);
    try {
      const updated = await invoke<ScheduledTask>("update_scheduled", {
        id: task.id,
        prompt: task.prompt,
        cadence: task.cadence,
        enabled: !task.enabled,
      });
      reconcile(updated);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await invoke("delete_scheduled", { id });
      setTasks((prev) => prev.filter((t) => t.id !== id));
      if (editingId === id) resetForm();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (running.has(task.id)) return;
    setError(null);
    setRunning((prev) => new Set(prev).add(task.id));
    try {
      const updated = await invoke<ScheduledTask>("run_scheduled_now", {
        id: task.id,
      });
      reconcile(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  return (
    <div className="panel-view">
      <h2 className="panel-view__title">Scheduled tasks</h2>
      <p className="panel-view__subtitle">
        Save prompts you run regularly. Run one on demand, toggle it off, or
        delete it when you're done.
      </p>

      {error ? (
        <div className="panel-view__error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="panel-view__form">
        <input
          className="panel-view__input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitForm();
          }}
          aria-label="Task prompt"
          placeholder="What should run on a schedule?"
        />
        <select
          className="panel-view__select"
          value={cadence}
          aria-label="Cadence"
          onChange={(e) => setCadence(e.target.value as Cadence)}
        >
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="panel-view__btn"
          onClick={() => void submitForm()}
          disabled={busy}
        >
          {editingId ? "Save" : "Add"}
        </button>
        {editingId ? (
          <button
            type="button"
            className="panel-view__btn panel-view__btn--ghost"
            onClick={resetForm}
          >
            Cancel
          </button>
        ) : null}
      </div>

      {tasks.length === 0 ? (
        <div className="panel-view__empty">No scheduled tasks yet.</div>
      ) : (
        <ul className="panel-view__list">
          {tasks.map((task) => {
            const isRunning = running.has(task.id);
            return (
              <li key={task.id} className="panel-view__row">
                <div className="panel-view__row-main">
                  <span className="panel-view__row-title">{task.prompt}</span>
                  <span className="panel-view__row-meta">
                    {task.cadence} · {task.last_status}
                    {" · last "}
                    {formatTime(task.last_run_at)}
                    {" · next "}
                    {formatTime(task.next_run_at)}
                  </span>
                  {task.last_error ? (
                    <span
                      className="panel-view__row-error"
                      title={task.last_error}
                    >
                      {task.last_error}
                    </span>
                  ) : null}
                </div>
                <label className="panel-view__toggle">
                  <input
                    type="checkbox"
                    aria-label={`Enabled: ${task.prompt}`}
                    checked={task.enabled}
                    onChange={() => void toggleEnabled(task)}
                  />
                  <span>Enabled</span>
                </label>
                <button
                  type="button"
                  className="panel-view__btn panel-view__btn--ghost"
                  aria-label="Run now"
                  onClick={() => void runNow(task)}
                  disabled={isRunning}
                >
                  {isRunning ? "Running…" : "Run now"}
                </button>
                <button
                  type="button"
                  className="panel-view__btn panel-view__btn--ghost"
                  onClick={() => startEdit(task)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="panel-view__btn panel-view__btn--ghost"
                  onClick={() => void remove(task.id)}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
