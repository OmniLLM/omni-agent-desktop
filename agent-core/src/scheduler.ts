/**
 * Minimal scheduler port (essential shape only). Persists tasks under
 * <config>/scheduled.json and fires them at their next due time by invoking
 * a supplied `runFire` callback. Emits `scheduler://status` events.
 *
 * Cadence encoding matches the frontend contract:
 *   - kind: "one-shot" + fire_at (unix seconds)
 *   - kind: "recurring" + interval_secs (>= 60)
 *
 * The full-fidelity Rust scheduler had additional catch-up + run-guard logic;
 * this port is faithful to the observable behavior. If richer semantics are
 * needed, the Rust module can stay wired in phase 6.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";
import { atomicWrite } from "./settings.js";

export type ScheduledCadence =
  | { kind: "one-shot"; fire_at: number }
  | { kind: "recurring"; interval_secs: number };

export interface ScheduledTask {
  id: string;
  name: string;
  cadence: ScheduledCadence;
  prompt: string;
  next_fire_at: number;
  last_fired_at?: number;
  last_status?: "ok" | "error" | "running";
  last_error?: string;
}

function tasksPath(): string {
  return join(configDir(), "scheduled.json");
}

export function listTasks(): ScheduledTask[] {
  const p = tasksPath();
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ScheduledTask[];
  } catch {
    return [];
  }
}

function saveTasks(tasks: ScheduledTask[]): void {
  atomicWrite(tasksPath(), JSON.stringify(tasks, null, 2));
}

export function createTask(t: Omit<ScheduledTask, "next_fire_at">): ScheduledTask {
  const next = computeNextFire(t.cadence, Math.floor(Date.now() / 1000));
  const full: ScheduledTask = { ...t, next_fire_at: next };
  const tasks = listTasks();
  tasks.push(full);
  saveTasks(tasks);
  return full;
}

export function updateTask(id: string, patch: Partial<ScheduledTask>): ScheduledTask | null {
  const tasks = listTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const before = tasks[idx];
  if (!before) return null;
  const merged: ScheduledTask = { ...before, ...patch };
  if (patch.cadence) {
    merged.next_fire_at = computeNextFire(patch.cadence, Math.floor(Date.now() / 1000));
  }
  tasks[idx] = merged;
  saveTasks(tasks);
  return merged;
}

export function deleteTask(id: string): boolean {
  const tasks = listTasks();
  const filtered = tasks.filter((t) => t.id !== id);
  if (filtered.length === tasks.length) return false;
  saveTasks(filtered);
  return true;
}

function computeNextFire(c: ScheduledCadence, now: number): number {
  if (c.kind === "one-shot") return c.fire_at;
  return now + Math.max(60, c.interval_secs);
}

export type FireFn = (task: ScheduledTask) => Promise<void>;

/** Long-running driver. Ticks every 15s; fires anything due. */
export class SchedulerDriver {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fire: FireFn,
    private readonly emit: (event: string, data: unknown) => void,
    private readonly tickMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // Immediate tick for catch-up.
    void this.tick();
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runNow(id: string): Promise<void> {
    const task = listTasks().find((t) => t.id === id);
    if (!task) throw new Error(`no such scheduled task: ${id}`);
    await this.fireAndPersist(task);
  }

  private async tick(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const task of listTasks()) {
      if (task.next_fire_at <= now) {
        await this.fireAndPersist(task);
      }
    }
  }

  private async fireAndPersist(task: ScheduledTask): Promise<void> {
    this.emit("scheduler://status", { id: task.id, status: "running" });
    updateTask(task.id, { last_status: "running" });
    try {
      await this.fire(task);
      const now = Math.floor(Date.now() / 1000);
      const patch: Partial<ScheduledTask> =
        task.cadence.kind === "recurring"
          ? {
              last_fired_at: now,
              last_status: "ok",
              next_fire_at: computeNextFire(task.cadence, now),
            }
          : { last_fired_at: now, last_status: "ok", next_fire_at: now + 315_360_000 };
      updateTask(task.id, patch);
      this.emit("scheduler://status", { id: task.id, status: "ok" });
    } catch (e) {
      const err = (e as Error).message;
      updateTask(task.id, { last_status: "error", last_error: err });
      this.emit("scheduler://status", { id: task.id, status: "error", error: err });
    }
  }
}
