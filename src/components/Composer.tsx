import { useState } from "react";
import type { RunMode } from "../types/app";

export default function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string, mode: RunMode) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<RunMode>("ask");
  const submit = () => {
    if (text.trim()) {
      onSend(text, mode);
      setText("");
    }
  };
  return (
    <div className="composer">
      <label>
        Mode
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as RunMode)}
          aria-label="Run mode"
        >
          <option value="plan">Plan</option>
          <option value="ask">Ask</option>
          <option value="autopilot">Autopilot</option>
        </select>
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Ask the agent…"
      />
      <button onClick={submit} disabled={disabled}>
        Send
      </button>
    </div>
  );
}
