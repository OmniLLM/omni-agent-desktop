import { describe, expect, it, vi, afterEach } from "vitest";
import { delegateA2aTask, fetchAgentCard } from "./a2aClient";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A2A client", () => {
  it("discovers either a direct A2A agent or a hub through agent-card.json", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://agent.local/.well-known/agent-card.json");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return new Response(JSON.stringify({ name: "Direct Agent", skills: [{ id: "skill:echo" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAgentCard("http://agent.local/", "tok")).resolves.toMatchObject({
      name: "Direct Agent",
      skills: [{ id: "skill:echo" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to legacy agent.json discovery path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "Legacy Agent", skills: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAgentCard("http://agent.local", "")).resolves.toMatchObject({
      name: "Legacy Agent",
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://agent.local/.well-known/agent-card.json",
      "http://agent.local/.well-known/agent.json",
    ]);
  });

  it("delegates the same JSON-RPC message/send and tasks/get flow to direct agents or hubs", async () => {
    const initial = {
      jsonrpc: "2.0",
      id: 1,
      result: { id: "task-1", status: { state: "working" } },
    };
    const done = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        id: "task-1",
        status: {
          state: "completed",
          message: { role: "agent", parts: [{ type: "text", text: "ok from endpoint" }] },
        },
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(initial), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(done), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      delegateA2aTask({
        endpoint: "http://hub-or-agent.local",
        token: "tok",
        task: "say ok",
        skillId: "omnilauncher.skill:echo",
      }),
    ).resolves.toBe("ok from endpoint");

    const [sendUrl, sendInit] = fetchMock.mock.calls[0];
    expect(sendUrl).toBe("http://hub-or-agent.local/");
    expect((sendInit.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const sendBody = JSON.parse(sendInit.body as string);
    expect(sendBody.method).toBe("message/send");
    expect(sendBody.params.message.parts).toEqual([{ type: "text", text: "say ok" }]);
    expect(sendBody.params.skillId).toBe("omnilauncher.skill:echo");

    const getBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(getBody.method).toBe("tasks/get");
    expect(getBody.params.id).toBe("task-1");
  });

  it("sends structured data parts for hub plugin-tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            id: "task-2",
            status: {
              state: "completed",
              message: { role: "agent", parts: [{ type: "text", text: "56088" }] },
            },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      delegateA2aTask({
        endpoint: "http://hub.local",
        token: "tok",
        task: "calculate",
        skillId: "omnilauncher.plugin:tool:calculator",
        data: { expression: "123 * 456" },
      }),
    ).resolves.toBe("56088");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.params.message.parts).toEqual([{ type: "data", data: { expression: "123 * 456" } }]);
  });
});
