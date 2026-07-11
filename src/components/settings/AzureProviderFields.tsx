import { useMemo, useRef, useState } from "react";
import { invoke } from "../../lib/runtime";
import type { AzureDeploymentMapping, ProviderConfig } from "../../types/app";
import { normalizedAzureModels } from "../../lib/providerValidation";

interface Props {
  draft: ProviderConfig;
  update: (patch: Partial<ProviderConfig>) => void;
  errors?: string;
  rowStyle: (last?: boolean) => React.CSSProperties;
  rowLabelStyle: React.CSSProperties;
}

/** A mapping row with a stable UI-only id. The id is never persisted — the
 * saved contract is the plain {model, deployment} pair. */
interface Row {
  id: string;
  model: string;
  deployment: string;
}

let rowSeq = 0;
function newRowId(): string {
  rowSeq += 1;
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `azure-row-${rowSeq}-${Date.now()}`;
}

/**
 * Azure AI Foundry configuration: endpoint, request-only API key (blank when a
 * credential is already stored), API version, and model→deployment mappings.
 *
 * Rows carry a stable client id so React keys stay stable across add/edit/delete
 * without persisting the id. Duplicate model OR deployment names are flagged
 * inline. Test Connection sends the unsaved draft plus the request key and
 * displays a redacted result.
 */
export default function AzureProviderFields({
  draft,
  update,
  errors,
  rowStyle,
  rowLabelStyle,
}: Props) {
  // Seed stable rows from the draft once; thereafter the rows array is the
  // source of truth and is projected back into the draft on every change.
  const rowsRef = useRef<Row[] | null>(null);
  if (rowsRef.current === null) {
    rowsRef.current = (draft.azure_deployments ?? []).map((m) => ({
      id: newRowId(),
      model: m.model,
      deployment: m.deployment,
    }));
  }
  const [rows, setRows] = useState<Row[]>(rowsRef.current);
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);

  const commit = (next: Row[]) => {
    setRows(next);
    const mappings: AzureDeploymentMapping[] = next.map(({ model, deployment }) => ({
      model,
      deployment,
    }));
    update({ azure_deployments: mappings });
  };

  const duplicateError = useMemo(() => {
    const models = new Map<string, number>();
    const deployments = new Map<string, number>();
    for (const r of rows) {
      const m = r.model.trim();
      const d = r.deployment.trim();
      if (m) models.set(m, (models.get(m) ?? 0) + 1);
      if (d) deployments.set(d, (deployments.get(d) ?? 0) + 1);
    }
    for (const [, count] of models) if (count > 1) return "Duplicate model name in mappings";
    for (const [, count] of deployments)
      if (count > 1) return "Duplicate deployment name in mappings";
    return "";
  }, [rows]);

  const addRow = () => commit([...rows, { id: newRowId(), model: "", deployment: "" }]);
  const removeRow = (id: string) => commit(rows.filter((r) => r.id !== id));
  const editRow = (id: string, patch: Partial<Row>) =>
    commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const testConnection = async () => {
    setTesting(true);
    setTestResult("");
    try {
      const result = await invoke<string>("test_azure_connection", {
        draft,
        apiKey: draft.api_key,
      });
      setTestResult(String(result));
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-card">
      <div style={rowStyle()}>
        <label style={rowLabelStyle} htmlFor="azure-endpoint">
          Endpoint
        </label>
        <input
          id="azure-endpoint"
          className="omni-input"
          value={draft.endpoint}
          onChange={(e) => update({ endpoint: e.target.value })}
          placeholder="https://<resource>.openai.azure.com"
        />
      </div>
      <div style={rowStyle()}>
        <label style={rowLabelStyle} htmlFor="azure-api-key">
          API Key
        </label>
        <div>
          <input
            id="azure-api-key"
            className="omni-input"
            type="password"
            value={draft.api_key}
            onChange={(e) => update({ api_key: e.target.value })}
            placeholder={
              draft.api_key_stored
                ? "•••••• (stored — leave blank to keep)"
                : "api-key"
            }
          />
          {draft.api_key_stored ? (
            <button
              type="button"
              className="omni-btn"
              style={{ marginTop: 8 }}
              onClick={() => update({ api_key: "", api_key_stored: false })}
            >
              Clear stored key
            </button>
          ) : null}
        </div>
      </div>
      <div style={rowStyle()}>
        <label style={rowLabelStyle} htmlFor="azure-api-version">
          API Version
        </label>
        <input
          id="azure-api-version"
          className="omni-input"
          value={draft.azure_api_version ?? ""}
          onChange={(e) => update({ azure_api_version: e.target.value })}
          placeholder="2024-02-01"
        />
      </div>

      <div style={rowStyle()}>
        <span style={rowLabelStyle}>Deployments</span>
        <div>
          {rows.map((r, idx) => (
            <div
              key={r.id}
              style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}
            >
              <input
                className="omni-input"
                aria-label={`azure-model-${idx}`}
                placeholder="model (e.g. gpt-4o)"
                value={r.model}
                onChange={(e) => editRow(r.id, { model: e.target.value })}
              />
              <span aria-hidden="true">→</span>
              <input
                className="omni-input"
                aria-label={`azure-deployment-${idx}`}
                placeholder="deployment name"
                value={r.deployment}
                onChange={(e) => editRow(r.id, { deployment: e.target.value })}
              />
              <button
                type="button"
                className="omni-btn"
                aria-label={`remove-mapping-${idx}`}
                onClick={() => removeRow(r.id)}
              >
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="omni-btn" onClick={addRow}>
            Add mapping
          </button>
          {duplicateError ? (
            <span
              role="alert"
              className="window-size-error"
              style={{ display: "block", marginTop: 6 }}
            >
              {duplicateError}
            </span>
          ) : null}
        </div>
      </div>

      <div style={rowStyle()}>
        <label style={rowLabelStyle} htmlFor="azure-model">
          Selected model
        </label>
        <select
          id="azure-model"
          className="omni-select"
          style={{ cursor: "pointer" }}
          value={draft.model}
          onChange={(e) => update({ model: e.target.value })}
        >
          <option value="">(select a mapped model)</option>
          {normalizedAzureModels(draft).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div style={rowStyle(true)}>
        <span style={rowLabelStyle}>Connection</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            className="omni-btn"
            onClick={testConnection}
            disabled={testing}
          >
            Test Connection
          </button>
          {testResult ? (
            <span style={{ fontSize: 13, color: "var(--sub)" }}>{testResult}</span>
          ) : null}
        </div>
      </div>

      {errors ? (
        <div style={rowStyle(true)}>
          <span style={rowLabelStyle} />
          <span role="alert" className="window-size-error">
            {errors}
          </span>
        </div>
      ) : null}
    </div>
  );
}
