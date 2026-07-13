/**
 * Line-delimited JSON-RPC dispatcher over stdio.
 *
 * The Rust shell (`src-tauri/src/sidecar.rs`) writes one request per line to
 * our stdin and reads one response/event per line from our stdout. Anything
 * we log for humans MUST go to stderr — stdout is a wire.
 *
 * Verbose mode: set OMNI_AGENT_VERBOSE=1 to log every request, response, and
 * event to stderr with timing. Failing responses always log their error stack.
 */
import { createInterface } from "node:readline";

export type RpcRequest = {
  id: number;
  method: string;
  params?: unknown;
};

export type RpcResponse =
  | { id: number; result: unknown }
  | { id: number; error: { code: number; message: string; data?: unknown } };

export type RpcEvent = { event: string; data: unknown };

export type RpcHandler = (
  params: unknown,
  emit: (event: string, data: unknown) => void,
) => Promise<unknown> | unknown;

const VERBOSE = process.env.OMNI_AGENT_VERBOSE === "1" || process.env.OMNI_AGENT_VERBOSE === "true";

function preview(v: unknown, max = 400): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return String(v);
    return s.length > max ? `${s.slice(0, max)}…(${s.length}b)` : s;
  } catch {
    return String(v);
  }
}

function log(msg: string): void {
  process.stderr.write(`agent-core: ${msg}\n`);
}

export class RpcServer {
  private readonly handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`duplicate RPC method: ${method}`);
    }
    this.handlers.set(method, handler);
  }

  emit(event: string, data: unknown): void {
    if (VERBOSE) log(`event  ${event} ${preview(data, 200)}`);
    write({ event, data });
  }

  /** Read stdin forever, dispatching one request per line. */
  async serve(): Promise<void> {
    log(`serve: ${this.handlers.size} methods registered${VERBOSE ? " (verbose)" : ""}`);
    const rl = createInterface({ input: process.stdin });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      let req: RpcRequest;
      try {
        req = JSON.parse(line) as RpcRequest;
      } catch (e) {
        log(`bad JSON on stdin: ${(e as Error).message}: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(req);
    }
  }

  private async dispatch(req: RpcRequest): Promise<void> {
    const started = Date.now();
    const handler = this.handlers.get(req.method);
    if (VERBOSE) log(`req#${req.id} -> ${req.method} ${preview(req.params, 200)}`);
    if (!handler) {
      const err = { code: -32601, message: `unknown method: ${req.method}` };
      log(`req#${req.id} FAIL ${req.method}: ${err.message}`);
      write({ id: req.id, error: err });
      return;
    }
    try {
      const result = await handler(req.params, (event, data) => this.emit(event, data));
      const took = Date.now() - started;
      if (VERBOSE) log(`req#${req.id} <- ${req.method} ok ${took}ms ${preview(result, 200)}`);
      write({ id: req.id, result: result ?? null });
    } catch (e) {
      const err = e as Error;
      const took = Date.now() - started;
      log(`req#${req.id} FAIL ${req.method} (${took}ms): ${err.message}`);
      if (err.stack) log(err.stack.split("\n").slice(0, 6).join(" | "));
      write({
        id: req.id,
        error: { code: -32000, message: err.message, data: err.stack },
      });
    }
  }
}

function write(msg: RpcResponse | RpcEvent): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
