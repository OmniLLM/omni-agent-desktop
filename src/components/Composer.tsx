import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { invoke } from "../lib/runtime";
import SlashMenu from "./SlashMenu";
import {
  filterCommands,
  matchCommand,
  parseSlashInput,
  type SlashCommand,
  type SlashContext,
} from "../lib/slashCommands";
import type {
  AppSettings,
  CopilotModel,
  ProviderConfig,
  ProviderType,
  ImageAttachment,
} from "../types/app";

export interface ComposerHandle {
  setText: (text: string) => void;
  insertText: (text: string) => void;
  addImage: (image: ImageAttachment) => void;
}

interface Props {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  disabled: boolean;
  settings: AppSettings | null;
  onModelChange?: (provider: ProviderType, model: string) => void;
  approveForMe?: boolean;
  onToggleApprove?: (value: boolean) => void;
  /** Runtime surface for slash commands. When omitted, `/…` text is sent
   * verbatim (no command handling), preserving the plain composer behavior. */
  slash?: SlashContext;
  /** When true, a run is active — the send button turns into a cancel button
   * that calls `onCancel` instead of submitting. */
  loading?: boolean;
  onCancel?: () => void;
  /** Programmatically set the composer's text (e.g. from the help panel picking
   * an argument command). Exposed via a ref so parents can drive the input. */
  composerRef?: React.RefObject<ComposerHandle | null>;
}

/** The leading-slash query is active only when the whole input is a single
 * `/word` token with no whitespace yet — once the user types a space they are
 * writing an argument, so the autocomplete menu closes. Returns the query text
 * after the slash, or null when the menu should not be open. */
function slashQuery(text: string): string | null {
  const parsed = parseSlashInput(text);
  return parsed && !parsed.hasArgument ? parsed.token : null;
}

const PROMPT_HISTORY_LIMIT = 50;

interface PromptHistoryState {
  entries: string[];
  index: number | null;
  draft: string;
}

function hasCollapsedSelection(textarea: HTMLTextAreaElement): boolean {
  return textarea.selectionStart === textarea.selectionEnd;
}

function isOnFirstLogicalLine(textarea: HTMLTextAreaElement): boolean {
  return textarea.value.lastIndexOf("\n", textarea.selectionStart - 1) === -1;
}

function isOnLastLogicalLine(textarea: HTMLTextAreaElement): boolean {
  return textarea.value.indexOf("\n", textarea.selectionEnd) === -1;
}

const PROVIDER_LABELS: Record<ProviderType, string> = {
  "custom-provider": "Custom",
  "github-copilot": "GitHub Copilot",
  "azure-foundry": "Azure Foundry",
};

/**
 * A provider is "configured" when its saved profile carries enough to route a
 * request: the custom provider needs an inline endpoint + key, the protected
 * providers (Copilot / Azure Foundry) surface a stored-credential flag or a
 * selected model. Unconfigured providers are hidden from the composer picker.
 */
function isProviderConfigured(
  provider: ProviderType,
  cfg: ProviderConfig | undefined,
): boolean {
  if (!cfg) return false;
  switch (provider) {
    case "custom-provider":
      return Boolean(cfg.endpoint?.trim() && cfg.api_key?.trim());
    case "github-copilot":
      return Boolean(cfg.api_key_stored || cfg.model?.trim());
    case "azure-foundry":
      return Boolean(
        cfg.endpoint?.trim() &&
          (cfg.api_key_stored || (cfg.azure_deployments?.length ?? 0) > 0),
      );
  }
}

