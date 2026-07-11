//! Typed persistent scheduler: cadence math, catch-up semantics, per-task run
//! guard, timer invalidation, atomic typed persistence, and status events.
//!
//! The core [`Scheduler`] is deterministic and injectable: it takes a [`Clock`],
//! a [`TaskRunner`], a [`TaskStore`], and a [`StatusSink`], and exposes plain
//! async methods (`catch_up`, `execute`, `run_now`, `create`/`update`/`delete`)
//! that tests drive directly with a fake clock and runner — no wall-clock sleeps.
//! The wall-clock driver ([`Scheduler::start`]) is a thin wrapper that only
//! schedules calls into those same methods and can be cancelled on shutdown.

use crate::agent::BoxFut;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Typed model
// ---------------------------------------------------------------------------

/// How often a scheduled task recurs. Serializes as `"Hourly"`/`"Daily"`/
/// `"Weekly"`, matching the strings the existing UI and legacy JSON already use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Cadence {
    Hourly,
    Daily,
    Weekly,
}

impl Default for Cadence {
    fn default() -> Self {
        Cadence::Daily
    }
}

impl Cadence {
    /// The recurrence interval in seconds.
    pub fn interval_secs(self) -> u64 {
        match self {
            Cadence::Hourly => 3_600,
            Cadence::Daily => 86_400,
            Cadence::Weekly => 604_800,
        }
    }
}

/// The outcome of the most recent run for a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunStatus {
    Idle,
    Running,
    Succeeded,
    Failed,
}

impl Default for RunStatus {
    fn default() -> Self {
        RunStatus::Idle
    }
}

fn default_true() -> bool {
    true
}

/// A persisted scheduled task. All timestamps are Unix seconds. Field names are
/// snake_case so the serialized JSON is directly consumable by the TypeScript
/// contract without renaming. New fields carry serde defaults so an older
/// `{id,prompt,cadence}` document migrates cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub cadence: Cadence,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub next_run_at: u64,
    #[serde(default)]
    pub last_run_at: Option<u64>,
    #[serde(default)]
    pub last_status: RunStatus,
    #[serde(default)]
    pub last_error: Option<String>,
}

impl ScheduledTask {
    /// Fill in derived timestamps that a freshly-migrated (or zero-initialized)
    /// task is missing, using `now` as the base. Idempotent for a normalized
    /// task.
    fn normalize(&mut self, now: u64) {
        if self.created_at == 0 {
            self.created_at = now;
        }
        if self.updated_at == 0 {
            self.updated_at = self.created_at;
        }
        if self.next_run_at == 0 {
            self.next_run_at = self.created_at + self.cadence.interval_secs();
        }
    }
}

/// The maximum length of a stored `last_error` summary, in characters.
pub const MAX_ERROR_LEN: usize = 200;

/// Reduce a runner error into a bounded, credential-free summary safe to persist
/// and surface to the UI. Keeps only the first line, redacts long token-like
/// runs and anything following a `Bearer`/`key`/`token`/`authorization` marker,
/// and caps the length.
pub fn sanitize_error(raw: &str) -> String {
    // First line only — provider error bodies are often multi-line JSON dumps.
    let first = raw.lines().next().unwrap_or("").trim();

    // Redact credential-bearing markers: drop everything after a marker word so a
    // leaked `Bearer sk-...` or `api-key: ...` never reaches storage.
    let lower = first.to_ascii_lowercase();
    let mut cut = first.len();
    for marker in ["bearer ", "authorization", "api-key", "api_key", "token", "key="] {
        if let Some(pos) = lower.find(marker) {
            cut = cut.min(pos);
        }
    }
    let mut out = first[..cut].trim().to_string();

    // Redact any remaining long alphanumeric run (opaque secret material).
    out = redact_long_tokens(&out);

    if out.is_empty() {
        out = "run failed".to_string();
    }
    // Bound length (character-safe).
    if out.chars().count() > MAX_ERROR_LEN {
        out = out.chars().take(MAX_ERROR_LEN).collect();
    }
    out
}

fn redact_long_tokens(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.len() >= 20 && run.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            out.push_str("[redacted]");
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            run.push(ch);
        } else {
            flush(&mut run, &mut out);
            out.push(ch);
        }
    }
    flush(&mut run, &mut out);
    out
}

