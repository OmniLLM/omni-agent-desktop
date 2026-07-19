/**
 * Pending-approval registry. Foreground runs create an entry per tool call and
 * await the resolver; the frontend calls `agent.approve` with a decision, which
 * settles the promise. Runs must not stall forever, so entries also carry a
 * default-deny timeout controlled by the caller.
 */
export type ApprovalDecision = "approve" | "deny" | "allow_session";

export class ApprovalRegistry {
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>();

  /**
   * Register a pending approval under a globally-unique `approvalId`. Callers
   * MUST namespace the id per run (e.g. `<runId>:<callId>`); a bare provider
   * call id like `call_1` can repeat across concurrent sessions and would
   * otherwise let one session's decision settle another session's tool.
   *
   * Registering a duplicate id is a programming error: it means two runs chose
   * colliding ids, exactly the bug this guard prevents. We reject rather than
   * silently overwrite (which used to leave the first run hung forever).
   */
  wait(approvalId: string): Promise<ApprovalDecision> {
    if (this.pending.has(approvalId)) {
      throw new Error(`approval id already pending: ${approvalId}`);
    }
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(approvalId, resolve);
    });
  }

  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const r = this.pending.get(approvalId);
    if (!r) return false;
    this.pending.delete(approvalId);
    r(decision);
    return true;
  }

  /** True when an approval with this id is currently awaiting a decision. */
  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }
}

export const approvals = new ApprovalRegistry();