export default function Composer({
  onSend,
  disabled,
  settings,
  onModelChange,
  approveForMe = false,
  onToggleApprove,
  slash,
  loading = false,
  onCancel,
  composerRef,
}: Props) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretFrameRef = useRef<number | null>(null);
  const promptHistoryRef = useRef<PromptHistoryState>({
    entries: [],
    index: null,
    draft: "",
  });

  const cancelPendingCaretPlacement = () => {
    if (caretFrameRef.current === null) return;
    cancelAnimationFrame(caretFrameRef.current);
    caretFrameRef.current = null;
  };

  const resetPromptHistoryNavigation = () => {
    cancelPendingCaretPlacement();
    promptHistoryRef.current.index = null;
    promptHistoryRef.current.draft = "";
  };

  const showPromptHistoryText = (next: string) => {
    cancelPendingCaretPlacement();
    setText(next);
    caretFrameRef.current = requestAnimationFrame(() => {
      caretFrameRef.current = null;
      const textarea = textareaRef.current;
      if (!textarea || textarea.value !== next) return;
      textarea.focus();
      textarea.setSelectionRange(next.length, next.length);
    });
  };

  const recordPromptHistory = (prompt: string) => {
    const history = promptHistoryRef.current;
    if (prompt && history.entries[0] !== prompt) {
      history.entries = [prompt, ...history.entries].slice(
        0,
        PROMPT_HISTORY_LIMIT,
      );
    }
    resetPromptHistoryNavigation();
  };

  const navigatePromptHistoryUp = (textarea: HTMLTextAreaElement): boolean => {
    const history = promptHistoryRef.current;
    if (
      history.entries.length === 0 ||
      !hasCollapsedSelection(textarea) ||
      !isOnFirstLogicalLine(textarea)
    ) {
      return false;
    }

    if (history.index === null) {
      history.draft = text;
      history.index = 0;
    } else {
      history.index = Math.min(history.index + 1, history.entries.length - 1);
    }
    showPromptHistoryText(history.entries[history.index]);
    return true;
  };

  const navigatePromptHistoryDown = (
    textarea: HTMLTextAreaElement,
  ): boolean => {
    const history = promptHistoryRef.current;
    if (
      history.index === null ||
      !hasCollapsedSelection(textarea) ||
      !isOnLastLogicalLine(textarea)
    ) {
      return false;
    }

    if (history.index === 0) {
      const draft = history.draft;
      resetPromptHistoryNavigation();
      showPromptHistoryText(draft);
    } else {
      history.index -= 1;
      showPromptHistoryText(history.entries[history.index]);
    }
    return true;
  };

  useEffect(
    () => () => {
      cancelPendingCaretPlacement();
    },
    [],
  );

  // Slash-command autocomplete state. Independent from the model picker
  // (`open`); the two menus are mutually exclusive (opening the slash menu is
  // driven purely by the textarea contents, and the picker is a separate popover
  // that is not shown while typing a `/…` command).
  const [slashActive, setSlashActive] = useState(0);
  const query = slash ? slashQuery(text) : null;
  const slashOpen = query !== null;
  const slashMatches = useMemo(
    () => (query !== null ? filterCommands(query) : []),
    [query],
  );

  // Keep the highlighted index in range as the filtered list changes.
  useEffect(() => {
    setSlashActive((i) =>
      slashMatches.length === 0
        ? 0
        : Math.min(i, slashMatches.length - 1),
    );
  }, [slashMatches.length]);

  // Auto-grow the textarea to fit its content so multi-line input is fully
  // visible without the top lines scrolling out of view. The CSS `max-height`
  // still caps the growth and re-enables the scrollbar for very long input.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Expose a minimal imperative API so the parent can prefill the composer
  // (e.g. clicking an argument command in the help panel).
  useImperativeHandle(
    composerRef,
    () => ({
      setText: (next: string) => {
        resetPromptHistoryNavigation();
        setText(next);
        // Focus + move caret to end so the user can start typing the argument.
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(next.length, next.length);
        });
      },
      insertText: (next: string) => {
        resetPromptHistoryNavigation();
        setText((current) => {
          if (!current) return next;
          return `${current.replace(/\s*$/, "")}\n${next}`;
        });
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          const end = el.value.length;
          el.setSelectionRange(end, end);
        });
      },
      addImage: (image: ImageAttachment) => {
        resetPromptHistoryNavigation();
        setImages((current) => [...current, image]);
        requestAnimationFrame(() => textareaRef.current?.focus());
      },
    }),
    [],
  );

  const activeProvider = settings?.active_provider ?? "custom-provider";
  const activeModel = settings?.ai_model ?? "";
  const activeConfig = settings?.provider_configs?.[activeProvider];

  // Only providers with a usable saved profile appear in the picker.
  const providerOptions = (
    Object.keys(PROVIDER_LABELS) as ProviderType[]
  ).filter((p) =>
    isProviderConfigured(p, settings?.provider_configs?.[p]),
  );

  // Run a resolved slash command and clear the composer. Model-picker commands
  // (`openModelMenu`) bridge to this component's own picker state.
  const runCommand = (cmd: SlashCommand, arg: string) => {
    if (!slash) return;
    if (cmd.enabled && !cmd.enabled(slash)) return;
    const ctx: SlashContext = {
      ...slash,
      openModelMenu: () => setOpen(true),
    };
    void cmd.run(ctx, arg);
    resetPromptHistoryNavigation();
    setText("");
    setSlashActive(0);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    // Intercept recognized slash commands before they reach the model. Unknown
    // `/foo` falls through to a normal send (matchCommand returns null).
    if (slash) {
      const matched = matchCommand(trimmed);
      if (matched) {
        runCommand(matched.cmd, matched.arg);
        return;
      }
    }
    if (disabled) return;
    if (images.length > 0) onSend(text, images);
    else onSend(text);
    recordPromptHistory(trimmed);
    setText("");
    setImages([]);
  };

  // Pick the highlighted command from the autocomplete menu. If the command
  // takes an argument, complete the text to `/name ` and keep typing rather
  // than firing immediately; otherwise run it now.
  const pickSlash = (cmd: SlashCommand) => {
    if (!slash) return;
    if (cmd.kind === "argument") {
      resetPromptHistoryNavigation();
      setText(`/${cmd.name} `);
      setSlashActive(0);
      textareaRef.current?.focus();
      return;
    }
    runCommand(cmd, "");
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

  // Fetch the model list for the active provider when the picker opens or the
  // provider changes. Each provider has its own discovery path, so clear the
  // previous provider's models first — a switch must never show another
  // provider's list while the new one loads.
  useEffect(() => {
    if (!open) return;
    setModels([]);
    if (!activeConfig) return;
    let active = true;

    if (activeProvider === "github-copilot") {
      // Copilot's endpoint/key live in the OS credential store (blank in the
      // config view), so the generic /models probe can't be used. Use the
      // dedicated Copilot discovery command instead.
      invoke<CopilotModel[]>("list_copilot_models")
        .then((list) => {
          if (!active) return;
          setModels(
            Array.isArray(list) ? list.map((m) => m.id).sort() : [],
          );
        })
        .catch(() => {
          if (active) setModels([]);
        });
      return () => {
        active = false;
      };
    }

    if (activeProvider === "azure-foundry") {
      // Azure models are the configured deployment mappings, not a network
      // probe — surface the mapped model names directly.
      const names = (activeConfig.azure_deployments ?? [])
        .map((m) => m.model.trim())
        .filter(Boolean)
        .sort();
      setModels(names);
      return () => {
        active = false;
      };
    }

    // Custom provider: probe the configured endpoint for its model list.
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
        {images.length > 0 ? (
          <div className="composer2__attachments" aria-label="Attachments">
            {images.map((image) => (
              <div className="composer2__attachment" key={image.id}>
                <img src={image.data_url} alt={image.name} />
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  title="Remove attachment"
                  onClick={() => {
                    resetPromptHistoryNavigation();
                    setImages((current) =>
                      current.filter((item) => item.id !== image.id),
                    );
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {slashOpen ? (
          <SlashMenu
            commands={slashMatches}
            activeIndex={slashActive}
            idPrefix="slash-opt"
            onHover={setSlashActive}
            onPick={pickSlash}
          />
        ) : null}
        <textarea
          ref={textareaRef}
          className="composer2__input"
          value={text}
          onChange={(e) => {
            resetPromptHistoryNavigation();
            setText(e.target.value);
          }}
          aria-expanded={slashOpen}
          aria-controls="slash-menu"
          aria-autocomplete="list"
          aria-activedescendant={
            slashOpen && slashMatches.length > 0
              ? `slash-opt-${slashActive}`
              : undefined
          }
          onKeyDown={(e) => {
            if (slashOpen && slashMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashActive((i) => (i + 1) % slashMatches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashActive(
                  (i) => (i - 1 + slashMatches.length) % slashMatches.length,
                );
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                resetPromptHistoryNavigation();
                setText("");
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pickSlash(slashMatches[slashActive]);
                return;
              }
            }
            const nativeEvent = e.nativeEvent;
            const historyArrow = e.key === "ArrowUp" || e.key === "ArrowDown";
            if (
              historyArrow &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !nativeEvent.isComposing &&
              nativeEvent.keyCode !== 229
            ) {
              const consumed =
                e.key === "ArrowUp"
                  ? navigatePromptHistoryUp(e.currentTarget)
                  : navigatePromptHistoryDown(e.currentTarget);
              if (consumed) {
                e.preventDefault();
                return;
              }
            }
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

          <div
            className={`composer2__picker${open ? " is-open" : ""}`}
            ref={menuRef}
          >
            <button
              type="button"
              className="composer2__model"
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              title="Select provider and model"
            >
              <span className="composer2__model-name">
                {activeModel || "Select model"}
              </span>
              <span aria-hidden="true" className="composer2__model-caret">
                ▾
              </span>
            </button>
            {open ? (
              <div className="composer2__menu" role="listbox">
                <div className="composer2__menu-group">Provider</div>
                {providerOptions.map((p) => (
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

          {loading && onCancel ? (
            <button
              type="button"
              className="composer2__send composer2__cancel"
              aria-label="Cancel run"
              title="Stop the running task"
              onClick={onCancel}
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              className="composer2__send"
              aria-label="Send"
              onClick={submit}
              disabled={disabled}
            >
              ↑
            </button>
          )}
        </div>
      </div>
      <p className="composer2__disclaimer">
        AI-generated content may be incorrect
      </p>
    </div>
  );
}