/// Compute the first run time strictly after `now`, aligned to the cadence grid
/// anchored at `prev`. If `prev` is already in the future it is returned
/// unchanged; otherwise the interval is advanced by whole steps until it passes
/// `now`. Many missed intervals collapse into a single future time.
pub fn next_after(prev: u64, now: u64, interval: u64) -> u64 {
    if interval == 0 {
        return now + 1;
    }
    if prev > now {
        return prev;
    }
    let elapsed = now - prev;
    prev + (elapsed / interval + 1) * interval
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/// A source of wall-clock time (Unix seconds). Injected so tests can drive
/// cadence and catch-up math deterministically.
pub trait Clock: Send + Sync {
    fn now(&self) -> u64;
}

/// Real system clock.
pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// Executes a scheduled task's prompt through the shared headless agent path.
/// Injected so the scheduler core never touches the network in tests.
pub trait TaskRunner: Send + Sync {
    fn run<'a>(&'a self, task: &'a ScheduledTask) -> BoxFut<'a, Result<String, String>>;
}

/// Typed atomic persistence for the task list.
pub trait TaskStore: Send + Sync {
    fn load(&self) -> Vec<ScheduledTask>;
    fn save(&self, tasks: &[ScheduledTask]) -> Result<(), String>;
}

/// A status event emitted when a task starts, succeeds, or fails. Carries only
/// non-secret, bounded fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusEvent {
    pub id: String,
    pub status: RunStatus,
    pub last_run_at: Option<u64>,
    pub next_run_at: u64,
    pub last_error: Option<String>,
}

/// Sink for status events (Tauri emitter in production, recorder in tests).
pub trait StatusSink: Send + Sync {
    fn emit(&self, event: &StatusEvent);
}

/// A no-op status sink.
pub struct NullSink;
impl StatusSink for NullSink {
    fn emit(&self, _event: &StatusEvent) {}
}

/// What initiated a run. Both paths share the same guarded execution; the guard
/// rejects a second run of the same task regardless of trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Auto,
    Manual,
}

// ---------------------------------------------------------------------------
// Deserialization / migration
// ---------------------------------------------------------------------------

/// Parse and normalize a stored task document. Accepts both the typed shape and
/// the legacy `[{id,prompt,cadence}]` array, applying serde defaults and filling
/// derived timestamps from `now`.
pub fn parse_tasks(raw: &str, now: u64) -> Vec<ScheduledTask> {
    let mut tasks: Vec<ScheduledTask> = serde_json::from_str(raw).unwrap_or_default();
    for t in &mut tasks {
        t.normalize(now);
    }
    tasks
}

// ---------------------------------------------------------------------------
// Scheduler core
// ---------------------------------------------------------------------------

struct Inner {
    tasks: Vec<ScheduledTask>,
    running: HashSet<String>,
}

/// The deterministic scheduler core. Holds the task list behind a `Mutex` that
/// is never held across an `.await`, a monotonically increasing generation used
/// to invalidate stale timers, and the injected dependencies.
pub struct Scheduler {
    inner: Mutex<Inner>,
    generation: AtomicU64,
    clock: Arc<dyn Clock>,
    runner: Arc<dyn TaskRunner>,
    store: Arc<dyn TaskStore>,
    sink: Arc<dyn StatusSink>,
    wake: tokio::sync::Notify,
    cancel: tokio::sync::Notify,
    /// Latched cancellation flag. Set once by [`Scheduler::shutdown`] and never
    /// cleared, so a shutdown requested before the driver reaches its wait point
    /// is still observed (a bare `Notify` signal would be lost). The `Notify`
    /// only wakes a driver that is already parked in `select!`.
    cancelled: AtomicBool,
}

impl Scheduler {
    /// Construct a scheduler, loading and normalizing the persisted task list.
    pub fn new(
        store: Arc<dyn TaskStore>,
        clock: Arc<dyn Clock>,
        runner: Arc<dyn TaskRunner>,
        sink: Arc<dyn StatusSink>,
    ) -> Arc<Self> {
        let now = clock.now();
        let mut tasks = store.load();
        for t in &mut tasks {
            t.normalize(now);
            // A task that was mid-run when the process died is not actually
            // running now; reset the transient status.
            if t.last_status == RunStatus::Running {
                t.last_status = RunStatus::Idle;
            }
        }
        Arc::new(Self {
            inner: Mutex::new(Inner {
                tasks,
                running: HashSet::new(),
            }),
            generation: AtomicU64::new(1),
            clock,
            runner,
            store,
            sink,
            wake: tokio::sync::Notify::new(),
            cancel: tokio::sync::Notify::new(),
            cancelled: AtomicBool::new(false),
        })
    }

