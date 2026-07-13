#!/usr/bin/env node

/**
 * Headless A2A hub-skill functional validation.
 *
 * Complements run.mjs (the full Tauri UI harness) with a fast, protocol-level
 * check: for each enabled A2A connection it discovers the agent card, selects
 * clearly read-only skills, and drives the REAL A2A path end to end —
 * `message/send` then polls `tasks/get` until the task reaches a terminal
 * state, then extracts the text result. This is exactly the path
 * agent-core/src/a2a.ts::delegate takes, so it catches regressions like the
 * async-task retry loop (message/send returns "working" with no parts, and a
 * naive client returns empty text and the model retries forever).
 *
 * It NEVER invokes skills whose metadata suggests mutation. Read-only only.
 *
 * Usage:
 *   node .claude/skills/a2a-live-e2e/scripts/validate-skills.mjs [options]
 *     --connection <text>   Filter connection id/name
 *     --skill <text>        Filter skill id/name
 *     --max <n>             Max skills to validate (default: 5)
 *     --timeout <seconds>   Per-skill poll timeout (default: 120)
 *     --json                Print machine-readable JSON summary
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SAFE = /\b(read|query|list|get|describe|search|inspect|show|count|status|summary|find|lookup|report|view)\b/i;
const UNSAFE = /\b(create|update|delete|remove|deploy|stop|start|restart|write|modify|terminate|scale|purge|send|execute|reboot|apply|change|rotate|grant|revoke)\b/i;
const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|credential)/i;
const TERMINAL = new Set(["completed", "canceled", "failed", "input-required"]);
const POLL_INTERVAL_MS = 1500;

function parseArgs(argv) {
  const opts = { connection: "", skill: "", max: 5, timeout: 120, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!(key in opts)) throw new Error(`unknown option: ${arg}`);
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      opts[key] = ["max", "timeout"].includes(key) ? Number(value) : value;
    } else throw new Error(`unexpected argument: ${arg}`);
  }
  return opts;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v)]),
  );
}

function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "_");
}

function skillText(skill) {
  return [skill.id, skill.name, skill.description, ...(skill.tags ?? []), ...(skill.examples ?? [])]
    .filter(Boolean)
    .join(" ");
}

function isReadOnly(skill) {
  const text = skillText(skill);
  return SAFE.test(text) && !UNSAFE.test(text);
}

function deriveQuestion(skill) {
  const example = Array.isArray(skill.examples)
    ? skill.examples.find((v) => typeof v === "string")
    : "";
  if (example) return example;
  const name = String(skill.name ?? skill.id ?? "the advertised information").trim();
  const description = String(skill.description ?? "").trim();
  return description
    ? `Using the ${name} capability, ${description.replace(/^[A-Z]/, (c) => c.toLowerCase())}. Return only read-only information and do not change anything.`
    : `Use the ${name} capability to show its current read-only status. Do not change anything.`;
}

async function rpc(endpoint, token, method, params, timeoutMs = 20_000) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "rpc error");
  return body.result;
}

async function discover(endpoint, token) {
  const base = String(endpoint).replace(/\/$/, "");
  for (const suffix of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
    try {
      const response = await fetch(`${base}${suffix}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response.json();
    } catch {
      /* try next */
    }
  }
  throw new Error("agent card not retrievable");
}

/** Parity with a2a.ts::extractResultText — status.message → artifacts → history. */
function extractText(result) {
  const parts = (arr) =>
    (arr ?? [])
      .map((p) => (typeof p?.text === "string" ? p.text : p?.data !== undefined ? JSON.stringify(p.data) : ""))
      .join("");
  if (!result) return "";
  const direct = parts(result.message?.parts);
  if (direct) return direct;
  const status = parts(result.status?.message?.parts);
  if (status) return status;
  const artifacts = (result.artifacts ?? []).map((a) => parts(a.parts)).filter(Boolean).join("\n");
  if (artifacts) return artifacts;
  const history = result.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = parts(history[i]?.parts);
    if (t) return t;
  }
  return "";
}

/**
 * Runs one skill through the full A2A path and returns a verdict. Mirrors
 * agent-core/src/a2a.ts::delegate so this is a true functional check.
 */
