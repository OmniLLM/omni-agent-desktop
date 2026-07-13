/**
 * GitHub Copilot device-flow authentication.
 *
 * Steps:
 *   1. POST /login/device/code with client_id -> user_code, device_code, verification_uri, interval
 *   2. Poll POST /login/oauth/access_token until access_token or terminal error
 *   3. Persist access_token in the keyring under `github-copilot.token`
 *
 * The RPC layer surfaces the user_code + verification URI to the frontend and
 * calls `pollDeviceFlow` on a timer. Cancellation aborts the poll.
 */
import { fetch } from "undici";
import { setSecret } from "../secrets.js";

const CLIENT_ID = "Iv1.b507a08c87ecfe98"; // GitHub Copilot public client id

export interface DeviceCode {
  user_code: string;
  device_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  const r = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
  });
  if (!r.ok) throw new Error(`device_code http ${r.status}`);
  return (await r.json()) as DeviceCode;
}

export interface PollResult {
  status: "pending" | "authorized" | "denied" | "expired" | "error";
  message?: string;
}

export async function pollDeviceOnce(deviceCode: string): Promise<PollResult> {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const body = (await r.json()) as { access_token?: string; error?: string };
  if (body.access_token) {
    await setSecret("github-copilot.token", body.access_token);
    return { status: "authorized" };
  }
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "pending", message: "slow down" };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return { status: "error", message: body.error };
  }
}

/** Manual entry: user pastes a PAT with copilot scope. Verified by hitting the token exchange. */
export async function connectWithToken(token: string): Promise<void> {
  const r = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${token}`,
      "user-agent": "omni-agent-desktop/0.1",
    },
  });
  if (!r.ok) throw new Error(`copilot token verify: http ${r.status}`);
  await setSecret("github-copilot.token", token);
}
