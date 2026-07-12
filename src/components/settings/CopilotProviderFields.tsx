import { useEffect, useRef, useState } from "react";
import { invoke, openExternalUrl } from "../../lib/runtime";
import type {
  CopilotAuthStatus,
  CopilotModel,
  ProviderConfig,
} from "../../types/app";

interface Props {
  draft: ProviderConfig;
  update: (patch: Partial<ProviderConfig>) => void;
  rowStyle: (last?: boolean) => React.CSSProperties;
  rowLabelStyle: React.CSSProperties;
  /** Report connected/disconnected up so the parent can gate save-time
   * activation on a real credential. */
  onConnectionChange?: (connected: boolean) => void;
}

/** How often (ms) to poll auth status while a device flow is pending. */
const POLL_INTERVAL_MS = 2500;
const MANUAL_HANDOFF_MESSAGE = "Open the GitHub link shown below";

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function isSafeCopilotVerificationUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname === "/login/device"
    );
  } catch {
    return false;
  }
}

function stateLabel(status: CopilotAuthStatus): string {
  switch (status.state) {
    case "disconnected":
      return "Disconnected";
    case "awaiting_user":
      return "Waiting for GitHub authorization…";
    case "connected":
      return `Connected as ${status.login}`;
    case "expired":
      return "Device flow expired";
    case "cancelled":
      return "Cancelled";
    case "error":
      return status.message;
  }
}

/**
 * GitHub Copilot OAuth device-flow / manual-token UI plus model discovery.
 *
 * Status polling is bounded: a timer runs ONLY while the flow is
 * `awaiting_user` and is cleared on any terminal state, on unmount, and on
 * cancel. No token is ever displayed or stored in React — only the public
 * status. The `mounted` guard prevents state updates after unmount.
 */
