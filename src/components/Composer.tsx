import { useState } from "react";

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
  model?: string;
  projectName?: string | null;
  onChooseProject?: () => void;
  approveForMe?: boolean;
  onToggleApprove?: (value: boolean) => void;
}

export default function Composer({
  onSend,
  disabled,
  model,
  projectName,
  onChooseProject,
  approveForMe = false,
  onToggleApprove,
}: Props) {
  const [text, setText] = useState("");

  const submit = () => {
    if (text.trim()) {
      onSend(text);
      setText("");
    }
  };

  return (
    <div className="composer2">
      <div className="composer2__meta">
        <button
          type="button"
          className="composer2__chip"
          onClick={onChooseProject}
        >
          <span aria-hidden="true">▤</span>
          <span>{projectName ?? "Choose project"}</span>
        </button>
        <span className="composer2__plugins">
          <span aria-hidden="true">◎</span> Plugins
        </span>
      </div>

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
          placeholder="Do anything"
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
          <span className="composer2__model" title="Active model">
            {model || "default"}
          </span>
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
    </div>
  );
}
