/**
 * agent-core entrypoint. Registers every RPC method the Rust shell may call
 * and blocks on stdin.
 */
import { RpcServer } from "./rpc.js";
import { configDir, settingsPath } from "./paths.js";
import {
  a2aToolDefinition,
  delegate,
  fetchCard,
  toolsFromCard,
  type A2aTool,
} from "./a2a.js";
import {
  appendDailyLog,
  getMemory,
  readStartupMemory,
  saveMemory,
} from "./memory.js";
import { approvals, type ApprovalDecision } from "./approvals.js";
import { isLocal, isMutatingLocal, makeToolRunner, runOnce } from "./run.js";
import {
  clearCopilotTokenCache,
} from "./providers/copilot.js";
import {
  connectWithToken,
  pollDeviceOnce,
  startDeviceFlow,
} from "./providers/copilot-auth.js";
import { pickProvider } from "./providers/router.js";
import {
  deleteSecret,
  frontendView,
  getSecret,
  redactSecretsForPersist,
  restoreSecrets,
} from "./secrets.js";
import { SchedulerDriver, createTask, deleteTask, listTasks, updateTask } from "./scheduler.js";
import type { Msg } from "./providers/types.js";
import {
  loadSettings,
  projectCompatibilityFields,
  saveSettings as persistSettings,
  validateProvider,
  type AppSettings,
  type ProviderConfig,
  type RunMode,
} from "./settings.js";
import {
  deleteSession,
  listProjects,
  listSessions,
  loadConversation,
  loadSession,
  saveConversation,
  saveProjects,
  saveSession,
} from "./sessions.js";

const server = new RpcServer();
const PROTOCOL_VERSION = 1;

/**
 * System prompt following harness-guide.com principles: plan-before-act, tool
 * discipline, verification, honest failure reporting, respect for the RunMode
 * safety gate. The user's cross-session memory is appended when present.
 */
function buildSystemPrompt(mode: RunMode, memory: string): string {
  const gateNote =
    mode === "plan"
      ? "You are in PLAN mode. Do not call any mutating tool (write/edit/bash/A2A). Draft a plan and produce read-only analysis only."
      : mode === "ask"
        ? "You are in ASK mode. Every mutating tool call requires explicit user approval before it runs — the harness will surface the request."
        : "You are in AUTOPILOT mode. Mutating tool calls are auto-approved; be conservative and prefer the narrowest tool that solves the step.";
  return [
    "You are Omni Agent, running in a desktop shell.",
    "",
    "Follow these operating principles (per harness-guide.com):",
    "1. PLAN BEFORE ACTING. State a brief plan before invoking tools for any non-trivial task; decompose complex work into steps.",
    "2. TOOL DISCIPLINE. Call a tool only when it materially advances the task. One purpose per call. Prefer the narrowest tool that solves the step.",
    "3. VERIFY RESULTS. Inspect tool output; do not assume success. Re-check the artifact you changed before declaring the task done.",
    "4. MANAGE CONTEXT. Retain only task-relevant state. Summarize prior results when useful; do not re-read what you already know.",
    "5. RESPECT GUARDRAILS. Honor the active RunMode (see below). If an action is out of scope, stop and ask instead of forcing it.",
    "6. GATE RISKY ACTIONS. Destructive or irreversible operations must be surfaced clearly and, in Ask mode, wait for approval.",
    "7. REPORT FAILURES HONESTLY. Never fabricate success. State uncertainty. If a tool returned an error, surface it and adjust — do not silently retry the same call.",
    "8. ITERATE IN A CONTROLLED LOOP. Observe → decide → act → re-evaluate. Stop when the user's task is complete; do not chase tangents.",
    "",
    gateNote,
    "",
    memory ? `# Persistent memory\n${memory}\n` : "",
  ].join("\n");
}


// --- handshake -------------------------------------------------------------
server.register("hello", () => ({ protocol: PROTOCOL_VERSION, name: "agent-core", version: "0.1.0" }));
server.register("ping", (params) => ({ pong: true, echo: params ?? null }));

// --- settings --------------------------------------------------------------
async function loadHydratedSettings(): Promise<AppSettings> {
  const s = loadSettings();
  await restoreSecrets(s);
  return s;
}

server.register("settings.get", async () => frontendView(loadSettings()));

server.register("settings.save", async (params) => {
  const s = params as AppSettings;
  // Validate against the incoming (frontend) view before touching secrets.
  const active = s.provider_configs?.[s.active_provider] ?? {} as ProviderConfig;
  const copilotStored = (await getSecret("github-copilot.token"))?.length ?? 0;
  const v = validateProvider(s.active_provider, active, copilotStored > 0);
  if (!v.ok) throw new Error(v.message);
  await redactSecretsForPersist(s);
  projectCompatibilityFields(s);
  const saved = persistSettings(settingsPath(), s);
  return frontendView(saved);
});

