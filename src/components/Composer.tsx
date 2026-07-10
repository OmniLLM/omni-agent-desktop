import { useState } from "react";

export default function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    if (text.trim()) {
      onSend(text);
      setText("");
    }
  };
  return (
    <div className="composer">
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
