#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const SAFE = /\b(read|query|list|get|describe|search|inspect|show|count|status|summary|find|lookup|report|view)\b/i;
const UNSAFE = /\b(create|update|delete|remove|deploy|stop|start|restart|write|modify|terminate|scale|purge|send|execute|reboot|apply|change|rotate|grant|revoke)\b/i;
const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|credential)/i;

function parseArgs(argv) {
  const opts = { dryRun: false, timeout: 180, port: 4444, connection: "", skill: "", question: "", binary: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!(key in opts)) throw new Error(`unknown option: ${arg}`);
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      opts[key] = ["timeout", "port"].includes(key) ? Number(value) : value;
    } else throw new Error(`unexpected argument: ${arg}`);
  }
  return opts;
}

function usage() {
  return `Usage: node .claude/skills/a2a-live-e2e/scripts/run.mjs [options]\n\n` +
    `  --dry-run              Discover cards and derive safe questions only\n` +
    `  --connection <text>    Filter connection id/name\n` +
    `  --skill <text>         Filter skill id/name\n` +
    `  --question <text>      Override the generated question\n` +
    `  --binary <path>        Tauri application binary\n` +
    `  --timeout <seconds>    Per-question timeout (default: 180)\n` +
    `  --port <number>        tauri-driver port (default: 4444)\n`;
}

function commandExists(command) {
  const probe = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item),
  ]));
}

function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "_");
}