server.register("settings.set_hotkey", async (params) => {
  const { hotkey } = params as { hotkey: string };
  const s = loadSettings();
  s.hotkey = hotkey;
  persistSettings(settingsPath(), s);
  return { ok: true };
});

// --- memory ----------------------------------------------------------------
server.register("memory.get", () => ({ content: getMemory() }));
server.register("memory.save", (params) => {
  const { content } = params as { content: string };
  saveMemory(content);
  return { ok: true };
});

// --- secrets (Copilot only exposed; Azure key managed via settings save) ----
server.register("copilot.status", async () => {
  const token = await getSecret("github-copilot.token");
  return { connected: !!token && token.length > 0 };
});

server.register("copilot.start_device_flow", async () => startDeviceFlow());

server.register("copilot.poll_device_flow", async (params) => {
  const { device_code } = params as { device_code: string };
  return pollDeviceOnce(device_code);
});

server.register("copilot.connect_with_token", async (params) => {
  const { token } = params as { token: string };
  await connectWithToken(token);
  clearCopilotTokenCache();
  return { ok: true };
});

server.register("copilot.disconnect", async () => {
  await deleteSecret("github-copilot.token");
  clearCopilotTokenCache();
  return { ok: true };
});

// list models: for Copilot ask the /models endpoint; else return the configured
// model as the single option (frontend handles Azure enumeration via mappings).
server.register("copilot.list_models", async () => {
  const token = await getSecret("github-copilot.token");
  if (!token) return { models: [] };
  // Refreshing the short-lived token happens through the provider; we don't
  // duplicate that logic here — the frontend already caches the last-known list.
  return { models: [] };
});

