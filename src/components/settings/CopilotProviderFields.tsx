import { useEffect, useRef, useState } from "react";
import { invoke } from "../../lib/runtime";
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
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Initial status read.
  useEffect(() => {
    mountedRef.current = true;
    invoke<CopilotAuthStatus>("get_copilot_auth_status")
      .then((s) => {
        if (mountedRef.current) setStatus(s);
      })
      .catch(() => {});
    return () => {
      mountedRef.current = false;
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
      invoke<CopilotAuthStatus>("get_copilot_auth_status")
        .then((s) => {
          if (mountedRef.current) setStatus(s);
        })
        .catch(() => {});
    }, POLL_INTERVAL_MS);
    return stopPolling;
  }, [status.state]);

  const startDeviceFlow = async () => {
    setBusy(true);
    setError("");
    try {
      const s = await invoke<CopilotAuthStatus>("start_copilot_device_flow");
      if (mountedRef.current) setStatus(s);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const cancelFlow = async () => {
    stopPolling();
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
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const disconnect = async () => {
    stopPolling();
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

  const discoverModels = async () => {
    setBusy(true);
    setError("");
    try {
      const list = await invoke<CopilotModel[]>("list_copilot_models");
      if (mountedRef.current) setModels(list);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const connected = status.state === "connected";

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
              <a
                href={status.verification_uri}
                target="_blank"
                rel="noreferrer noopener"
              >
                {status.verification_uri}
              </a>
            </div>
            <button
              type="button"
              className="omni-btn"
              style={{ marginTop: 8 }}
              onClick={cancelFlow}
            >
              Cancel
            </button>
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
            <span style={rowLabelStyle}>Models</span>
            <div>
              <button
                type="button"
                className="omni-btn"
                onClick={discoverModels}
                disabled={busy}
              >
                Discover models
              </button>
              {models.length > 0 && (
                <div className="settings-popover" style={{ position: "static", marginTop: 8 }}>
                  {models.map((m) => {
                    const isSel = m.id === draft.model;
                    return (
                      <div
                        key={m.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => update({ model: m.id })}
                        className={`settings-popover__item${isSel ? " settings-popover__item--active" : ""}`}
                      >
                        {m.id}
                      </div>
                    );
                  })}
                </div>
              )}
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
