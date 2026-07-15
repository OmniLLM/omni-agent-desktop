import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../lib/runtime";
import type {
  ChatMessage,
  RunMode,
  SessionInfo,
  ToolCallEvent,
} from "../types/app";

export interface UseAgentResult {
  messages: ChatMessage[];
  loading: boolean;
  pendingApproval: ToolCallEvent | null;
  sessions: SessionInfo[];
  currentSessionId: string | null;
  send: (text: string, mode?: RunMode) => Promise<void>;
  decide: (decision: "approve" | "deny" | "allow_session") => Promise<void>;
  newSession: () => void;
  switchSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  /** Persistently set a human-chosen title for a session. The manual title
   * survives subsequent auto-persistence (it is not overwritten by the derived
   * first-turn title) and is restored when the session is re-opened. */
  renameSession: (id: string, title: string) => Promise<void>;
  /** Cancel the in-flight run for the active session. Invokes `agent_cancel`
   * for the run's session and returns the UI to an idle state. No-op when no
   * run is active. */
  stop: () => Promise<void>;
  /** Durably compact the active session's transcript: collapse older turns into
   * a single provider-neutral summary while preserving the most recent turns.
   * Invokes `agent_compact` to persist the compaction; on failure the full
   * transcript is left intact (no silent truncation) and the error is surfaced. */
  compact: () => Promise<void>;
  /** Append a local, non-conversational system notice to the transcript. Used
   * for slash-command acknowledgments; excluded from provider history. */
  notify: (content: string) => void;
}

interface ToolResultEvent {
  call_id: string;
  tool: string;
  result: string;
}

/** One-line, human-readable summary of a tool call's arguments. */
function summarizeArgs(args: Record<string, unknown>): string {
  const primary =
    (args.command as string) ??
    (args.path as string) ??
    (args.pattern as string) ??
    (args.task as string) ??
    "";
  return typeof primary === "string" ? primary : JSON.stringify(args);
}

