import type { ToolCallEvent } from "../types/app";

export default function ToolApprovalPrompt({
  call,
  onDecide,
}: {
  call: ToolCallEvent;
  onDecide: (d: "approve" | "deny" | "allow_session") => void;
}) {
  return (
    <div className="approval" role="dialog" aria-label="Tool approval">
      <p>
        <strong>{call.tool}</strong> wants to run:
      </p>
      <pre>{JSON.stringify(call.args, null, 2)}</pre>
      <button onClick={() => onDecide("approve")}>Approve</button>
      <button onClick={() => onDecide("allow_session")}>
        Always this session
      </button>
      <button onClick={() => onDecide("deny")}>Deny</button>
    </div>
  );
}
