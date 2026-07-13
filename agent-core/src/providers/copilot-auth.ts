/**
 * GitHub Copilot device-flow authentication.
 *
 * Frontend contract: `start_copilot_device_flow` returns a discriminated
 * `CopilotAuthStatus` (state: "awaiting_user" | "connected" | "cancelled" | …)
 * — NOT the raw GitHub API shape. This module owns the polling loop and the
 * in-memory auth state that `copilot.status` reads.
 */
import { fetch } from "undici";
import { deleteSecret, getSecret, setSecret } from "../secrets.js";

const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // GitHub Copilot public client id

/** Wire type sent to the frontend. Kept in sync with `src/types/app.ts::CopilotAuthStatus`. */
export type CopilotAuthStatus =
  | { state: "disconnected" }
  | {
      state: "awaiting_user";
      flow_id: string;
      user_code: string;
      verification_uri: string;
      expires_at: number; // unix seconds
    }
  | { state: "connected"; login: string }
  | { state: "expired" }
  | { state: "cancelled" }
  | { state: "error"; message: string };

interface FlowContext {
  flow_id: string;
  device_code: string;
  interval_ms: number;
  expires_at: number;
  timer: ReturnType<typeof setInterval> | null;
}

let currentStatus: CopilotAuthStatus = { state: "disconnected" };
let currentFlow: FlowContext | null = null;

// Initialize from the keyring on first read.
async function initFromStore(): Promise<void> {
  const token = await getSecret("github-copilot.token");
  if (token && token.length > 0) {
    // We stored only the token, not the login handle. Best we can do without
    // a fresh GitHub API call is report connected with an empty login; the
    // frontend renders "Connected" without depending on the login string.
    currentStatus = { state: "connected", login: "" };
  }
}

let bootPromise: Promise<void> | null = null;
async function ensureBoot(): Promise<void> {
  if (!bootPromise) bootPromise = initFromStore();
  return bootPromise;
}

export async function getStatus(): Promise<CopilotAuthStatus> {
  await ensureBoot();
  return currentStatus;
}

export async function startDeviceFlow(): Promise<CopilotAuthStatus> {
  await ensureBoot();
  // Cancel any in-flight prior flow so we never have two pollers.
  stopPolling();
  const r = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
  });
  if (!r.ok) {
    currentStatus = { state: "error", message: `device_code http ${r.status}` };
    return currentStatus;
  }
  const body = (await r.json()) as {
    user_code: string;
    device_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const flowId = `flow-${nowSec}`;
  const expiresAt = nowSec + (body.expires_in ?? 600);
  currentFlow = {
    flow_id: flowId,
    device_code: body.device_code,
    interval_ms: Math.max(1, body.interval ?? 5) * 1000,
    expires_at: expiresAt,
    timer: null,
  };
  currentStatus = {
    state: "awaiting_user",
    flow_id: flowId,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    expires_at: expiresAt,
  };
  // Start the poll loop in the background. Do NOT await — the frontend
  // needs the awaiting_user response now so it can open the browser and
  // show the user_code.
  currentFlow.timer = setInterval(() => {
    void pollOnce();
  }, currentFlow.interval_ms);
  process.stderr.write(
    `agent-core: copilot device flow started: user_code=${body.user_code} uri=${body.verification_uri} interval=${body.interval}s\n`,
  );
  return currentStatus;
}

async function pollOnce(): Promise<void> {
  const flow = currentFlow;
  if (!flow) return;
  if (Math.floor(Date.now() / 1000) > flow.expires_at) {
    stopPolling();
    currentStatus = { state: "expired" };
    process.stderr.write("agent-core: copilot device flow: expired\n");
    return;
  }
  try {
    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: flow.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = (await r.json()) as { access_token?: string; error?: string; interval?: number };
    if (body.access_token) {
      await setSecret("github-copilot.token", body.access_token);
      // Read-back verification: catch keyring silently-not-persisting bugs
      // (which produce the "Copilot is not connected" error at inference).
      const verify = await getSecret("github-copilot.token");
      if (!verify) {
        stopPolling();
        currentStatus = {
          state: "error",
          message: "OAuth succeeded but the token could not be re-read from the secret store. Try setting a plaintext token or check the keyring backend.",
        };
        process.stderr.write("agent-core: copilot device flow: STORE VERIFY FAILED\n");
        return;
      }
      stopPolling();
      // Fetch login for a nicer UI label.
      let login = "";
      try {
        const u = await fetch("https://api.github.com/user", {
          headers: { authorization: `token ${body.access_token}`, "user-agent": "omni-agent-desktop/0.1" },
        });
        if (u.ok) login = (((await u.json()) as { login?: string }).login ?? "").trim();
      } catch {
        /* login is optional */
      }
      currentStatus = { state: "connected", login };
      process.stderr.write(`agent-core: copilot device flow: AUTHORIZED (login=${login || "?"})\n`);
      return;
    }
    switch (body.error) {
      case "authorization_pending":
        process.stderr.write("agent-core: copilot poll: authorization_pending\n");
        return;
      case "slow_down":
        if (currentFlow) {
          const newMs = currentFlow.interval_ms + 5000;
          clearInterval(currentFlow.timer!);
          currentFlow.interval_ms = newMs;
          currentFlow.timer = setInterval(() => void pollOnce(), newMs);
          process.stderr.write(`agent-core: copilot poll: slow_down -> ${newMs}ms\n`);
        }
        return;
      case "access_denied":
        stopPolling();
        currentStatus = { state: "cancelled" };
        process.stderr.write("agent-core: copilot device flow: access_denied\n");
        return;
      case "expired_token":
        stopPolling();
        currentStatus = { state: "expired" };
        process.stderr.write("agent-core: copilot device flow: expired_token\n");
        return;
      default:
        stopPolling();
        currentStatus = { state: "error", message: body.error ?? "unknown error" };
        process.stderr.write(`agent-core: copilot device flow: ERROR ${body.error ?? "unknown"}\n`);
        return;
    }
  } catch (e) {
    process.stderr.write(`agent-core: copilot poll error (retrying): ${(e as Error).message}\n`);
  }
}

function stopPolling(): void {
  if (currentFlow?.timer) clearInterval(currentFlow.timer);
  currentFlow = null;
}

export async function cancelDeviceFlow(): Promise<CopilotAuthStatus> {
  stopPolling();
  currentStatus = { state: "cancelled" };
  return currentStatus;
}

/** Manual entry: user pastes a PAT. Verified against the copilot token API. */
export async function connectWithToken(token: string): Promise<CopilotAuthStatus> {
  const r = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${token}`,
      "user-agent": "omni-agent-desktop/0.1",
    },
  });
  if (!r.ok) {
    currentStatus = { state: "error", message: `copilot token verify: http ${r.status}` };
    return currentStatus;
  }
  await setSecret("github-copilot.token", token);
  currentStatus = { state: "connected", login: "" };
  return currentStatus;
}

export async function disconnect(): Promise<CopilotAuthStatus> {
  stopPolling();
  await deleteSecret("github-copilot.token");
  currentStatus = { state: "disconnected" };
  return currentStatus;
}