/** Trim long tool output for the inline trace; full output still feeds the model. */
function clampResult(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Derive a sidebar title from the first user turn so saved sessions show a
 * meaningful label instead of a blank row. Collapses whitespace and trims to a
 * reasonable length. Falls back to "New task" when no user text exists yet. */
function deriveSessionTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "New task";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** Normalize a `load_session` result into the message array. The sidecar's
 * `sessions.load` returns the full record `{ id, title, messages, ... }`, but
 * older shells / the runtime mock may return a bare `ChatMessage[]`. Accept
 * both so clicking a history session always restores its full transcript. */
function extractSessionMessages(raw: unknown): ChatMessage[] {
  if (Array.isArray(raw)) return raw as ChatMessage[];
  const messages = (raw as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? (messages as ChatMessage[]) : [];
}

/** Read the persisted title from a `load_session` record, if any. Bare-array
 * results (legacy/mock) carry no title, so return undefined for those. */
function extractSessionTitle(raw: unknown): string | undefined {
  if (Array.isArray(raw) || !raw || typeof raw !== "object") return undefined;
  const title = (raw as { title?: unknown }).title;
  return typeof title === "string" && title.trim() ? title : undefined;
}

/** Only user/assistant turns form the conversation context sent to the model. */
function conversationHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
}

/** Stable marker identifying the durable summary turn produced by `compact`.
 * Prefixing (rather than adding a new field) keeps the compacted turn a plain
 * `ChatMessage`, so it round-trips through persistence and provider history
 * unchanged and is recognizable on reload. */
export const COMPACT_SUMMARY_MARKER = "⟦compacted summary⟧";

/** Number of most-recent user/assistant turns kept verbatim by `compact`. */
export const COMPACT_KEEP_RECENT = 6;

/** Inputs for provider-backed compaction. Older turns are summarized by the
 * active provider; recent turns remain verbatim. */
interface CompactionPlan {
  older: ChatMessage[];
  recent: ChatMessage[];
}

function planCompaction(
  messages: ChatMessage[],
  keepRecent: number = COMPACT_KEEP_RECENT,
): CompactionPlan | null {
  const conversation = conversationHistory(messages);
  if (conversation.length <= keepRecent + 1) return null;
  return {
    older: conversation.slice(0, conversation.length - keepRecent),
    recent: conversation.slice(conversation.length - keepRecent),
  };
}

function compactedTranscript(
  summary: string,
  recent: ChatMessage[],
): ChatMessage[] {
  const content = summary.startsWith(COMPACT_SUMMARY_MARKER)
    ? summary
    : `${COMPACT_SUMMARY_MARKER}\n${summary.trim()}`;
  return [{ role: "assistant", content }, ...recent];
}

export function useAgent(): UseAgentResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ToolCallEvent | null>(
    null,
  );
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Seed a session id synchronously so the very first `send` can tag its run
  // (the mount effect below may still adopt a stored session before any input).
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    () => newSessionId(),
  );
  const cleanupRef = useRef<Array<() => void>>([]);
  const loadedRef = useRef(false);
  // Set when messages are populated by loading an existing session (mount or
  // switch) rather than by a live send. Suppresses the very next persist so
  // that merely opening a session never rewrites its file (which would reorder
  // the sidebar list, e.g. by backfilling created_at on legacy sessions).
  const skipNextPersistRef = useRef(false);
  // The session that owns the in-flight run. Agent stream events carry the
  // session they originated from; the listeners drop any event whose session
  // does not match this, so switching chats mid-run never interleaves a run's
  // thoughts/tool traces/answer into an unrelated session. Scheduled/background
  // runs (which carry a different or absent session) are ignored here too.
  const activeRunSessionRef = useRef<string | null>(null);
  // Snapshot of messages sent with the in-flight run, so history for the model
  // reflects the conversation up to (and including) the current question.
  const historyRef = useRef<ChatMessage[]>([]);
  // Manual, human-chosen titles per session id. When present, auto-persistence
  // uses this instead of the derived first-turn title so a rename is never
  // silently overwritten. Seeded from `list_sessions` so a manual title set in
  // a prior run is honored again after reload, and updated on load/rename.
  const manualTitlesRef = useRef<Map<string, string>>(new Map());

  const refreshSessions = useCallback(async () => {
    try {
      const list = await invoke<SessionInfo[]>("list_sessions");
      if (Array.isArray(list)) setSessions(list);
    } catch {
      // non-fatal
    }
  }, []);

  // Track whether a session's persisted title is a human override. A stored
  // title that differs from what the transcript would derive is treated as
  // manual, so it is preserved across auto-persists and restored on reload.
  const recordManualTitle = useCallback(
    (id: string, storedTitle: string | undefined, msgs: ChatMessage[]) => {
      if (storedTitle && storedTitle !== deriveSessionTitle(msgs)) {
        manualTitlesRef.current.set(id, storedTitle);
      } else {
        manualTitlesRef.current.delete(id);
      }
    },
    [],
  );

  const persistSession = useCallback(
    async (id: string, transcript: ChatMessage[]) => {
      await invoke("save_session", {
        id,
        messages: transcript,
        title:
          manualTitlesRef.current.get(id) ?? deriveSessionTitle(transcript),
      });
      await refreshSessions();
    },
    [refreshSessions],
  );

  // On mount, adopt the most recent session (or start a fresh one).
  useEffect(() => {
    (async () => {
      const list = await invoke<SessionInfo[]>("list_sessions").catch(
        () => [] as SessionInfo[],
      );
      setSessions(Array.isArray(list) ? list : []);
      if (Array.isArray(list) && list.length > 0) {
        const id = list[0].id;
        const raw = await invoke<unknown>("load_session", { id }).catch(
          () => null,
        );
        const saved = extractSessionMessages(raw);
        setCurrentSessionId(id);
        recordManualTitle(id, extractSessionTitle(raw), saved);
        if (saved.length) {
          skipNextPersistRef.current = true;
          setMessages(saved);
        }
      } else {
        setCurrentSessionId(newSessionId());
      }
      loadedRef.current = true;
    })();
  }, []);

  // Persist the active session whenever its messages change.
  useEffect(() => {
    if (!loadedRef.current || !currentSessionId) return;
    if (messages.length === 0) return; // don't write empty sessions
    if (skipNextPersistRef.current) {
      // Messages were populated by opening an existing session, not by a live
      // send. Don't re-persist: rewriting the file would reorder the sidebar.
      skipNextPersistRef.current = false;
      return;
    }
    void persistSession(currentSessionId, messages).catch(() => {});
  }, [messages, currentSessionId, persistSession]);

  useEffect(() => {
    let active = true;
    // An event belongs to the session shown now iff its `session` tag matches
    // the run we started for this session. Untagged events (older backends)
    // are accepted only when we actually have an in-flight run, preserving
    // backward compatibility without leaking scheduled-run noise.
    const isForActiveSession = (payload: unknown): boolean => {
      const owner = activeRunSessionRef.current;
      if (!owner) return false;
      const evSession =
        payload && typeof payload === "object" && "session" in (payload as Record<string, unknown>)
          ? (payload as { session?: unknown }).session
          : undefined;
      if (evSession === undefined || evSession === null) return true;
      return evSession === owner;
    };
    (async () => {
      const un: Array<() => void> = [];
      un.push(
        await listen<unknown>("agent://done", (e) => {
          if (!isForActiveSession(e.payload)) return;
          // Sidecar emits `{ text: string }`; tolerate a bare string too.
          const p = e.payload;
          const text =
            typeof p === "string"
              ? p
              : p && typeof p === "object" && "text" in (p as Record<string, unknown>)
                ? String((p as { text: unknown }).text)
                : (() => {
                    try {
                      return JSON.stringify(p);
                    } catch {
                      return String(p);
                    }
                  })();
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: text },
          ]);
          setLoading(false);
          setPendingApproval(null);
          activeRunSessionRef.current = null;
        }),
      );
      un.push(
        await listen<unknown>("agent://cancelled", (e) => {
          if (!isForActiveSession(e.payload)) return;
          setLoading(false);
          setPendingApproval(null);
          activeRunSessionRef.current = null;
        }),
      );
      un.push(
        await listen<unknown>("agent://error", (e) => {
          if (!isForActiveSession(e.payload)) return;
          // Sidecar emits `{ message: string }`; older backends emitted a
          // bare string. Handle both plus any object that stringifies to
          // "[object Object]" (unwrap `.message` / `.error` / JSON.stringify).
          const p = e.payload;
          const msg =
            typeof p === "string"
              ? p
              : p && typeof p === "object" && "message" in (p as Record<string, unknown>)
                ? String((p as { message: unknown }).message)
                : p && typeof p === "object" && "error" in (p as Record<string, unknown>)
                  ? String((p as { error: unknown }).error)
                  : (() => {
                      try {
                        return JSON.stringify(p);
                      } catch {
                        return String(p);
                      }
                    })();
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Error: ${msg}` },
          ]);
          setLoading(false);
          setPendingApproval(null);
          activeRunSessionRef.current = null;
        }),
      );
      // The model's reasoning that precedes its tool calls.
      un.push(
        await listen<unknown>("agent://thought", (e) => {
          if (!isForActiveSession(e.payload)) return;
          // Sidecar emits `{ text: string }`; tolerate a bare string.
          const p = e.payload;
          const text =
            typeof p === "string"
              ? p
              : p && typeof p === "object" && "text" in (p as Record<string, unknown>)
                ? String((p as { text: unknown }).text)
                : "";
          if (!text.trim()) return;
          setMessages((prev) => [
            ...prev,
            { role: "thinking", kind: "thought", content: text },
          ]);
        }),
      );
      // A tool is about to run (or is awaiting approval).
      un.push(
        await listen<ToolCallEvent>("agent://tool-call", (e) => {
          if (!isForActiveSession(e.payload)) return;
          const summary = summarizeArgs(e.payload.args);
          setMessages((prev) => [
            ...prev,
            {
              role: "thinking",
              kind: "action",
              content: summary
                ? `${e.payload.tool} — ${summary}`
                : e.payload.tool,
            },
          ]);
        }),
      );
      // A tool finished; show a clamped preview of its output.
      un.push(
        await listen<ToolResultEvent>("agent://tool-result", (e) => {
          if (!isForActiveSession(e.payload)) return;
          setMessages((prev) => [
            ...prev,
            {
              role: "thinking",
              kind: "result",
              content: clampResult(e.payload.result),
            },
          ]);
        }),
      );
      un.push(
        await listen<ToolCallEvent>("agent://tool-approval-request", (e) => {
          if (!isForActiveSession(e.payload)) return;
          setPendingApproval(e.payload);
        }),
      );
      if (active) cleanupRef.current = un;
      else un.forEach((f) => f());
    })();
    return () => {
      active = false;
      cleanupRef.current.forEach((f) => f());
    };
  }, []);

  const send = useCallback(
    async (text: string, mode: RunMode = "ask") => {
      if (!text.trim() || activeRunSessionRef.current) return;
      // History is the prior conversation, before this new question.
      const history = conversationHistory(messages);
      historyRef.current = history;
      const runSession = currentSessionId;
      activeRunSessionRef.current = runSession;
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setLoading(true);
      try {
        // Mode is caller-controlled: "ask" prompts for mutating tools,
        // "autopilot" (Approve-for-me) auto-approves. The native side
        // assembles the context window and injects memory. `session` tags the
        // run so its stream events are routed back only to this session.
        await invoke("agent_run", { message: text, mode, history, session: runSession });
      } catch (e) {
        // Only surface the failure if the user is still on the run's session.
        if (activeRunSessionRef.current === runSession) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `Error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ]);
          setLoading(false);
          activeRunSessionRef.current = null;
        }
      }
    },
    [messages, currentSessionId],
  );

  const decide = useCallback(
    async (decision: "approve" | "deny" | "allow_session") => {
      const call = pendingApproval;
      setPendingApproval(null);
      if (call) await invoke("approve_tool", { call_id: call.call_id, decision });
    },
    [pendingApproval],
  );

  const newSession = useCallback(() => {
    // Detach from any in-flight run: its later events must not land here.
    activeRunSessionRef.current = null;
    setCurrentSessionId(newSessionId());
    setMessages([]);
    setPendingApproval(null);
    setLoading(false);
  }, []);

  /** Append a local, non-conversational notice (e.g. a slash-command
   * acknowledgment). System turns render inline but are filtered out of provider
   * history by `conversationHistory`, so they never round-trip to the model. */
  const notify = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: "system", content }]);
  }, []);

  const switchSession = useCallback(async (id: string) => {
    // Detach from any in-flight run before showing another session's transcript.
    activeRunSessionRef.current = null;
    const raw = await invoke<unknown>("load_session", { id }).catch(
      () => null,
    );
    setCurrentSessionId(id);
    const loaded = extractSessionMessages(raw);
    recordManualTitle(id, extractSessionTitle(raw), loaded);
    // Opening a session must not re-persist it (which would reorder the list).
    if (loaded.length) skipNextPersistRef.current = true;
    setMessages(loaded);
    setPendingApproval(null);
    setLoading(false);
  }, [recordManualTitle]);

  const deleteSession = useCallback(
    async (id: string) => {
      await invoke("delete_session", { id }).catch(() => {});
      await refreshSessions();
      if (id === currentSessionId) {
        activeRunSessionRef.current = null;
        setCurrentSessionId(newSessionId());
        setMessages([]);
        setPendingApproval(null);
        setLoading(false);
      }
    },
    [currentSessionId, refreshSessions],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      // Load the authoritative persisted transcript so renaming never truncates
      // a session the user isn't currently viewing. For the active session the
      // in-memory transcript is authoritative and may be newer than disk.
      let msgs: ChatMessage[];
      if (id === currentSessionId) {
        msgs = messages;
      } else {
        const raw = await invoke<unknown>("load_session", { id }).catch(
          () => null,
        );
        msgs = extractSessionMessages(raw);
      }
      // Remember the manual title first so the save (and any concurrent
      // auto-persist) uses it, and it survives future derived-title writes.
      manualTitlesRef.current.set(id, trimmed);
      await invoke("save_session", { id, messages: msgs, title: trimmed });
      await refreshSessions();
    },
    [currentSessionId, messages, refreshSessions],
  );

  const stop = useCallback(async () => {
    const runSession = activeRunSessionRef.current;
    if (!runSession) return;
    // Detach immediately so any late stream events for this run are dropped.
    activeRunSessionRef.current = null;
    setPendingApproval(null);
    setLoading(false);
    try {
      await invoke("agent_cancel", { session: runSession });
    } catch {
      // Cancellation is best-effort from the UI's perspective; the run is
      // already detached locally. Swallow to avoid a spurious error turn.
    }
  }, []);

  const compact = useCallback(async () => {
    const id = currentSessionId;
    if (!id) return;
    const plan = planCompaction(messages);
    if (!plan) return;
    try {
      const response = await invoke<{ summary?: string }>("agent_compact", {
        history: plan.older,
      });
      const summary = response?.summary?.trim();
      if (!summary) throw new Error("the provider returned an empty summary");
      const compacted = compactedTranscript(summary, plan.recent);
      skipNextPersistRef.current = true;
      setMessages(compacted);
      await persistSession(id, compacted);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: failed to compact conversation — ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      ]);
    }
  }, [currentSessionId, messages, persistSession]);

  return {
    messages,
    loading,
    pendingApproval,
    sessions,
    currentSessionId,
    send,
    decide,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
    stop,
    compact,
    notify,
  };
}