// --- azure -----------------------------------------------------------------
server.register("azure.test_connection", async (params) => {
  const cfg = params as ProviderConfig;
  try {
    const url = `${cfg.endpoint.replace(/\/+$/, "")}/openai/v1/models?api-version=${encodeURIComponent(
      cfg.azure_api_version || "2024-02-01",
    )}`;
    const r = await (await import("undici")).fetch(url, {
      headers: { "api-key": cfg.api_key },
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

// --- sessions / projects / conversation ------------------------------------
server.register("sessions.list", () => listSessions());
server.register("sessions.load", (params) => {
  const { id } = params as { id: string };
  return loadSession(id);
});
server.register("sessions.save", (params) => {
  const { id, messages, title } = params as { id: string; messages: unknown[]; title?: string };
  saveSession(id, messages, title);
  return { ok: true };
});
server.register("sessions.delete", (params) => {
  const { id } = params as { id: string };
  return { ok: deleteSession(id) };
});
server.register("projects.list", () => listProjects());
server.register("projects.save", (params) => {
  const { projects } = params as { projects: unknown[] };
  saveProjects(projects);
  return { ok: true };
});
server.register("conversation.load", () => loadConversation());
server.register("conversation.save", (params) => {
  saveConversation(params);
  return { ok: true };
});

// list_models fallback: for the OpenAI-compatible endpoint just echo an empty
// list; the frontend also allows manual typing. Full provider probing lives in
// the individual provider modules if we later want to enumerate.
server.register("models.list", () => ({ models: [] }));

// --- A2A -------------------------------------------------------------------
server.register("a2a.discover_card", async (params) => {
  // Accept either { connectionId } (legacy — frontend still uses this name)
  // or { endpoint, token } (direct). Legacy resolves through saved settings.
  const p = (params ?? {}) as { connectionId?: string; endpoint?: string; token?: string };
  let endpoint = p.endpoint;
  let token = p.token ?? "";
  if (!endpoint && p.connectionId) {
    const settings = loadSettings();
    const conn = settings.a2a_connections.find((c) => c.id === p.connectionId);
    if (!conn) throw new Error(`no a2a connection with id ${p.connectionId}`);
    endpoint = conn.endpoint;
    token = conn.token;
  }
  if (!endpoint) throw new Error("a2a.discover_card: endpoint or connectionId required");
  process.stderr.write(`agent-core: a2a.discover_card endpoint=${endpoint}\n`);
  const card = await fetchCard(endpoint, token);
  return card; // Return the card directly (frontend reads card.skills).
});

// --- approvals -------------------------------------------------------------
server.register("agent.approve", (params) => {
  const { call_id, decision } = params as { call_id: string; decision: ApprovalDecision };
  const ok = approvals.resolve(call_id, decision);
  return { ok };
});

// --- agent run -------------------------------------------------------------
server.register("agent.run", async (params, emit) => {
  const { message, mode, history } = params as {
    message: string;
    mode?: RunMode;
    history?: Msg[];
  };
  try {
    const settings = await loadHydratedSettings();
    const runMode: RunMode = mode ?? settings.run_mode ?? "ask";
    const copilotToken = (await getSecret("github-copilot.token")) ?? null;

    // Discover A2A tools from every enabled connection.
    const a2aTools: A2aTool[] = [];
    for (const conn of settings.a2a_connections) {
      if (!conn.enabled) continue;
      try {
        const card = await fetchCard(conn.endpoint, conn.token);
        a2aTools.push(...toolsFromCard(conn, card));
      } catch (e) {
        emit("agent://thought", { text: `[a2a] ${conn.name}: ${(e as Error).message}` });
      }
    }
    const a2aByName = new Map(a2aTools.map((t) => [t.tool_name, t]));

    // Merge local + A2A tool definitions.
    const { toolDefinitions } = await import("./tools.js");
    const toolDefs = [...toolDefinitions(), ...a2aTools.map(a2aToolDefinition)];

    // Assemble the seed message list: startup memory becomes the system prompt;
    // history + latest user message become the running conversation.
    const startupMemory = readStartupMemory(configDir());
    const system = buildSystemPrompt(runMode, startupMemory);
    const messages: Msg[] = [
      ...(history ?? []),
      { role: "user", content: message },
    ];

    const provider = pickProvider(settings, copilotToken);
    const runTool = makeToolRunner(async (name, args) => {
      const tool = a2aByName.get(name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      return delegate(tool, args);
    });

    const outcome = await runOnce({
      mode: runMode,
      system,
      messages,
      toolDefs,
      maxIterations: settings.ai_max_tool_iterations,
      isA2A: (n) => a2aByName.has(n),
      isMutating: (n) => isMutatingLocal(n) || (!isLocal(n) && a2aByName.has(n)),
      provider,
      runTool,
      emit,
    });
    appendDailyLog(configDir(), `agent replied (${outcome.text.length} chars)`);
    emit("agent://done", { text: outcome.text });
    return outcome;
  } catch (e) {
    emit("agent://error", { message: (e as Error).message });
    throw e;
  }
});

// --- scheduler -------------------------------------------------------------
const driver = new SchedulerDriver(
  async (task) => {
    // A scheduled fire is just an agent.run with no history.
    const settings = await loadHydratedSettings();
    const copilotToken = (await getSecret("github-copilot.token")) ?? null;
    const provider = pickProvider(settings, copilotToken);
    const { toolDefinitions } = await import("./tools.js");
    const runTool = makeToolRunner(async () => {
      throw new Error("A2A skills are not available in headless scheduled runs (no approval channel)");
    });
    await runOnce({
      mode: settings.run_mode ?? "autopilot",
      system: "Omni Agent (scheduled).",
      messages: [{ role: "user", content: task.prompt }],
      toolDefs: toolDefinitions(),
      maxIterations: settings.ai_max_tool_iterations,
      isA2A: () => false,
      isMutating: isMutatingLocal,
      provider,
      runTool,
      emit: (event, data) => server.emit(event, data),
    });
  },
  (event, data) => server.emit(event, data),
);
driver.start();

server.register("scheduler.list", () => listTasks());
server.register("scheduler.create", (params) => createTask(params as Parameters<typeof createTask>[0]));
server.register("scheduler.update", (params) => {
  const { id, patch } = params as { id: string; patch: Partial<Parameters<typeof updateTask>[1]> };
  return updateTask(id, patch);
});
server.register("scheduler.delete", (params) => {
  const { id } = params as { id: string };
  return { ok: deleteTask(id) };
});
server.register("scheduler.run_now", async (params) => {
  const { id } = params as { id: string };
  await driver.runNow(id);
  return { ok: true };
});
server.register("scheduler.cancel", (params) => {
  // Cancellation of an already-running task isn't tracked at fine grain in
  // this port; the RPC exists for parity with the frontend command. Consider a
  // per-run AbortController if the frontend needs mid-run cancellation.
  const { id } = params as { id: string };
  return { ok: !!id };
});

// --- boot ------------------------------------------------------------------
process.stderr.write(`agent-core: ready (protocol=${PROTOCOL_VERSION})\n`);
server.serve().catch((e) => {
  process.stderr.write(`agent-core: fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
