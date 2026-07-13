/**
 * Shared HTTP fetch wrapper.
 *
 * Corporate TLS-inspection proxies re-sign upstream certificates with a
 * private root CA that the runtime's bundled trust store rejects, producing
 * "self signed certificate in certificate chain". Neither
 * NODE_TLS_REJECT_UNAUTHORIZED nor undici's global dispatcher reliably fixes
 * this under Bun's native fetch — Bun overrides undici's fetch and honors a
 * per-request `tls` option instead.
 *
 * When OMNI_AGENT_INSECURE_TLS=1, this wrapper injects
 * `{ tls: { rejectUnauthorized: false } }` (Bun) into every request. Under
 * Node (dev fallback) the same flag is a no-op on the option object and the
 * env var set in index.ts covers Node's TLS. Every provider and the A2A
 * bridge import THIS `httpFetch`, never `undici`'s fetch directly, so the
 * escape hatch applies everywhere.
 */
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

const INSECURE_TLS = process.env.OMNI_AGENT_INSECURE_TLS === "1";

// Prefer the runtime's global fetch (Bun-native when running under Bun, which
// is the packaged case). Fall back to undici's fetch under plain Node.
const baseFetch: typeof undiciFetch =
  typeof (globalThis as { fetch?: unknown }).fetch === "function"
    ? ((globalThis as unknown as { fetch: typeof undiciFetch }).fetch)
    : undiciFetch;

export async function httpFetch(
  url: string,
  init?: UndiciRequestInit,
): ReturnType<typeof undiciFetch> {
  if (INSECURE_TLS) {
    // Bun-native fetch reads `tls.rejectUnauthorized`; the cast keeps the
    // undici types happy since the option is Bun-specific.
    const opts = { ...(init ?? {}), tls: { rejectUnauthorized: false } } as UndiciRequestInit;
    return baseFetch(url, opts);
  }
  return baseFetch(url, init);
}
