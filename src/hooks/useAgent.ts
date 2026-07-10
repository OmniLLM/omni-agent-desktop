import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../lib/runtime";
import type { ChatMessage, RunMode, ToolCallEvent } from "../types/app";

export interface UseAgentResult {
  messages: ChatMessage[];
  loading: boolean;
  pendingApproval: ToolCallEvent | null;
  send: (text: string, mode: RunMode) => Promise<void>;
  decide: (decision: "approve" | "deny" | "allow_session") => Promise<void>;
}

export function useAgent(): UseAgentResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ToolCallEvent | null>(
    null,
  );
  const cleanupRef = useRef<Array<() => void>>([]);
  const loadedRef = useRef(false);

  // Load the persisted conversation once on mount.
  useEffect(() => {
    invoke<ChatMessage[]>("load_conversation")
      .then((saved) => {
        if (Array.isArray(saved) && saved.length) setMessages(saved);
      })
      .catch(() => {})
      .finally(() => {
        loadedRef.current = true;
      });
  }, []);

  // Persist the conversation whenever it changes (after the initial load).
  useEffect(() => {
    if (!loadedRef.current) return;
    invoke("save_conversation", { messages }).catch(() => {});
  }, [messages]);

  useEffect(() => {
    let active = true;
    (async () => {
      const un: Array<() => void> = [];
      un.push(
        await listen<string>("agent://done", (e) => {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: e.payload },
          ]);
          setLoading(false);
          setPendingApproval(null);
        }),
      );
      un.push(
        await listen<string>("agent://error", (e) => {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Error: ${e.payload}` },
          ]);
          setLoading(false);
          setPendingApproval(null);
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

  const send = useCallback(async (text: string, mode: RunMode) => {
    if (!text.trim()) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    await invoke("agent_run", { message: text, mode });
  }, []);

  const decide = useCallback(
    async (decision: "approve" | "deny" | "allow_session") => {
      const call = pendingApproval;
      setPendingApproval(null);
      if (call) await invoke("approve_tool", { call_id: call.call_id, decision });
    },
    [pendingApproval],
  );

  return { messages, loading, pendingApproval, send, decide };
}