export default function CopilotProviderFields({
  draft,
  update,
  rowStyle,
  rowLabelStyle,
  onConnectionChange,
}: Props) {
  const [status, setStatus] = useState<CopilotAuthStatus>({
    state: "disconnected",
  });
  const [token, setToken] = useState("");
  const [models, setModels] = useState<CopilotModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState("");
  const [handoffStatus, setHandoffStatus] = useState("");
  const mountedRef = useRef(true);
  const statusRequestRef = useRef(0);
  const deviceFlowStartedRef = useRef(false);
  const discoveryGenRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Initial status read. Ignore a stale response if the user starts a new flow
  // before it resolves.
  useEffect(() => {
    mountedRef.current = true;
    const request = ++statusRequestRef.current;
    invoke<CopilotAuthStatus>("get_copilot_auth_status")
      .then((s) => {
        if (
          mountedRef.current &&
          request === statusRequestRef.current &&
          !deviceFlowStartedRef.current
        ) {
          setStatus(s);
        }
      })
      .catch(() => {});
    return () => {
      mountedRef.current = false;
      statusRequestRef.current += 1;
      discoveryGenRef.current += 1;
      stopPolling();
    };
  }, []);

  // Bounded polling: active only while awaiting the user.
  useEffect(() => {
    if (status.state !== "awaiting_user") {
      stopPolling();
      return;
    }
    if (pollRef.current !== null) return;
    pollRef.current = setInterval(() => {
      const request = ++statusRequestRef.current;
      invoke<CopilotAuthStatus>("get_copilot_auth_status")
        .then((s) => {
          if (
            mountedRef.current &&
            request === statusRequestRef.current
          ) {
            setStatus(s);
          }
        })
        .catch(() => {});
    }, POLL_INTERVAL_MS);
    return stopPolling;
  }, [status.state]);

  const copyDeviceCode = async (userCode: string) => {
    try {
      await navigator.clipboard.writeText(userCode);
      if (mountedRef.current) setHandoffStatus("Device code copied");
    } catch {
      if (mountedRef.current) setHandoffStatus("Copy the device code shown below");
    }
  };

  const openVerificationPage = async (verificationUri: string) => {
    if (!isSafeCopilotVerificationUri(verificationUri)) {
      if (mountedRef.current) setHandoffStatus(MANUAL_HANDOFF_MESSAGE);
      return;
    }
    try {
      await openExternalUrl(verificationUri);
    } catch {
      if (mountedRef.current) setHandoffStatus(MANUAL_HANDOFF_MESSAGE);
    }
  };

  const handOffDeviceFlow = async (
    userCode: string,
    verificationUri: string,
  ) => {
    await Promise.allSettled([
      copyDeviceCode(userCode),
      openVerificationPage(verificationUri),
    ]);
  };

  const startDeviceFlow = async () => {
    setBusy(true);
    setError("");
    setHandoffStatus("");
    deviceFlowStartedRef.current = true;
    statusRequestRef.current += 1;
    try {
      const s = await invoke<CopilotAuthStatus>("start_copilot_device_flow");
      if (mountedRef.current) setStatus(s);
      if (s.state === "awaiting_user") {
        await handOffDeviceFlow(s.user_code, s.verification_uri);
      }
    } catch (e) {
      if (mountedRef.current) setError(describeError(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const cancelFlow = async () => {
    stopPolling();
    statusRequestRef.current += 1;
    deviceFlowStartedRef.current = false;
    try {
      await invoke("cancel_copilot_device_flow");
    } catch {
      // best-effort
    }
    if (mountedRef.current) setStatus({ state: "cancelled" });
  };

  const connectWithToken = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setError("");
    try {
      const s = await invoke<CopilotAuthStatus>("connect_copilot_with_token", {
        token: token.trim(),
      });
      if (mountedRef.current) {
        setStatus(s);
        setToken("");
      }
    } catch (e) {
      if (mountedRef.current) setError(describeError(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const disconnect = async () => {
    stopPolling();
    statusRequestRef.current += 1;
    deviceFlowStartedRef.current = false;
    discoveryGenRef.current += 1;
    setModelsLoading(false);
    try {
      await invoke("disconnect_copilot");
    } catch {
      // best-effort
    }
    if (mountedRef.current) {
      setStatus({ state: "disconnected" });
      setModels([]);
    }
  };

  const refreshModels = async () => {
    const generation = ++discoveryGenRef.current;
    setModelsLoading(true);
    setError("");
    try {
      const result = await invoke<CopilotModel[]>("list_copilot_models");
      const list = Array.isArray(result) ? result : [];
      if (mountedRef.current && generation === discoveryGenRef.current) {
        setModels(list);
      }
    } catch (e) {
      if (mountedRef.current && generation === discoveryGenRef.current) {
        setError(describeError(e));
      }
    } finally {
      if (mountedRef.current && generation === discoveryGenRef.current) {
        setModelsLoading(false);
      }
    }
  };

  const connected = status.state === "connected";

  useEffect(() => {
    if (connected) {
      void refreshModels();
    } else {
      discoveryGenRef.current += 1;
      setModelsLoading(false);
    }
  }, [connected]);

  // Surface connection changes to the parent for save-time activation gating.
  useEffect(() => {
    onConnectionChange?.(connected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  return (
    <div className="settings-card">
      <div style={rowStyle()}>
        <span style={rowLabelStyle}>Status</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            role={status.state === "error" ? "alert" : undefined}
            style={{
              color:
                status.state === "error"
                  ? "var(--error)"
                  : connected
                    ? "var(--accent)"
                    : "var(--text)",
            }}
          >
            {stateLabel(status)}
          </span>
        </div>
      </div>

      {status.state === "awaiting_user" && (
        <div style={rowStyle()}>
          <span style={rowLabelStyle}>Device code</span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>
              {status.user_code}
            </div>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              Enter it at{" "}
              {isSafeCopilotVerificationUri(status.verification_uri) ? (
                <a
                  href={status.verification_uri}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {status.verification_uri}
                </a>
              ) : (
                <span>{status.verification_uri}</span>
              )}
            </div>
            {handoffStatus && (
              <div role="status" aria-live="polite" style={{ fontSize: 13, marginTop: 6 }}>
                {handoffStatus}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="omni-btn"
                onClick={() => copyDeviceCode(status.user_code)}
              >
                Copy code
              </button>
              <button
                type="button"
                className="omni-btn"
                onClick={() => openVerificationPage(status.verification_uri)}
                disabled={!isSafeCopilotVerificationUri(status.verification_uri)}
              >
                Open GitHub
              </button>
              <button
                type="button"
                className="omni-btn"
                onClick={cancelFlow}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {!connected && status.state !== "awaiting_user" && (
        <>
          <div style={rowStyle()}>
            <span style={rowLabelStyle}>Sign in</span>
            <div>
              <button
                type="button"
                className="omni-btn omni-btn--primary"
                onClick={startDeviceFlow}
                disabled={busy}
              >
                Connect with GitHub
              </button>
            </div>
          </div>
          <div style={rowStyle()}>
            <label style={rowLabelStyle} htmlFor="copilot-token">
              GitHub Token
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="copilot-token"
                className="omni-input"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_… (manual fallback)"
              />
              <button
                type="button"
                className="omni-btn"
                onClick={connectWithToken}
                disabled={busy || !token.trim()}
              >
                Connect with token
              </button>
            </div>
          </div>
        </>
      )}

      {connected && (
        <>
          <div style={rowStyle()}>
            <label style={rowLabelStyle} htmlFor="copilot-model">
              Model
              {modelsLoading && (
                <span style={{ color: "var(--accent)" }}> (loading…)</span>
              )}
            </label>
            <div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  id="copilot-model"
                  className="omni-input"
                  list="copilot-model-list"
                  value={draft.model}
                  onChange={(event) => update({ model: event.target.value })}
                  placeholder="Type or pick a model…"
                />
                <button
                  type="button"
                  className="omni-btn"
                  onClick={refreshModels}
                  disabled={modelsLoading}
                >
                  Refresh models
                </button>
              </div>
              <datalist id="copilot-model-list">
                {models.map((model) => (
                  <option key={model.id} value={model.id} />
                ))}
              </datalist>
            </div>
          </div>
          <div style={rowStyle(true)}>
            <span style={rowLabelStyle}>Account</span>
            <div>
              <button type="button" className="omni-btn" onClick={disconnect}>
                Disconnect
              </button>
            </div>
          </div>
        </>
      )}

      {error ? (
        <div style={rowStyle(true)}>
          <span style={rowLabelStyle} />
          <span role="alert" className="window-size-error">
            {error}
          </span>
        </div>
      ) : null}
    </div>
  );
}