function shortHash(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function toolName(connectionId, skillId) {
  const prefix = sanitize(connectionId).slice(0, 8);
  const skill = sanitize(skillId);
  const name = `${prefix}__${skill}`;
  if (name.length <= 64) return name;
  const budget = 64 - prefix.length - 2 - 1 - 8;
  return `${prefix}__${skill.slice(0, budget)}_${shortHash(skillId)}`;
}

function skillText(skill) {
  return [skill.id, skill.name, skill.description, ...(skill.tags ?? []), ...(skill.examples ?? [])]
    .filter(Boolean).join(" ");
}

function isReadOnly(skill) {
  const text = skillText(skill);
  return SAFE.test(text) && !UNSAFE.test(text);
}

function deriveQuestion(skill) {
  const example = Array.isArray(skill.examples) ? skill.examples.find((v) => typeof v === "string") : "";
  if (example) return example;
  const description = String(skill.description ?? "").trim();
  const name = String(skill.name ?? skill.id ?? "the advertised information").trim();
  return description
    ? `Using the ${name} capability, ${description.replace(/^[A-Z]/, (c) => c.toLowerCase())}. Return only read-only information and do not change anything.`
    : `Use the ${name} capability to show its current read-only status. Do not change anything.`;
}

async function fetchJson(url, token, timeoutMs = 20_000) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function discover(connection) {
  const base = String(connection.endpoint).replace(/\/$/, "");
  const attempts = ["/.well-known/agent-card.json", "/.well-known/agent.json"];
  const errors = [];
  for (const suffix of attempts) {
    try {
      return { card: await fetchJson(`${base}${suffix}`, connection.token), url: `${base}${suffix}` };
    } catch (error) {
      errors.push(`${suffix}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; "));
}

function runId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function webdriver(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.value?.error) {
    throw new Error(payload.value?.message ?? `WebDriver ${method} ${path} failed: HTTP ${response.status}`);
  }
  return payload.value;
}

async function waitForDriver(base, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`tauri-driver exited with code ${child.exitCode}`);
    try {
      await fetch(`${base}/status`, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {}
    await delay(250);
  }
  throw new Error("timed out waiting for tauri-driver");
}

async function execute(sessionUrl, script, args = [], async = false) {
  return webdriver(sessionUrl, "POST", async ? "/execute/async" : "/execute/sync", { script, args });
}

async function findElement(sessionUrl, selector) {
  const value = await webdriver(sessionUrl, "POST", "/element", { using: "css selector", value: selector });
  return value[ELEMENT_KEY];
}

async function findElements(sessionUrl, selector) {
  const values = await webdriver(sessionUrl, "POST", "/elements", { using: "css selector", value: selector });
  return values.map((value) => value[ELEMENT_KEY]);
}

async function waitForElement(sessionUrl, selector, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await findElement(sessionUrl, selector); } catch { await delay(250); }
  }
  throw new Error(`timed out waiting for ${selector}`);
}

async function installEventCapture(sessionUrl) {
  await execute(sessionUrl, `
    const done = arguments[arguments.length - 1];
    window.__A2A_E2E_EVENTS__ = [];
    const names = ['agent://tool-call','agent://tool-result','agent://done','agent://error','agent://tool-approval-request'];
    Promise.all(names.map(name => window.__TAURI__.event.listen(name, event => {
      window.__A2A_E2E_EVENTS__.push({ name, payload: event.payload, at: Date.now() });
    }))).then(unlisten => {
      window.__A2A_E2E_UNLISTEN__ = unlisten;
      return window.__TAURI__.window.getCurrentWindow().show();
    }).then(() => window.__TAURI__.window.getCurrentWindow().setFocus())
      .then(() => done(true)).catch(error => done({ error: String(error) }));
  `, [], true);
}

async function collectEvents(sessionUrl) {
  return execute(sessionUrl, "return window.__A2A_E2E_EVENTS__ || [];");
}

async function screenshot(sessionUrl, path) {
  const base64 = await webdriver(sessionUrl, "GET", "/screenshot");
  writeFileSync(path, Buffer.from(base64, "base64"));
}

async function visibleAssistantText(sessionUrl) {
  const elements = await findElements(sessionUrl, ".bubble.assistant .content");
  if (!elements.length) return "";
  return webdriver(sessionUrl, "GET", `/element/${elements.at(-1)}/text`);
}

function eventError(events) {
  return events.find((event) => event.name === "agent://error");
}

async function driveQuestion(sessionUrl, item, timeoutSeconds, artifactDir, index) {
  await execute(sessionUrl, "window.__A2A_E2E_EVENTS__ = [];");
  const input = await waitForElement(sessionUrl, 'textarea[placeholder="Message the agent"]');
  await webdriver(sessionUrl, "POST", `/element/${input}/clear`);
  await webdriver(sessionUrl, "POST", `/element/${input}/value`, { text: item.question, value: [...item.question] });
  await screenshot(sessionUrl, join(artifactDir, `${index + 1}-sent.png`));
  await webdriver(sessionUrl, "POST", `/element/${input}/value`, { text: "", value: [""] });

  const started = Date.now();
  const deadline = started + timeoutSeconds * 1_000;
  let events = [];
  let approvalHandled = false;
  while (Date.now() < deadline) {
    events = await collectEvents(sessionUrl);
    const approval = events.find((event) => event.name === "agent://tool-approval-request");
    if (approval && !approvalHandled) {
      if (approval.payload?.tool !== item.toolName) {
        throw new Error(`unexpected approval request for ${approval.payload?.tool ?? "unknown tool"}`);
      }
      const approve = await waitForElement(sessionUrl, '.approval[role="dialog"] button', 5_000);
      await webdriver(sessionUrl, "POST", `/element/${approve}/click`, {});
      approvalHandled = true;
    }
    if (events.some((event) => event.name === "agent://done" || event.name === "agent://error")) break;
    await delay(500);
  }
  const answer = await visibleAssistantText(sessionUrl).catch(() => "");
  await screenshot(sessionUrl, join(artifactDir, `${index + 1}-answered.png`));

  const toolCall = events.find((event) => event.name === "agent://tool-call" && event.payload?.tool === item.toolName);
  const toolResult = events.find((event) => event.name === "agent://tool-result" && (!toolCall?.payload?.call_id || event.payload?.call_id === toolCall.payload.call_id));
  const done = events.find((event) => event.name === "agent://done");
  const error = eventError(events);
  const resultText = String(toolResult?.payload?.result ?? "");
  const passed = Boolean(toolCall && toolResult && !/^error:/i.test(resultText.trim()) && done && String(done.payload ?? "").trim() && answer.trim() && !error);
  return {
    ...item,
    passed,
    latencyMs: Date.now() - started,
    answer,
    error: error ? `${error.name}: ${JSON.stringify(redact(error.payload))}` : (Date.now() >= deadline ? "timeout" : ""),
    events,
  };
}

function writeReports(artifactDir, metadata, results, skipped, status, failure = "") {
  const summary = {
    status,
    cardsRetrievedFirst: metadata.cards,
    binary: metadata.binary,
    driver: metadata.driver,
    results: results.map(({ events, ...result }) => result),
    skipped,
    failure,
  };
  writeFileSync(join(artifactDir, "result.json"), JSON.stringify(summary, null, 2));
  const eventLines = results.flatMap((result, index) => result.events.map((event) => JSON.stringify({ questionIndex: index + 1, ...redact(event) })));
  writeFileSync(join(artifactDir, "events.jsonl"), `${eventLines.join("\n")}${eventLines.length ? "\n" : ""}`);
  writeFileSync(join(artifactDir, "transcript.md"), results.map((result, i) => `## ${i + 1}. ${result.question}\n\n**Tool:** \`${result.toolName}\`\n\n**Answer:**\n\n${result.answer || "_(none)_"}\n`).join("\n"));
  const rows = results.map((result) => `| ${result.question.replace(/\|/g, "\\|")} | \`${result.toolName}\` | ${result.passed ? "yes" : "no"} | ${result.answer ? "yes" : "no"} | ${result.passed ? "PASS" : "FAIL"} |`).join("\n");
  const report = `## A2A live E2E\n\n**Verdict:** ${status}\n\n**Cards retrieved first:** ${metadata.cards.map((card) => card.connection).join(", ") || "none"}\n\n**Native UI:** ${metadata.binary || "not launched"}\n\n| Question | A2A tool | Tool result | Visible answer | Verdict |\n|---|---|---|---|---|\n${rows || "| _(none)_ | — | — | — | BLOCKED |"}\n\n**Skipped unsafe/ambiguous skills:** ${skipped.map((item) => `${item.connection}/${item.skill}`).join(", ") || "none"}\n\n**Artifacts:** ${artifactDir}\n\n**Failure/remediation:** ${failure || "none"}\n`;
  writeFileSync(join(artifactDir, "report.md"), report);
  return report;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(usage());
  if (!Number.isFinite(opts.timeout) || opts.timeout < 1) throw new Error("--timeout must be a positive number");

  const repo = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), "../../../..");
  const settingsPath = join(homedir(), ".config", "omni-agent-desktop", "settings.json");
  if (!existsSync(settingsPath)) throw new Error(`settings not found: ${settingsPath}`);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const filter = (value, needle) => !needle || String(value).toLowerCase().includes(String(needle).toLowerCase());
  const connections = (settings.a2a_connections ?? []).filter((connection) => connection.enabled && (filter(connection.id, opts.connection) || filter(connection.name, opts.connection)));
  if (!connections.length) throw new Error("no enabled A2A connections matched the requested filter");

  const artifactDir = join(repo, ".artifacts", "a2a-live-e2e", runId());
  mkdirSync(artifactDir, { recursive: true });
  const discovered = [];
  const failures = [];
  for (const connection of connections) {
    try {
      const { card, url } = await discover(connection);
      const redacted = redact(card);
      writeFileSync(join(artifactDir, `card-${sanitize(connection.id || connection.name)}.json`), JSON.stringify(redacted, null, 2));
      discovered.push({ connection, card, url });
      console.log(`[card] ${connection.name || connection.id}: ${url} (${card.skills?.length ?? 0} skills)`);
    } catch (error) {
      failures.push(`${connection.name || connection.id}: ${error.message}`);
    }
  }
  if (!discovered.length) {
    writeReports(artifactDir, { cards: [], binary: "", driver: "" }, [], [], "BLOCKED", failures.join("; "));
    throw new Error(`no agent card could be retrieved; see ${artifactDir}`);
  }

  const selected = [];
  const skipped = [];
  for (const { connection, card } of discovered) {
    for (const skill of card.skills ?? []) {
      const id = skill.id || skill.name;
      if (!id || connection.disabled_skills?.includes(id) || !(filter(id, opts.skill) || filter(skill.name, opts.skill))) continue;
      const item = { connection: connection.name || connection.id, skill: id };
      if (!isReadOnly(skill)) { skipped.push(item); continue; }
      selected.push({ ...item, toolName: toolName(connection.id, id), question: opts.question || deriveQuestion(skill) });
    }
  }
  if (!selected.length) {
    const failure = "no clearly read-only card skills matched; unsafe or ambiguous skills were skipped";
    writeReports(artifactDir, { cards: discovered.map(({ connection, url }) => ({ connection: connection.name || connection.id, url })), binary: "", driver: "" }, [], skipped, "BLOCKED", failure);
    throw new Error(`${failure}; see ${artifactDir}`);
  }

  const metadata = {
    cards: discovered.map(({ connection, url, card }) => ({ connection: connection.name || connection.id, url, skills: card.skills?.length ?? 0 })),
    binary: "",
    driver: "tauri-driver",
  };
  writeFileSync(join(artifactDir, "questions.json"), JSON.stringify({ selected, skipped }, null, 2));
  if (opts.dryRun) {
    const report = writeReports(artifactDir, metadata, [], skipped, "DRY-RUN", "UI not launched by request");
    console.log(report);
    return;
  }

  const binary = resolve(repo, opts.binary || "src-tauri/target/release/omni-agent-desktop.exe");
  metadata.binary = binary;
  const missing = [];
  if (!existsSync(binary)) missing.push(`application binary missing; run make or pass --binary`);
  if (!commandExists("tauri-driver")) missing.push("tauri-driver missing; run: cargo install tauri-driver --locked");
  if (process.platform === "win32" && !commandExists("msedgedriver")) missing.push("msedgedriver missing from PATH; install the version matching Edge/WebView2");
  if (missing.length) {
    writeReports(artifactDir, metadata, [], skipped, "BLOCKED", missing.join("; "));
    throw new Error(`${missing.join("; ")}; see ${artifactDir}`);
  }

  const driverLog = createWriteStream(join(artifactDir, "driver.log"), { flags: "a" });
  const driver = spawn("tauri-driver", ["--port", String(opts.port)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  driver.stdout.pipe(driverLog);
  driver.stderr.pipe(driverLog);
  const base = `http://127.0.0.1:${opts.port}`;
  let sessionId = "";
  const results = [];
  try {
    await waitForDriver(base, driver);
    const session = await webdriver(base, "POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application: binary } } },
    });
    sessionId = session.sessionId;
    const sessionUrl = `${base}/session/${sessionId}`;
    await waitForElement(sessionUrl, 'textarea[placeholder="Message the agent"]');
    await installEventCapture(sessionUrl);
    for (let i = 0; i < selected.length; i += 1) {
      const result = await driveQuestion(sessionUrl, selected[i], opts.timeout, artifactDir, i);
      results.push(result);
      console.log(`[${result.passed ? "PASS" : "FAIL"}] ${result.connection}/${result.skill} -> ${result.toolName}`);
      if (!result.passed) break;
    }
    const status = results.length === selected.length && results.every((result) => result.passed) ? "PASS" : "FAIL";
    const report = writeReports(artifactDir, metadata, results, skipped, status);
    console.log(report);
    if (status !== "PASS") process.exitCode = 1;
  } catch (error) {
    const report = writeReports(artifactDir, metadata, results, skipped, "BLOCKED", error.message);
    console.error(report);
    process.exitCode = 1;
  } finally {
    if (sessionId) await webdriver(base, "DELETE", `/session/${sessionId}`).catch(() => {});
    driver.kill();
    driverLog.end();
  }
}

main().catch((error) => {
  console.error(`[a2a-live-e2e] ${error.message}`);
  process.exitCode = 1;
});
