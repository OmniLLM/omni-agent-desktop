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

/** Only user/assistant turns form the conversation context sent to the model. */
function conversationHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
}

export function useAgent(): UseAgentResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ToolCallEvent | null>(
    null,
  );
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);
  const loadedRef = useRef(false);
  // Snapshot of messages sent with the in-flight run, so history for the model
  // reflects the conversation up to (and including) the current question.
  const historyRef = useRef<ChatMessage[]>([]);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await invoke<SessionInfo[]>("list_sessions");
      if (Array.isArray(list)) setSessions(list);
    } catch {
      // non-fatal
    }
  }, []);

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
        if (saved.length) setMessages(saved);
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
    invoke("save_session", {
      id: currentSessionId,
      messages,
      title: deriveSessionTitle(messages),
    })
      .then(() => refreshSessions())
      .catch(() => {});
  }, [messages, currentSessionId, refreshSessions]);

  useEffect(() => {
    let active = true;
    (async () => {
      const un: Array<() => void> = [];
      un.push(
        await listen<unknown>("agent://done", (e) => {
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
        }),
      );
      un.push(
        await listen<unknown>("agent://error", (e) => {
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
        }),
      );
      // The model's reasoning that precedes its tool calls.
      un.push(
        await listen<unknown>("agent://thought", (e) => {
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
      if (!text.trim()) return;
      // History is the prior conversation, before this new question.
      const history = conversationHistory(messages);
      historyRef.current = history;
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setLoading(true);
      try {
        // Mode is caller-controlled: "ask" prompts for mutating tools,
        // "autopilot" (Approve-for-me) auto-approves. The native side
        // assembles the context window and injects memory.
        await invoke("agent_run", { message: text, mode, history });
      } catch (e) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ]);
        setLoading(false);
      }
    },
    [messages],
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
    setCurrentSessionId(newSessionId());
    setMessages([]);
    setPendingApproval(null);
    setLoading(false);
  }, []);

  const switchSession = useCallback(async (id: string) => {
    const raw = await invoke<unknown>("load_session", { id }).catch(
      () => null,
    );
    setCurrentSessionId(id);
    setMessages(extractSessionMessages(raw));
    setPendingApproval(null);
    setLoading(false);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      await invoke("delete_session", { id }).catch(() => {});
      await refreshSessions();
      if (id === currentSessionId) {
        setCurrentSessionId(newSessionId());
        setMessages([]);
      }
    },
    [currentSessionId, refreshSessions],
  );

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
  };
}
