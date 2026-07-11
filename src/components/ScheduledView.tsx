import { useEffect, useRef, useState } from "react";
import { invoke } from "../lib/runtime";

export interface ScheduledTask {
  id: string;
  prompt: string;
  cadence: string;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `t-${Date.now()}`;
}

export default function ScheduledView({
  onRun,
}: {
  onRun: (prompt: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState("Daily");
  const loadedRef = useRef(false);

  useEffect(() => {
    invoke<ScheduledTask[]>("list_scheduled")
      .then((list) => {
        if (Array.isArray(list)) setTasks(list);
      })
      .catch(() => {})
      .finally(() => {
        loadedRef.current = true;
      });
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    invoke("save_scheduled", { scheduled: tasks }).catch(() => {});
  }, [tasks]);

  const add = () => {
    if (!prompt.trim()) return;
    setTasks((prev) => [...prev, { id: newId(), prompt: prompt.trim(), cadence }]);
    setPrompt("");
  };

  const remove = (id: string) =>
    setTasks((prev) => prev.filter((t) => t.id !== id));

  return (
    <div className="panel-view">
      <h2 className="panel-view__title">Scheduled tasks</h2>
      <p className="panel-view__subtitle">
        Save prompts you run regularly. Run one on demand, or delete it when
        you're done.
      </p>

      <div className="panel-view__form">
        <input
          className="panel-view__input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="What should run on a schedule?"
        />
        <select
          className="panel-view__select"
          value={cadence}
          onChange={(e) => setCadence(e.target.value)}
        >
          <option>Hourly</option>
          <option>Daily</option>
          <option>Weekly</option>
        </select>
        <button type="button" className="panel-view__btn" onClick={add}>
          Add
        </button>
      </div>

      {tasks.length === 0 ? (
        <div className="panel-view__empty">No scheduled tasks yet.</div>
      ) : (
        <ul className="panel-view__list">
          {tasks.map((task) => (
            <li key={task.id} className="panel-view__row">
              <div className="panel-view__row-main">
                <span className="panel-view__row-title">{task.prompt}</span>
                <span className="panel-view__row-meta">{task.cadence}</span>
              </div>
              <button
                type="button"
                className="panel-view__btn panel-view__btn--ghost"
                onClick={() => onRun(task.prompt)}
              >
                Run now
              </button>
              <button
                type="button"
                className="panel-view__btn panel-view__btn--ghost"
                onClick={() => remove(task.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
