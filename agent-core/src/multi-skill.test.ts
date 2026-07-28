/**
 * Multi-skill orchestration tests.
 *
 * The live harness (`npm run e2e:live`) exercises real skills against a real
 * hub, but it needs a token, a running hub, and minutes of wall clock. These
 * tests cover the same orchestration logic deterministically -- no network --
 * so the regressions stay caught in CI.
 *
 * The scenarios mirror the reported bug: a prompt that needs SEVERAL A2A
 * skills must fan out to all of them and return a synthesized answer, rather
 * than announcing the plan and ending the turn.
 */
import { describe, expect, it } from "bun:test";
import { runOnce } from "./run.js";
import type { Msg, ParsedTurn, Provider } from "./providers/types.js";
import { toolsFromCard, makeToolName } from "./a2a.js";
import type { A2aConnection } from "./settings.js";

const conn: A2aConnection = {
  id: "oah-1",
  name: "oah",
  endpoint: "http://localhost:8222",
  token: "t",
  enabled: true,
  disabled_skills: [],
};

/** A card shaped like the real hub's, with the four cloud skills. */
const CARD = {
  name: "Omni A2A Hub",
  skills: [
    { id: "omnilauncher.skill:alibaba", name: "alibaba", description: "Query Alibaba Cloud" },
    { id: "omnilauncher.skill:aws", name: "aws", description: "Query AWS" },
    { id: "omnilauncher.skill:azure", name: "azure", description: "Query Azure" },
    { id: "omnilauncher.skill:gcp", name: "gcp", description: "Query GCP" },
    { id: "omnilauncher.skill:translator", name: "translator", description: "Translate text" },
  ],
};

const COUNTS: Record<string, string> = {
  [makeToolName(conn.id, "omnilauncher.skill:alibaba")]: "9,840 ECS instances",
  [makeToolName(conn.id, "omnilauncher.skill:aws")]: "1,281 EC2 instances",
  [makeToolName(conn.id, "omnilauncher.skill:azure")]: "490 virtual machines",
  [makeToolName(conn.id, "omnilauncher.skill:gcp")]: "13,001 compute instances",
};