async function validateSkill(connection, skillId, question, timeoutMs) {
  const started = Date.now();
  const send = await rpc(connection.endpoint, connection.token, "message/send", {
    skillId,
    message: { role: "user", parts: [{ type: "text", text: question }] },
    metadata: { skill: skillId },
  });

  let result = send;
  const taskId = result?.id;
  const state = () => result?.status?.state;

  // Poll to terminal, exactly like the client does.
  const deadline = Date.now() + timeoutMs;
  while (taskId && !TERMINAL.has(state() ?? "") && state() !== undefined) {
    if (Date.now() > deadline) {
      return { skillId, ok: false, state: state(), reason: "poll timeout", ms: Date.now() - started };
    }
    await delay(POLL_INTERVAL_MS);
    result = await rpc(connection.endpoint, connection.token, "tasks/get", { id: taskId });
  }

  const finalState = state();
  const text = extractText(result);
  if (finalState === "failed") {
    return { skillId, ok: false, state: finalState, reason: text || "task failed", ms: Date.now() - started };
  }
  if (finalState === "input-required") {
    // A clarifying question is a functional (not broken) response.
    return { skillId, ok: true, state: finalState, preview: text.slice(0, 200), ms: Date.now() - started };
  }
  if (!text) {
    return { skillId, ok: false, state: finalState, reason: "terminal task with empty text (retry-loop trigger)", ms: Date.now() - started };
  }
  return { skillId, ok: true, state: finalState ?? "message", preview: text.replace(/\s+/g, " ").slice(0, 200), ms: Date.now() - started };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("node .claude/skills/a2a-live-e2e/scripts/validate-skills.mjs [--connection x] [--skill y] [--max n] [--timeout s] [--json]");
    return;
  }

  const scriptDir = dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)));
  const repo = resolve(scriptDir, "../../../..");
  const settingsPath = join(homedir(), ".config", "omni-agent-desktop", "settings.json");
  if (!existsSync(settingsPath)) throw new Error(`settings not found: ${settingsPath}`);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

  const match = (value, needle) =>
    !needle || String(value).toLowerCase().includes(String(needle).toLowerCase());
  const connections = (settings.a2a_connections ?? []).filter(
    (c) => c.enabled && (match(c.id, opts.connection) || match(c.name, opts.connection)),
  );
  if (!connections.length) throw new Error("no enabled A2A connections matched the filter");

  const artifactDir = join(repo, ".artifacts", "a2a-validate-skills", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(artifactDir, { recursive: true });

  const results = [];
  const skipped = [];
  for (const connection of connections) {
    const card = await discover(connection.endpoint, connection.token);
    writeFileSync(
      join(artifactDir, `card-${sanitize(connection.id || connection.name)}.json`),
      JSON.stringify(redact(card), null, 2),
    );
    const label = connection.name || connection.id;
    console.log(`[card] ${label}: ${card.skills?.length ?? 0} skills`);

    const candidates = [];
    for (const skill of card.skills ?? []) {
      const id = skill.id || skill.name;
      if (!id || connection.disabled_skills?.includes(id)) continue;
      if (!(match(id, opts.skill) || match(skill.name, opts.skill))) continue;
      if (!isReadOnly(skill)) {
        skipped.push({ connection: label, skill: id });
        continue;
      }
      candidates.push({ id, question: deriveQuestion(skill) });
    }

    for (const { id, question } of candidates.slice(0, opts.max)) {
      process.stdout.write(`[validate] ${label}/${id} … `);
      try {
        const verdict = await validateSkill(connection, id, question, opts.timeout * 1000);
        verdict.connection = label;
        results.push(verdict);
        console.log(verdict.ok ? `PASS (${verdict.state}, ${verdict.ms}ms)` : `FAIL (${verdict.reason})`);
      } catch (error) {
        const verdict = { connection: label, skillId: id, ok: false, reason: error.message, status: error.status };
        results.push(verdict);
        console.log(`FAIL (${error.message})`);
      }
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const summary = { passed, failed, skipped: skipped.length, results, skippedSkills: skipped };
  writeFileSync(join(artifactDir, "result.json"), JSON.stringify(redact(summary), null, 2));

  if (opts.json) {
    console.log(JSON.stringify(redact(summary), null, 2));
  } else {
    console.log(`\n=== A2A skill validation ===`);
    console.log(`passed=${passed} failed=${failed} skipped(unsafe)=${skipped.length}`);
    console.log(`artifacts: ${artifactDir}`);
  }

  if (results.length === 0) {
    console.error("no read-only skills were validated (all filtered or skipped as unsafe)");
    process.exit(2);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
