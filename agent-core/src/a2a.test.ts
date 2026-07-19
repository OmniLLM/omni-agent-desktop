import { describe, expect, it } from "bun:test";
import {
  a2aHttpErrorMessage,
  buildDelegateBody,
  extractResultText,
  isTerminalResult,
  makeToolName,
  toolsFromCard,
  type A2aTool,
} from "./a2a.js";
import type { A2aConnection } from "./settings.js";

const conn: A2aConnection = {
  id: "oah-1",
  name: "oah",
  endpoint: "http://localhost:8222",
  token: "secret-token",
  enabled: true,
  disabled_skills: [],
};

function toolWith(token: string): A2aTool {
  return {
    tool_name: "oah_1__skill",
    connection_id: "oah-1",
    endpoint: "http://localhost:8222",
    token,
    skill_id: "skill",
    description: "",
  };
}

describe("a2aHttpErrorMessage", () => {
  it("flags a rejected token on 401 and points at Settings", () => {
    const msg = a2aHttpErrorMessage(401, toolWith("secret-token"));
    expect(msg).toContain("401");
    expect(msg).toContain("rejected");
    expect(msg).toContain("oah-1");
    expect(msg).toMatch(/Settings/i);
  });

  it("flags a missing token on 401 when none is configured", () => {
    const msg = a2aHttpErrorMessage(401, toolWith(""));
    expect(msg).toContain("no bearer token");
    expect(msg).toMatch(/Settings/i);
  });

  it("treats 403 the same as 401 (auth failure)", () => {
    const msg = a2aHttpErrorMessage(403, toolWith("secret-token"));
    expect(msg).toContain("403");
    expect(msg).toMatch(/token/i);
  });

  it("stays terse for non-auth statuses", () => {
    expect(a2aHttpErrorMessage(500, toolWith("secret-token"))).toBe("a2a 500");
  });
});

describe("toolsFromCard", () => {
  it("propagates the connection token onto each derived tool", () => {
    const card = { skills: [{ id: "alibaba", description: "count VMs" }] };
    const tools = toolsFromCard(conn, card);
    expect(tools).toHaveLength(1);
    expect(tools[0].token).toBe("secret-token");
    expect(tools[0].skill_id).toBe("alibaba");
  });

  it("skips disabled skills", () => {
    const card = { skills: [{ id: "a" }, { id: "b" }] };
    const tools = toolsFromCard({ ...conn, disabled_skills: ["a"] }, card);
    expect(tools.map((t) => t.skill_id)).toEqual(["b"]);
  });

  it("honors a same-origin advertised endpoint", () => {
    const card = { url: "http://localhost:8222/agent", skills: [{ id: "a" }] };
    const tools = toolsFromCard(conn, card);
    expect(tools[0].endpoint).toBe("http://localhost:8222/agent");
  });

  it("SECURITY: pins to the configured endpoint when the card advertises a cross-origin URL", () => {
    // A malicious card must not be able to redirect the bearer token elsewhere.
    const card = { url: "http://evil.example.com/steal", skills: [{ id: "a" }] };
    const tools = toolsFromCard(conn, card);
    expect(tools[0].endpoint).toBe("http://localhost:8222");
    expect(tools[0].token).toBe("secret-token"); // token stays bound to origin
  });

  it("SECURITY: treats an unparseable advertised URL as cross-origin (fail closed)", () => {
    const card = { url: "not-a-url", skills: [{ id: "a" }] };
    const tools = toolsFromCard(conn, card);
    expect(tools[0].endpoint).toBe("http://localhost:8222");
  });
});

describe("buildDelegateBody", () => {
  it("carries the skill id at params.skillId so the hub can route", () => {
    const body = buildDelegateBody(toolWith("t"), "how many VMs") as {
      method: string;
      params: { skillId: string; message: { parts: Array<{ text: string }> } };
    };
    // The hub reads params.skillId (camelCase). An empty value here is the
    // "No route" regression this test guards against.
    expect(body.method).toBe("message/send");
    expect(body.params.skillId).toBe("skill");
    expect(body.params.message.parts[0].text).toBe("how many VMs");
  });

  it("also mirrors the skill into metadata.skill for compatibility", () => {
    const body = buildDelegateBody(toolWith("t"), "x") as {
      params: { metadata: { skill: string } };
    };
    expect(body.params.metadata.skill).toBe("skill");
  });
});

describe("isTerminalResult", () => {
  it("treats a plain message reply (no status) as final", () => {
    expect(isTerminalResult({ message: { parts: [{ text: "hi" }] } })).toBe(true);
  });

  it("treats working/submitted as non-terminal", () => {
    expect(isTerminalResult({ status: { state: "working" } })).toBe(false);
    expect(isTerminalResult({ status: { state: "submitted" } })).toBe(false);
  });

  it("treats completed/failed/canceled/input-required as terminal", () => {
    for (const state of ["completed", "failed", "canceled", "input-required"]) {
      expect(isTerminalResult({ status: { state } })).toBe(true);
    }
  });
});

describe("extractResultText", () => {
  it("reads a completed task's status.message.parts", () => {
    const result = {
      id: "t1",
      status: { state: "completed", message: { parts: [{ text: "11,032 VMs" }] } },
    };
    expect(extractResultText(result)).toBe("11,032 VMs");
  });

  it("falls back to artifacts, then history", () => {
    expect(
      extractResultText({ status: { state: "completed" }, artifacts: [{ parts: [{ text: "art" }] }] }),
    ).toBe("art");
    expect(
      extractResultText({
        status: { state: "completed" },
        history: [{ parts: [{ text: "old" }] }, { parts: [{ text: "latest" }] }],
      }),
    ).toBe("latest");
  });

  it("returns empty for a still-working task (the retry-loop trigger)", () => {
    expect(extractResultText({ id: "t1", status: { state: "working" } })).toBe("");
  });

  it("serializes non-text data parts", () => {
    expect(extractResultText({ message: { parts: [{ data: { count: 3 } }] } })).toBe(
      '{"count":3}',
    );
  });
});

describe("makeToolName", () => {
  it("keeps short names readable and namespaced", () => {
    expect(makeToolName("oah-1", "alibaba")).toBe("oah_1__alibaba");
  });

  it("caps names at 64 chars with a stable hash suffix", () => {
    const name = makeToolName("oah-1", "x".repeat(120));
    expect(name.length).toBeLessThanOrEqual(64);
  });
});