    /// The current generation token. Timers capture this at schedule time and
    /// abort if it has advanced (any mutation bumps it).
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn bump_generation(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// A snapshot of all tasks.
    pub fn list(&self) -> Vec<ScheduledTask> {
        self.inner.lock().unwrap().tasks.clone()
    }

    /// Whether a run is currently in flight for `id` (per-task guard state).
    /// Exposed for tests and health checks.
    pub fn is_running(&self, id: &str) -> bool {
        self.inner.lock().unwrap().running.contains(id)
    }

    /// Persist the current in-memory task list, reverting to `snapshot` if the
    /// write fails so the last valid state is preserved both in memory and on
    /// disk. This is a synchronous file write called while holding the lock; it
    /// performs no `.await`.
    fn persist_or_revert(
        &self,
        inner: &mut Inner,
        snapshot: Vec<ScheduledTask>,
    ) -> Result<(), String> {
        match self.store.save(&inner.tasks) {
            Ok(()) => Ok(()),
            Err(e) => {
                inner.tasks = snapshot;
                Err(e)
            }
        }
    }

    // --- Mutations -----------------------------------------------------------

    /// Create a new task from a validated prompt/cadence. Persists atomically and
    /// bumps the generation so any pending timer is invalidated.
    pub fn create(
        &self,
        prompt: &str,
        cadence: Cadence,
        enabled: bool,
    ) -> Result<ScheduledTask, String> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err("prompt is required".into());
        }
        let now = self.clock.now();
        let task = ScheduledTask {
            id: new_id(),
            prompt: prompt.to_string(),
            cadence,
            enabled,
            created_at: now,
            updated_at: now,
            next_run_at: now + cadence.interval_secs(),
            last_run_at: None,
            last_status: RunStatus::Idle,
            last_error: None,
        };
        let created = {
            let mut inner = self.inner.lock().unwrap();
            let snapshot = inner.tasks.clone();
            inner.tasks.push(task.clone());
            self.persist_or_revert(&mut inner, snapshot)?;
            task
        };
        self.bump_generation();
        self.wake.notify_one();
        Ok(created)
    }

    /// Update an existing task's prompt, cadence, and enabled flag. Recomputes
    /// the next run when the cadence changes, persists atomically, and bumps the
    /// generation to invalidate the old timer.
    pub fn update(
        &self,
        id: &str,
        prompt: &str,
        cadence: Cadence,
        enabled: bool,
    ) -> Result<ScheduledTask, String> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err("prompt is required".into());
        }
        let now = self.clock.now();
        let updated = {
            let mut inner = self.inner.lock().unwrap();
            let snapshot = inner.tasks.clone();
            let task = inner
                .tasks
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or_else(|| "task not found".to_string())?;
            let cadence_changed = task.cadence != cadence;
            task.prompt = prompt.to_string();
            task.cadence = cadence;
            task.enabled = enabled;
            task.updated_at = now;
            if cadence_changed {
                task.next_run_at = now + cadence.interval_secs();
            }
            let out = task.clone();
            self.persist_or_revert(&mut inner, snapshot)?;
            out
        };
        self.bump_generation();
        self.wake.notify_one();
        Ok(updated)
    }

    /// Delete a task by id. Persists atomically and bumps the generation.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().unwrap();
            let snapshot = inner.tasks.clone();
            let before = inner.tasks.len();
            inner.tasks.retain(|t| t.id != id);
            if inner.tasks.len() == before {
                return Err("task not found".into());
            }
            self.persist_or_revert(&mut inner, snapshot)?;
        }
        self.bump_generation();
        self.wake.notify_one();
        Ok(())
    }

    // --- Execution -----------------------------------------------------------

    /// Ids of enabled tasks whose next run is due at `now`.
    fn due_ids(&self, now: u64) -> Vec<String> {
        self.inner
            .lock()
            .unwrap()
            .tasks
            .iter()
            .filter(|t| t.enabled && t.next_run_at <= now)
            .map(|t| t.id.clone())
            .collect()
    }

    /// Run every currently-due task exactly once. Each execution advances the
    /// task's `next_run_at` past `now`, so a task overdue by many intervals is
    /// still queued a single time. Stops early (before launching the next task)
    /// if cancellation has been latched, so shutdown is responsive between
    /// sequential catch-up runs.
    pub async fn catch_up(&self) {
        let now = self.clock.now();
        for id in self.due_ids(now) {
            if self.is_cancelled() {
                break;
            }
            let _ = self.execute(&id, Trigger::Auto).await;
        }
    }

    /// Manually run a task now (the `run_scheduled_now` command path). Uses the
    /// same guarded execution as automatic runs.
    pub async fn run_now(&self, id: &str) -> Result<ScheduledTask, String> {
        self.execute(id, Trigger::Manual).await
    }

    /// Timer callback: run `id` only if the captured `generation` still matches
    /// the current one. A mutation between scheduling and firing bumps the
    /// generation and makes this a no-op, preventing a stale timer from running.
    /// Returns whether the task was executed.
    pub async fn on_timer(&self, id: &str, generation: u64) -> bool {
        if self.generation() != generation {
            return false;
        }
        // Only run if still enabled and due.
        let now = self.clock.now();
        let eligible = {
            let inner = self.inner.lock().unwrap();
            inner
                .tasks
                .iter()
                .any(|t| t.id == id && t.enabled && t.next_run_at <= now)
        };
        if !eligible {
            return false;
        }
        self.execute(id, Trigger::Auto).await.is_ok()
    }

    /// Guarded execution of a single task. The per-task guard rejects a second
    /// run (automatic or manual) while one is in flight. The provider/tool work
    /// runs through the injected [`TaskRunner`] without holding the lock.
    pub async fn execute(&self, id: &str, trigger: Trigger) -> Result<ScheduledTask, String> {
        // Phase 1: claim the run under the lock, emit Running. Capture the
        // last-valid (pre-Running) task snapshot so a later persist failure can
        // revert to a coherent terminal state rather than the transient Running.
        let (task, pre_run_snapshot) = {
            let mut inner = self.inner.lock().unwrap();
            let task = inner
                .tasks
                .iter()
                .find(|t| t.id == id)
                .cloned()
                .ok_or_else(|| "task not found".to_string())?;
            // Automatic runs never fire for a disabled task; manual runs may.
            if trigger == Trigger::Auto && !task.enabled {
                return Err("task is disabled".into());
            }
            if inner.running.contains(id) {
                return Err("task already running".into());
            }
            // Snapshot BEFORE mutating status to Running: this is the last valid
            // persisted state to restore if the completion write fails.
            let pre_run_snapshot = inner.tasks.clone();
            inner.running.insert(id.to_string());
            if let Some(t) = inner.tasks.iter_mut().find(|t| t.id == id) {
                t.last_status = RunStatus::Running;
            }
            (task, pre_run_snapshot)
        };
        self.emit_for(id);

        // Phase 2: run without holding the lock.
        let result = self.runner.run(&task).await;

        // Phase 3: record the outcome, advance the schedule, persist.
        let recorded = {
            let mut inner = self.inner.lock().unwrap();
            inner.running.remove(id);
            let now = self.clock.now();
            let interval = task.cadence.interval_secs();
            let out = if let Some(t) = inner.tasks.iter_mut().find(|t| t.id == id) {
                match &result {
                    Ok(_) => {
                        t.last_status = RunStatus::Succeeded;
                        t.last_error = None;
                    }
                    Err(e) => {
                        t.last_status = RunStatus::Failed;
                        t.last_error = Some(sanitize_error(e));
                    }
                }
                t.last_run_at = Some(now);
                t.next_run_at = next_after(t.next_run_at, now, interval);
                t.updated_at = now;
                Some(t.clone())
            } else {
                // Task was deleted mid-run; nothing to record.
                None
            };
            if out.is_some() {
                // A persistence failure must not leave the task stuck in the
                // transient `Running` status. Revert to the pre-run snapshot,
                // which carries the previous terminal state — never Running —
                // keeping in-memory and on-disk state coherent.
                self.persist_or_revert(&mut inner, pre_run_snapshot)?;
            }
            out
        };

        match recorded {
            Some(t) => {
                self.emit_for(id);
                Ok(t)
            }
            None => Err("task was removed during execution".into()),
        }
    }

    fn emit_for(&self, id: &str) {
        let event = {
            let inner = self.inner.lock().unwrap();
            inner.tasks.iter().find(|t| t.id == id).map(|t| StatusEvent {
                id: t.id.clone(),
                status: t.last_status,
                last_run_at: t.last_run_at,
                next_run_at: t.next_run_at,
                last_error: t.last_error.clone(),
            })
        };
        if let Some(ev) = event {
            self.sink.emit(&ev);
        }
    }

    // --- Wall-clock driver ---------------------------------------------------

    /// The driver loop: one startup catch-up, then sleep until the soonest due
    /// task (waking early on any mutation) and run due tasks. Returns when
    /// cancellation is latched. Cancellation is checked before and after the
    /// catch-up and again each loop iteration, so a shutdown requested before the
    /// driver parks in `select!` is still observed and cannot be lost.
    ///
    /// This is a plain async method that takes `Arc<Self>` and performs NO task
    /// spawning, so it is runtime-agnostic: the caller decides how to spawn it
    /// (production spawns it via `tauri::async_runtime::spawn` from setup; tests
    /// await it directly). Keeping the spawn out of this module avoids the panic
    /// that a bare `tokio::spawn` raises when called outside an entered Tokio
    /// runtime (as Tauri's synchronous `setup` is).
    pub async fn drive(self: Arc<Self>) {
        if self.is_cancelled() {
            return;
        }
        self.catch_up().await;
        if self.is_cancelled() {
            return;
        }
        loop {
            if self.is_cancelled() {
                break;
            }
            let now = self.clock.now();
            let next = {
                let inner = self.inner.lock().unwrap();
                inner
                    .tasks
                    .iter()
                    .filter(|t| t.enabled)
                    .map(|t| t.next_run_at)
                    .min()
            };
            let sleep_secs = match next {
                Some(n) if n > now => (n - now).min(3_600),
                Some(_) => 0,
                None => 3_600,
            };
            tokio::select! {
                _ = self.cancel.notified() => break,
                _ = self.wake.notified() => continue,
                _ = tokio::time::sleep(std::time::Duration::from_secs(sleep_secs)) => {
                    if self.is_cancelled() {
                        break;
                    }
                    self.catch_up().await;
                }
            }
        }
    }

    /// Whether cancellation has been latched.
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Signal the background driver to stop. Latches the cancellation flag first
    /// (so a driver that has not yet parked still observes it), then wakes any
    /// driver currently parked in `select!`.
    pub fn shutdown(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.cancel.notify_waiters();
    }
}

