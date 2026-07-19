import { describe, expect, it } from "bun:test";
import { ApprovalRegistry } from "./approvals.js";

describe("ApprovalRegistry", () => {
  it("resolves a pending approval by id", async () => {
    const reg = new ApprovalRegistry();
    const p = reg.wait("run-a:call_1");
    expect(reg.resolve("run-a:call_1", "approve")).toBe(true);
    expect(await p).toBe("approve");
  });

  it("returns false when resolving an unknown id", () => {
    const reg = new ApprovalRegistry();
    expect(reg.resolve("nope", "approve")).toBe(false);
  });

  it("SECURITY: namespaced ids from different runs do not cross-settle", async () => {
    const reg = new ApprovalRegistry();
    // Two concurrent runs each with provider call id "call_1", namespaced by run.
    const a = reg.wait("run-a:call_1");
    const b = reg.wait("run-b:call_1");
    // Resolving run-a must not settle run-b.
    reg.resolve("run-a:call_1", "deny");
    expect(await a).toBe("deny");
    expect(reg.has("run-b:call_1")).toBe(true); // still pending
    reg.resolve("run-b:call_1", "approve");
    expect(await b).toBe("approve");
  });

  it("SECURITY: rejects a duplicate pending id instead of overwriting", () => {
    const reg = new ApprovalRegistry();
    reg.wait("run-a:call_1").catch(() => {});
    // A second wait on the same id would previously orphan the first resolver.
    expect(() => reg.wait("run-a:call_1")).toThrow(/already pending/);
    // Original entry is intact and still settleable.
    expect(reg.resolve("run-a:call_1", "approve")).toBe(true);
  });
});
