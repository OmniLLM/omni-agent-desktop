/**
 * Thin frontend shim for the agent-core sidecar bridge.
 *
 * Instead of calling a Rust `#[tauri::command]` per feature, the frontend can
 * now go through the sidecar's JSON-RPC surface:
 *
 *     import { call, listen } from "./lib/sidecar";
 *     const outcome = await call("agent.run", { message, mode: "ask" });
 *     const stop = await listen("agent://tool-call", (e) => ...);
 *
 * Events fire under their original names (`agent://…`, `scheduler://…`), so
 * existing listeners keep working.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

export async function call<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await invoke("sidecar_call", { method, params: params ?? null })) as T;
}

export async function listen<T = unknown>(
  event: string,
  cb: (payload: T) => void,
): Promise<UnlistenFn> {
  return tauriListen<T>(event, (msg) => cb(msg.payload));
}