/// Generate a task id (hex, OS randomness via `getrandom`).
fn new_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Fallback: time-derived id (never expected in practice).
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        return format!("t-{nanos}");
    }
    let mut s = String::with_capacity(32);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

// ---------------------------------------------------------------------------
// File-backed store
// ---------------------------------------------------------------------------

/// A [`TaskStore`] that persists the typed task list to a JSON file via the
/// crate's atomic write helper.
pub struct FileTaskStore {
    path: std::path::PathBuf,
}

impl FileTaskStore {
    pub fn new(path: std::path::PathBuf) -> Self {
        Self { path }
    }
}

impl TaskStore for FileTaskStore {
    fn load(&self) -> Vec<ScheduledTask> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        std::fs::read_to_string(&self.path)
            .ok()
            .map(|raw| parse_tasks(&raw, now))
            .unwrap_or_default()
    }

    fn save(&self, tasks: &[ScheduledTask]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(tasks).map_err(|e| e.to_string())?;
        crate::settings::atomic_write(&self.path, &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    // --- Test doubles --------------------------------------------------------

    struct FixedClock(AtomicU64);
    impl FixedClock {
        fn new(t: u64) -> Arc<Self> {
            Arc::new(Self(AtomicU64::new(t)))
        }
        fn set(&self, t: u64) {
            self.0.store(t, Ordering::SeqCst);
        }
    }
    impl Clock for FixedClock {
        fn now(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    #[derive(Default)]
    struct CountingRunner {
        calls: Mutex<Vec<String>>,
        fail: AtomicBool,
    }
    impl TaskRunner for CountingRunner {
        fn run<'a>(&'a self, task: &'a ScheduledTask) -> BoxFut<'a, Result<String, String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(task.id.clone());
                if self.fail.load(Ordering::SeqCst) {
                    Err("boom".to_string())
                } else {
                    Ok("ok".to_string())
                }
            })
        }
    }

    #[derive(Default)]
    struct MemStore {
        tasks: Mutex<Vec<ScheduledTask>>,
        fail: AtomicBool,
        saves: AtomicU64,
    }
    impl TaskStore for MemStore {
        fn load(&self) -> Vec<ScheduledTask> {
            self.tasks.lock().unwrap().clone()
        }
        fn save(&self, tasks: &[ScheduledTask]) -> Result<(), String> {
            self.saves.fetch_add(1, Ordering::SeqCst);
            if self.fail.load(Ordering::SeqCst) {
                return Err("disk full".into());
            }
            *self.tasks.lock().unwrap() = tasks.to_vec();
            Ok(())
        }
    }

    #[derive(Default)]
    struct RecSink(Mutex<Vec<StatusEvent>>);
    impl StatusSink for RecSink {
        fn emit(&self, event: &StatusEvent) {
            self.0.lock().unwrap().push(event.clone());
        }
    }

    fn build(
        clock: Arc<FixedClock>,
        runner: Arc<CountingRunner>,
        store: Arc<MemStore>,
        sink: Arc<RecSink>,
    ) -> Arc<Scheduler> {
        Scheduler::new(store, clock, runner, sink)
    }

    // --- Serialization / migration ------------------------------------------

    #[test]
    fn scheduled_task_roundtrips_with_snake_case_and_string_enums() {
        let task = ScheduledTask {
            id: "a".into(),
            prompt: "hi".into(),
            cadence: Cadence::Weekly,
            enabled: true,
            created_at: 100,
            updated_at: 200,
            next_run_at: 300,
            last_run_at: Some(150),
            last_status: RunStatus::Succeeded,
            last_error: None,
        };
        let json = serde_json::to_value(&task).unwrap();
        assert_eq!(json["cadence"], "Weekly");
        assert_eq!(json["last_status"], "Succeeded");
        assert!(json.get("next_run_at").is_some());
        let back: ScheduledTask = serde_json::from_value(json).unwrap();
        assert_eq!(back, task);
    }

    #[test]
    fn migrates_legacy_shape_with_defaults() {
        let raw = r#"[{"id":"x","prompt":"do it","cadence":"Daily"}]"#;
        let now = 1_000_000;
        let tasks = parse_tasks(raw, now);
        assert_eq!(tasks.len(), 1);
        let t = &tasks[0];
        assert_eq!(t.id, "x");
        assert!(t.enabled, "legacy tasks default to enabled");
        assert_eq!(t.created_at, now);
        assert_eq!(t.updated_at, now);
        assert_eq!(t.next_run_at, now + 86_400);
        assert_eq!(t.last_run_at, None);
        assert_eq!(t.last_status, RunStatus::Idle);
        assert_eq!(t.last_error, None);
    }

    // --- Cadence math --------------------------------------------------------

    #[test]
    fn cadence_intervals_are_exact() {
        assert_eq!(Cadence::Hourly.interval_secs(), 3_600);
        assert_eq!(Cadence::Daily.interval_secs(), 86_400);
        assert_eq!(Cadence::Weekly.interval_secs(), 604_800);
    }

    #[test]
    fn next_after_computes_exact_next_and_collapses_missed() {
        // Exactly one interval ahead when now == prev.
        assert_eq!(next_after(1_000, 1_000, 3_600), 4_600);
        // Future prev is returned unchanged.
        assert_eq!(next_after(5_000, 1_000, 3_600), 5_000);
        // Many missed intervals collapse to the first future grid point.
        assert_eq!(
            next_after(1_000, 1_000 + 3_600 * 10 + 5, 3_600),
            1_000 + 3_600 * 11
        );
    }

    // --- Catch-up semantics --------------------------------------------------

    #[tokio::test]
    async fn overdue_startup_queues_once_even_with_many_missed_intervals() {
        let clock = FixedClock::new(1_000);
        let runner = Arc::new(CountingRunner::default());
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let sched = build(clock.clone(), runner.clone(), store.clone(), sink.clone());
        let task = sched.create("p", Cadence::Hourly, true).unwrap();
        // Jump far into the future: 100 intervals missed.
        clock.set(1_000 + 3_600 * 100 + 7);
        sched.catch_up().await;
        // Exactly one run despite 100 missed intervals.
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
        let after = sched.list().into_iter().find(|t| t.id == task.id).unwrap();
        assert!(
            after.next_run_at > clock.now(),
            "next run must be in the future"
        );
        // A second catch-up at the same time does not re-run.
        sched.catch_up().await;
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn disabled_task_never_runs_automatically() {
        let clock = FixedClock::new(1_000);
        let runner = Arc::new(CountingRunner::default());
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let sched = build(clock.clone(), runner.clone(), store.clone(), sink.clone());
        sched.create("p", Cadence::Hourly, false).unwrap();
        clock.set(1_000_000_000);
        sched.catch_up().await;
        assert_eq!(runner.calls.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn completion_advances_to_first_future_interval() {
        let clock = FixedClock::new(1_000);
        let runner = Arc::new(CountingRunner::default());
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let sched = build(clock.clone(), runner.clone(), store.clone(), sink.clone());
        let task = sched.create("p", Cadence::Hourly, true).unwrap();
        // Due time reached plus a bit.
        clock.set(task.next_run_at + 10);
        let done = sched.run_now(&task.id).await.unwrap();
        assert_eq!(done.last_status, RunStatus::Succeeded);
        assert_eq!(
            done.next_run_at,
            next_after(task.next_run_at, clock.now(), 3_600)
        );
        assert!(done.next_run_at > clock.now());
    }

    #[tokio::test]
    async fn failure_still_schedules_a_future_run_with_bounded_error() {
        let clock = FixedClock::new(1_000);
        let runner = Arc::new(CountingRunner::default());
        runner.fail.store(true, Ordering::SeqCst);
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let sched = build(clock.clone(), runner.clone(), store.clone(), sink.clone());
        let task = sched.create("p", Cadence::Daily, true).unwrap();
        clock.set(task.next_run_at + 5);
        let done = sched.run_now(&task.id).await.unwrap();
        assert_eq!(done.last_status, RunStatus::Failed);
        assert!(done.last_error.is_some());
        assert!(done.last_error.unwrap().len() <= MAX_ERROR_LEN);
        assert!(done.next_run_at > clock.now());
    }

    // --- Mutation / persistence / timers -------------------------------------

    #[tokio::test]
    async fn mutations_persist_atomically_and_invalidate_timers() {
        let clock = FixedClock::new(1_000);
        let runner = Arc::new(CountingRunner::default());
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let sched = build(clock.clone(), runner.clone(), store.clone(), sink.clone());

        let g0 = sched.generation();
        let task = sched.create("p", Cadence::Hourly, true).unwrap();
        assert!(sched.generation() > g0, "create bumps generation");
        assert_eq!(store.load().len(), 1, "create persisted");

        let stale_gen = sched.generation();
        // Update invalidates the timer captured at stale_gen.
        sched.update(&task.id, "p2", Cadence::Daily, true).unwrap();
        assert!(sched.generation() > stale_gen);
        clock.set(1_000_000_000);
        // A timer captured before the update must be a no-op.
        assert!(!sched.on_timer(&task.id, stale_gen).await);
        assert_eq!(runner.calls.lock().unwrap().len(), 0);
        // A timer with the current generation, now due, runs.
        assert!(sched.on_timer(&task.id, sched.generation()).await);
        assert_eq!(runner.calls.lock().unwrap().len(), 1);

        // Delete persists and bumps generation.
        let gd = sched.generation();
        sched.delete(&task.id).unwrap();
        assert!(sched.generation() > gd);
        assert_eq!(store.load().len(), 0);
    }

    #[tokio::test]
    async fn persistence_failure_keeps_last_valid_in_memory_state() {
        let clock = FixedClock::new(1_000);
        let runner = Arc::new(CountingRunner::default());
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let sched = build(clock.clone(), runner.clone(), store.clone(), sink.clone());
        let task = sched.create("p", Cadence::Hourly, true).unwrap();

        store.fail.store(true, Ordering::SeqCst);
        let err = sched.create("second", Cadence::Daily, true).unwrap_err();
        assert_eq!(err, "disk full");
        // In-memory state reverted to the last valid single task.
        let tasks = sched.list();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, task.id);
    }

    #[tokio::test]
    async fn overlapping_runs_of_same_task_are_rejected() {
        // A runner that blocks until released lets us hold one run "in flight"
        // deterministically, with no sleeps.
        struct BlockingRunner {
            started: tokio::sync::Notify,
            release: tokio::sync::Notify,
        }
        impl TaskRunner for BlockingRunner {
            fn run<'a>(&'a self, _t: &'a ScheduledTask) -> BoxFut<'a, Result<String, String>> {
                Box::pin(async move {
                    self.started.notify_one();
                    self.release.notified().await;
                    Ok("ok".into())
                })
            }
        }
        let clock = FixedClock::new(1_000);
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let runner = Arc::new(BlockingRunner {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let sched = Scheduler::new(store, clock.clone(), runner.clone(), sink);
        let task = sched.create("p", Cadence::Hourly, true).unwrap();
        clock.set(task.next_run_at + 1);

        // Start an automatic run in the background; wait until it is in flight.
        let s2 = sched.clone();
        let id = task.id.clone();
        let handle = tokio::spawn(async move { s2.execute(&id, Trigger::Auto).await });
        runner.started.notified().await;

        // A manual run of the same task is rejected while the first is running.
        let rejected = sched.run_now(&task.id).await;
        assert!(rejected.is_err());
        assert_eq!(rejected.unwrap_err(), "task already running");

        runner.release.notify_one();
        let first = handle.await.unwrap();
        assert!(first.is_ok());
    }

    #[tokio::test]
    async fn failed_completion_persist_leaves_terminal_not_running_state() {
        // Regression: when the completion persist fails, the revert must NOT
        // resurrect the transient `Running` status. The task's last valid state
        // is terminal (Failed here, since the run itself failed) and the guard is
        // released — so `list()` must never show `Running`.
        let clock = FixedClock::new(1_000);
        let runner = Arc::new(CountingRunner::default());
        runner.fail.store(true, Ordering::SeqCst);
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let sched = build(clock.clone(), runner.clone(), store.clone(), sink.clone());
        let task = sched.create("p", Cadence::Hourly, true).unwrap();
        clock.set(task.next_run_at + 5);

        // Fail persistence of the completion record.
        store.fail.store(true, Ordering::SeqCst);
        let _ = sched.run_now(&task.id).await;

        let after = sched.list();
        assert_eq!(after.len(), 1);
        assert_ne!(
            after[0].last_status,
            RunStatus::Running,
            "revert must restore a terminal status, never Running"
        );
        // Guard released: no in-flight run remains for this task.
        assert!(
            !sched.is_running(&task.id),
            "guard must be released even when completion persist fails"
        );
    }

    #[tokio::test]
    async fn shutdown_before_driver_waits_causes_exit() {
        // Latched cancellation: a shutdown requested before the driver reaches
        // its wait point must still terminate the driver. No due tasks, no
        // sleeps — the driver must observe the latch and return.
        let clock = FixedClock::new(1_000);
        let runner = Arc::new(CountingRunner::default());
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let sched = build(clock.clone(), runner.clone(), store.clone(), sink.clone());

        // Request shutdown BEFORE the driver runs; a bare notify signal would be
        // lost without a latch.
        sched.shutdown();

        // The driver must complete promptly; the timeout is only a safety net
        // that turns a hang (the bug) into a deterministic failure.
        let driven =
            tokio::time::timeout(std::time::Duration::from_secs(5), sched.clone().drive()).await;
        assert!(
            driven.is_ok(),
            "driver must exit when cancellation is latched"
        );
    }

    #[test]
    fn drive_future_is_send_and_spawnable_outside_ambient_runtime() {
        // Regression for the startup panic: the module must NOT call a bare
        // `tokio::spawn` from a synchronous, non-runtime context (Tauri's
        // `setup`). Instead `drive()` is a runtime-agnostic `Send + 'static`
        // future the caller spawns via `tauri::async_runtime::spawn`.
        //
        // This test runs with NO ambient Tokio runtime (`#[test]`, not
        // `#[tokio::test]`). It builds a runtime explicitly and hands the future
        // to it exactly as an external spawner would — proving `drive()` requires
        // no entered runtime at construction time and would have panicked here if
        // it internally called a bare `tokio::spawn`.
        fn assert_send<F: Send + 'static>(_f: &F) {}

        let clock = FixedClock::new(1_000);
        let runner = Arc::new(CountingRunner::default());
        let store = Arc::new(MemStore::default());
        let sink = Arc::new(RecSink::default());
        let sched = build(clock, runner, store, sink);

        // Construct the driver future in a plain (non-async) context — this line
        // panicked in the old `start()` design.
        sched.shutdown();
        let fut = sched.clone().drive();
        assert_send(&fut);

        // A freshly-built runtime (as an external executor provides) drives it to
        // completion; the latched cancellation makes it return immediately.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), fut)
                .await
                .expect("driver must exit promptly when cancelled");
        });
    }

    #[test]
    fn sanitize_error_bounds_length_and_redacts_credentials() {
        let long = "x".repeat(500);
        assert!(sanitize_error(&long).chars().count() <= MAX_ERROR_LEN);
        // Bearer token material is dropped.
        let e = sanitize_error("provider HTTP 401: Bearer sk-abcdef0123456789abcdef");
        assert!(!e.contains("sk-abcdef"));
        assert!(e.contains("provider HTTP 401"));
        // Long opaque token in the message is redacted.
        let e2 = sanitize_error("failed with id ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 end");
        assert!(e2.contains("[redacted]"));
    }
}
