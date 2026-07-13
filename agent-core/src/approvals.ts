/**
 * Pending-approval registry. Foreground runs create an entry per tool call and
 * await the resolver; the frontend calls `agent.approve` with a decision, which
 * settles the promise. Runs must not stall forever, so entries also carry a
 * default-deny timeout controlled by the caller.
 */
export type ApprovalDecision = "approve" | "deny" | "allow_session";

export class ApprovalRegistry {
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>();

  wait(callId: string): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(callId, resolve);
    });
  }

  resolve(callId: string, decision: ApprovalDecision): boolean {
    const r = this.pending.get(callId);
    if (!r) return false;
    this.pending.delete(callId);
    r(decision);
    return true;
  }
}

export const approvals = new ApprovalRegistry();
