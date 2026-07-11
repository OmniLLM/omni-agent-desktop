import type { ApiShape, ProviderConfig } from "../../types/app";

const API_SHAPES: { value: ApiShape; label: string }[] = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-responses", label: "OpenAI Responses" },
];

interface Props {
  draft: ProviderConfig;
  update: (patch: Partial<ProviderConfig>) => void;
  errors?: string;
  models: string[];
  modelsLoading?: boolean;
  modelsError?: string;
  onDiscoverModels: () => void;
  rowStyle: (last?: boolean) => React.CSSProperties;
  rowLabelStyle: React.CSSProperties;
}

/**
 * Fields for the generic "custom provider": a base endpoint, an optional
 * plaintext API key, the request/response API shape, and a model with optional
 * discovery. This provider's key is NOT secret-stored, so the value is edited
 * directly on the draft config.
 */
export default function CustomProviderFields({
  draft,
  update,
  errors,
  models,
  modelsLoading,
  modelsError,
  onDiscoverModels,
  rowStyle,
  rowLabelStyle,
}: Props) {
  return (
    <div className="settings-card">
      <div style={rowStyle()}>
        <label style={rowLabelStyle} htmlFor="custom-endpoint">
          Provider URL
        </label>
        <input
          id="custom-endpoint"
          className="omni-input"
          value={draft.endpoint}
          onChange={(e) => update({ endpoint: e.target.value })}
          placeholder="http://127.0.0.1:5000"
        />
      </div>
      <div style={rowStyle()}>
        <label style={rowLabelStyle} htmlFor="custom-api-key">
          API Key
        </label>
        <input
          id="custom-api-key"
          className="omni-input"
          type="password"
          value={draft.api_key}
          onChange={(e) => update({ api_key: e.target.value })}
          placeholder="API key"
        />
      </div>
      <div style={rowStyle()}>
        <label style={rowLabelStyle} htmlFor="custom-api-shape">
          API Shape
        </label>
        <select
          id="custom-api-shape"
          className="omni-select"
          style={{ cursor: "pointer" }}
          value={draft.api_shape}
          onChange={(e) => update({ api_shape: e.target.value as ApiShape })}
        >
          {API_SHAPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div style={rowStyle(true)}>
        <label style={rowLabelStyle} htmlFor="custom-model">
          Model
          {modelsLoading && (
            <span style={{ color: "var(--accent)" }}> (loading…)</span>
          )}
          {modelsError && (
            <span style={{ color: "var(--error)" }} title={modelsError}>
              {" "}
              ⚠
            </span>
          )}
        </label>
        <div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="custom-model"
              className="omni-input"
              list="custom-model-list"
              value={draft.model}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="Type or pick a model…"
            />
            <button
              type="button"
              className="omni-btn"
              onClick={onDiscoverModels}
            >
              Discover models
            </button>
          </div>
          <datalist id="custom-model-list">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {errors ? (
            <span
              role="alert"
              className="window-size-error"
              style={{ display: "block", marginTop: 6 }}
            >
              {errors}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
