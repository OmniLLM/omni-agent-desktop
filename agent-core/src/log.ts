/**
 * Persistent file logging.
 *
 * The Rust shell forwards the sidecar's stderr with `Stdio::inherit()`, which
 * means that in a packaged GUI build — where no console is attached — every
 * diagnostic the sidecar writes is discarded. A user reporting "it just says
 * Working... and never does anything" therefore has nothing to send, and the
 * failure cannot be told apart from a hang, a silent tool-list shrink, or a
 * tool that ran and stalled.
 *
 * So mirror stderr into `<configDir>/logs/agent-core.log`, rotated by size so
 * the file cannot grow without bound.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";

const MAX_BYTES = 5 * 1024 * 1024;

let logPath: string | null = null;

function path(): string {
  if (logPath) return logPath;
  const dir = join(configDir(), "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* fall through; append will surface the problem once, then be swallowed */
  }
  logPath = join(dir, "agent-core.log");
  return logPath;
}

/** Rotates to a single `.1` backup once the live file exceeds MAX_BYTES. */
function rotateIfNeeded(p: string): void {
  try {
    if (statSync(p).size > MAX_BYTES) renameSync(p, `${p}.1`);
  } catch {
    /* no file yet, or rotation raced another writer — either is fine */
  }
}

/**
 * Writes one timestamped line to stderr AND the log file.
 *
 * Logging must never be the reason a run fails, so all IO errors are swallowed.
 */
export function log(msg: string): void {
  // Tests assert on behavior, not diagnostics; emitting run traces there buries
  // real failures in noise. bunfig.toml's preload sets this for the suite.
  if (process.env.OMNI_AGENT_QUIET_LOG === "1") return;
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    process.stderr.write(line);
  } catch {
    /* stderr may be closed in a packaged build */
  }
  try {
    const p = path();
    rotateIfNeeded(p);
    appendFileSync(p, line);
  } catch {
    /* disk full / permissions — never fail a run over a log write */
  }
}

/** Absolute path of the live log file, for surfacing in the UI. */
export function logFilePath(): string {
  return path();
}