describe("multi-skill orchestration", () => {
  it("discovers every skill the card advertises and namespaces each tool", () => {
    const tools = toolsFromCard(conn, CARD);
    expect(tools).toHaveLength(5);
    // Names must be unique -- a collision would silently drop a skill from the
    // tool list and make it uncallable.
    expect(new Set(tools.map((t) => t.tool_name)).size).toBe(5);
    for (const t of tools) expect(t.tool_name.length).toBeLessThanOrEqual(64);
  });

  it("fans out across four cloud skills in one turn and synthesizes the total", async () => {
    const tools = toolsFromCard(conn, CARD);
    const byName = new Map(tools.map((t) => [t.tool_name, t]));
    const called: string[] = [];
    let turn = 0;

    const provider: Provider = {
      async infer(_s, msgs: Msg[]) {
        turn++;
        if (turn === 1) {
          // All four requested together, as a parallel-capable model does.
          return {
            text: "I'll query all four cloud providers in parallel.",
            tool_calls: Object.keys(COUNTS).map((name, i) => ({
              id: `c${i}`,
              name,
              args: { task: "count VMs" },
            })),
          } as ParsedTurn;
        }
        // Every call must have come back before the model summarizes.
        const results = msgs.filter((m) => m.role === "tool");
        expect(results).toHaveLength(4);
        return { text: "Total: 24,612 VMs across four providers.", tool_calls: [] };
      },
    };

    const out = await runOnce({
      mode: "autopilot",
      system: "s",
      messages: [{ role: "user", content: "how many VMs in gcp, alibaba, azure and aws now?" }],
      toolDefs: tools.map((t) => ({ name: t.tool_name })),
      maxIterations: 10,
      isA2A: (n) => byName.has(n),
      isMutating: (n) => byName.has(n),
      provider,
      runTool: async (name) => {
        called.push(name);
        return COUNTS[name] ?? "unknown";
      },
      emit: () => {},
    });

    expect(called.sort()).toEqual(Object.keys(COUNTS).sort());
    expect(out.text).toContain("24,612");
  });

  it("keeps every tool result paired to its own call id", async () => {
    const tools = toolsFromCard(conn, CARD);
    const byName = new Map(tools.map((t) => [t.tool_name, t]));
    const names = Object.keys(COUNTS);
    let turn = 0;
    let seen: Msg[] = [];

    const provider: Provider = {
      async infer(_s, msgs: Msg[]) {
        turn++;
        if (turn === 1) {
          return {
            text: "",
            tool_calls: names.map((name, i) => ({ id: `call-${i}`, name, args: {} })),
          };
        }
        seen = msgs;
        return { text: "done", tool_calls: [] };
      },
    };

    await runOnce({
      mode: "autopilot",
      system: "s",
      messages: [{ role: "user", content: "count everything" }],
      toolDefs: tools.map((t) => ({ name: t.tool_name })),
      maxIterations: 5,
      isA2A: (n) => byName.has(n),
      isMutating: () => false,
      provider,
      runTool: async (name) => COUNTS[name],
      emit: () => {},
    });

    // Each tool turn carries the id of the call it answers, and the content
    // matches THAT skill's result -- mispairing would attribute Azure's count
    // to AWS without any visible error.
    const requested = seen.find((m) => m.role === "assistant" && m.tool_calls?.length);
    const toolTurns = seen.filter((m) => m.role === "tool");
    expect(toolTurns).toHaveLength(4);
    for (const [i, name] of names.entries()) {
      const call = requested!.tool_calls!.find((c) => c.name === name)!;
      const answer = toolTurns.find((t) => t.tool_call_id === call.id)!;
      expect(answer.content).toBe(COUNTS[name]);
      expect(call.id).toBe(`call-${i}`);
    }
  });

  it("continues with the remaining skills when one of them fails", async () => {
    const tools = toolsFromCard(conn, CARD);
    const byName = new Map(tools.map((t) => [t.tool_name, t]));
    const names = Object.keys(COUNTS);
    const azure = makeToolName(conn.id, "omnilauncher.skill:azure");
    let turn = 0;
    let toolTurns: Msg[] = [];

    const provider: Provider = {
      async infer(_s, msgs: Msg[]) {
        turn++;
        if (turn === 1) {
          return { text: "", tool_calls: names.map((name, i) => ({ id: `c${i}`, name, args: {} })) };
        }
        toolTurns = msgs.filter((m) => m.role === "tool");
        return { text: "3 of 4 providers reported.", tool_calls: [] };
      },
    };

    await runOnce({
      mode: "autopilot",
      system: "s",
      messages: [{ role: "user", content: "count everything" }],
      toolDefs: tools.map((t) => ({ name: t.tool_name })),
      maxIterations: 5,
      isA2A: (n) => byName.has(n),
      isMutating: () => false,
      provider,
      runTool: async (name) => {
        if (name === azure) throw new Error("a2a task failed: subscription throttled");
        return COUNTS[name];
      },
      emit: () => {},
    });

    // A failing skill must surface as an error result the model can react to,
    // not abort the whole run and lose the three successful lookups.
    expect(toolTurns).toHaveLength(4);
    const failed = toolTurns.find((t) => t.content.startsWith("error:"));
    expect(failed?.content).toContain("subscription throttled");
    expect(toolTurns.filter((t) => !t.content.startsWith("error:"))).toHaveLength(3);
  });

  it("gates each A2A skill separately in ask mode", async () => {
    const tools = toolsFromCard(conn, CARD);
    const byName = new Map(tools.map((t) => [t.tool_name, t]));
    const names = Object.keys(COUNTS);
    const approvalsAsked: string[] = [];
    let turn = 0;

    const { approvals } = await import("./approvals.js");
    const provider: Provider = {
      async infer() {
        turn++;
        if (turn === 1) {
          return { text: "", tool_calls: names.map((name, i) => ({ id: `c${i}`, name, args: {} })) };
        }
        return { text: "done", tool_calls: [] };
      },
    };

    const ran: string[] = [];
    await runOnce({
      mode: "ask",
      system: "s",
      messages: [{ role: "user", content: "count everything" }],
      toolDefs: tools.map((t) => ({ name: t.tool_name })),
      maxIterations: 5,
      isA2A: (n) => byName.has(n),
      isMutating: () => false,
      provider,
      approvalTimeoutMs: 5_000,
      runTool: async (name) => {
        ran.push(name);
        return COUNTS[name];
      },
      emit: (event, data) => {
        if (event !== "agent://tool-approval-request") return;
        const d = data as { call_id: string; tool: string };
        approvalsAsked.push(d.tool);
        // Approve the first two, deny the rest.
        const decision = approvalsAsked.length <= 2 ? "approve" : "deny";
        setTimeout(() => approvals.resolve(d.call_id, decision), 5);
      },
    });

    expect(approvalsAsked).toHaveLength(4);
    expect(ran).toHaveLength(2);
  });
});
