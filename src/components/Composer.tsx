import { useEffect, useRef, useState } from "react";
import { invoke } from "../lib/runtime";
import type { AppSettings, ProviderType } from "../types/app";

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
  settings: AppSettings | null;
  onModelChange?: (provider: ProviderType, model: string) => void;
  approveForMe?: boolean;
  onToggleApprove?: (value: boolean) => void;
}

const PROVIDER_LABELS: Record<ProviderType, string> = {
  "custom-provider": "Custom",
  "github-copilot": "GitHub Copilot",
  "azure-foundry": "Azure Foundry",
};

export default function Composer({
  onSend,
  disabled,
  settings,
  onModelChange,
  approveForMe = false,
  onToggleApprove,
}: Props) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const activeProvider = settings?.active_provider ?? "custom-provider";
  const activeModel = settings?.ai_model ?? "";
  const activeConfig = settings?.provider_configs?.[activeProvider];

  const submit = () => {
    if (text.trim()) {
      onSend(text);
      setText("");
    }
  };

  // Close the picker on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Fetch the model list for the active provider when the picker opens.
  useEffect(() => {
    if (!open || !activeConfig) return;
    let active = true;
    invoke<string[]>("list_models", {
      baseUrl: activeConfig.endpoint,
      apiKey: activeConfig.api_key,
    })
      .then((list) => {
        if (active && Array.isArray(list)) setModels(list);
      })
      .catch(() => {
        if (active) setModels([]);
      });
    return () => {
      active = false;
    };
  }, [open, activeProvider, activeConfig]);

  // Reset the filter and focus the filter box each time the picker opens.
  useEffect(() => {
    if (open) {
      setFilter("");
      const id = window.setTimeout(() => filterRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const allModels =
    models.length > 0 ? models : activeModel ? [activeModel] : [];
  const modelOptions = filter.trim()
    ? allModels.filter((m) => m.toLowerCase().includes(filter.toLowerCase()))
    : allModels;

  return (
    <div className="composer2">
      <div className="composer2__box">
        <textarea
          className="composer2__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Message the agent"
          rows={1}
        />
        <div className="composer2__controls">
          <button
            type="button"
            className="composer2__add"
            aria-label="Add attachment"
          >
            ＋
          </button>
          <button
            type="button"
            className={`composer2__toggle${
              approveForMe ? " is-active" : ""
            }`}
            aria-pressed={approveForMe}
            onClick={() => onToggleApprove?.(!approveForMe)}
            title="When on, tool actions run without asking for approval"
          >
            <span aria-hidden="true">◍</span> Approve for me
          </button>
          <span className="composer2__spacer" />

          <div className="composer2__picker" ref={menuRef}>
            <button
              type="button"
              className="composer2__model"
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              title="Select provider and model"
            >
              {activeModel || "Select model"}
              <span aria-hidden="true" className="composer2__model-caret">
                ▾
              </span>
            </button>
            {open ? (
              <div className="composer2__menu" role="listbox">
                <div className="composer2__menu-group">Provider</div>
                {(Object.keys(PROVIDER_LABELS) as ProviderType[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="option"
                    aria-selected={p === activeProvider}
                    className={`composer2__menu-item${
                      p === activeProvider ? " is-active" : ""
                    }`}
                    onClick={() => {
                      const cfg = settings?.provider_configs?.[p];
                      onModelChange?.(p, cfg?.model ?? "");
                    }}
                  >
                    {PROVIDER_LABELS[p]}
                  </button>
                ))}
                <div className="composer2__menu-group">Model</div>
                <input
                  ref={filterRef}
                  type="text"
                  className="composer2__menu-filter"
                  placeholder="Filter models…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && modelOptions.length > 0) {
                      onModelChange?.(activeProvider, modelOptions[0]);
                      setOpen(false);
                    }
                  }}
                />
                {modelOptions.length === 0 ? (
                  <div className="composer2__menu-empty">
                    {filter.trim() ? "No matches" : "No models available"}
                  </div>
                ) : (
                  modelOptions.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="option"
                      aria-selected={m === activeModel}
                      className={`composer2__menu-item${
                        m === activeModel ? " is-active" : ""
                      }`}
                      onClick={() => {
                        onModelChange?.(activeProvider, m);
                        setOpen(false);
                      }}
                    >
                      {m}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="composer2__send"
            aria-label="Send"
            onClick={submit}
            disabled={disabled}
          >
            ↑
          </button>
        </div>
      </div>
      <p className="composer2__disclaimer">
        AI-generated content may be incorrect
      </p>
    </div>
  );
}
