/**
 * Line-delimited JSON-RPC dispatcher over stdio.
 *
 * The Rust shell (`src-tauri/src/sidecar.rs`) writes one request per line to
 * our stdin and reads one response/event per line from our stdout. Anything
 * we log for humans MUST go to stderr — stdout is a wire.
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

export class RpcServer {
  private readonly handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`duplicate RPC method: ${method}`);
    }
    this.handlers.set(method, handler);
  }

  emit(event: string, data: unknown): void {
    write({ event, data });
  }

  /** Read stdin forever, dispatching one request per line. */
  async serve(): Promise<void> {
    const rl = createInterface({ input: process.stdin });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      let req: RpcRequest;
      try {
        req = JSON.parse(line) as RpcRequest;
      } catch (e) {
        // Malformed line — surface on stderr, don't crash the sidecar.
        process.stderr.write(`agent-core: bad JSON on stdin: ${(e as Error).message}\n`);
        continue;
      }
      this.dispatch(req);
    }
  }

  private async dispatch(req: RpcRequest): Promise<void> {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      write({ id: req.id, error: { code: -32601, message: `unknown method: ${req.method}` } });
      return;
    }
    try {
      const result = await handler(req.params, (event, data) => this.emit(event, data));
      write({ id: req.id, result: result ?? null });
    } catch (e) {
      const err = e as Error;
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
