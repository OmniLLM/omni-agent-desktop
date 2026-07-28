/**
 * Live end-to-end skill exercise against a real A2A hub.
 *
 * This is NOT part of `npm test`. It needs a running hub, a real provider
 * token, and it spends real API calls and minutes of wall clock, so it is
 * opt-in via `npm run e2e:live` (see package.json).
 *
 * What it does, per the three-step design:
 *   1. Discover the skills the configured A2A connection actually exposes.
 *   2. Randomly sample from a READ-ONLY allowlist of those skills.
 *   3. Drive the real agent-core binary with a prompt per skill and assert the
 *      skill was invoked and produced a result within a deadline.
 *
 * SAFETY -- why sampling is allowlisted rather than uniform over all skills:
 * the hub exposes destructive tools (gitops-* push/rebase/prune, file_write,
 * shell_exec, process_manager, system_settings). Randomly triggering those
 * would mutate real repositories and the host machine. Only skills that are
 * read-only by nature are eligible, and the allowlist is a positive list -- a
 * newly added skill is excluded until someone reviews it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const BIN =
  process.env.OMNI_AGENT_BIN ??
  "src-tauri/binaries/agent-core-x86_64-pc-windows-msvc.exe";

/** How many skills to sample per run. Override with E2E_SAMPLE. */
const SAMPLE = Number(process.env.E2E_SAMPLE ?? 3);
/** Per-prompt deadline. Cloud sweeps legitimately take minutes. */
const DEADLINE_MS = Number(process.env.E2E_DEADLINE_MS ?? 300_000);

/**
 * Read-only skills eligible for random sampling, with a prompt that should
 * drive the model to that specific skill. Keyed by the skill id suffix as it
 * appears in the agent card.
 */
const SAFE_SKILLS: Record<string, string> = {
  alibaba: "how many ECS instances (VMs) are in alibaba cloud right now?",
  aws: "how many EC2 instances are in aws right now?",
  azure: "how many virtual machines are in azure right now?",
  gcp: "how many compute engine VMs are in gcp right now?",
  inventory: "using the inventory skill, how many servers are in the entity inventory?",
  ldap: "using the ldap skill, look up the LDAP group 'domain admins' and report how many members it has",
  netbox: "using the netbox skill, how many devices are recorded in netbox?",
  translator: "using the translator skill, translate 'good morning, how are you?' into French",
  "web-summarizer": "using the web-summarizer skill, summarize https://example.com in one sentence",
  "code-helper":
    "using the code-helper skill, explain what this does: const x = [1,2,3].reduce((a,b)=>a+b,0)",
};

interface Ev {
  event?: string;
  data?: Record<string, unknown>;
  id?: number;
  result?: unknown;
  error?: unknown;
}

/** One driven agent.run against the real binary. */
class Driver {
  private readonly proc: ChildProcessWithoutNullStreams;
  private id = 1;
  private readonly pending = new Map<number, (m: Ev) => void>();
  readonly toolCalls: string[] = [];
  readonly toolResults: Array<{ tool: string; result: string }> = [];
  readonly warnings: string[] = [];

  constructor(bin: string) {
    this.proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    // Drain stderr so the child never blocks on a full pipe.
    this.proc.stderr.resume();
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      let m: Ev;
      try {
        m = JSON.parse(line) as Ev;
      } catch {
        return;
      }
      if (m.event) {
        const d = m.data ?? {};
        if (m.event === "agent://tool-call") this.toolCalls.push(String(d.tool));
        else if (m.event === "agent://tool-result")
          this.toolResults.push({ tool: String(d.tool), result: String(d.result) });
        else if (m.event === "agent://warning") this.warnings.push(String(d.text));
        return;
      }
      if (typeof m.id === "number") {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      }
    });
  }

  call(method: string, params: unknown): Promise<Ev> {
    const rid = this.id++;
    this.proc.stdin.write(JSON.stringify({ id: rid, method, params }) + "\n");
    return new Promise((res) => this.pending.set(rid, res));
  }

  kill(): void {
    this.proc.kill();
  }
}

function sample<T>(items: T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length) {
    out.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }
  return out;
}

async function main(): Promise<void> {
  // --- Step 1: discover what the configured connection actually exposes. ----
  // loadSettings (not the index.ts hydrated variant, which boots an RPC
  // server) reads the same settings.json the app uses.
  const { loadSettings } = await import("../agent-core/src/settings.js");
  const { fetchCard, toolsFromCard } = await import("../agent-core/src/a2a.js");
  const settings = loadSettings();
  const conns = settings.a2a_connections.filter((c) => c.enabled);
  if (!conns.length) throw new Error("no enabled A2A connections in settings");

  const discovered: string[] = [];
  for (const conn of conns) {
    const tools = toolsFromCard(conn, await fetchCard(conn.endpoint, conn.token));
    console.log(`discovered ${tools.length} tools from "${conn.name}" (${conn.endpoint})`);
    discovered.push(...tools.map((t) => t.skill_id));
  }

  // --- Step 2: sample from the read-only allowlist ∩ what's live. -----------
  const eligible = Object.keys(SAFE_SKILLS).filter((k) =>
    discovered.some((id) => id.endsWith(`:${k}`)),
  );
  const skipped = Object.keys(SAFE_SKILLS).filter((k) => !eligible.includes(k));
  if (skipped.length) console.log(`not exposed by this hub, skipping: ${skipped.join(", ")}`);
  if (!eligible.length) throw new Error("no allowlisted skills are exposed by the hub");

  const picked = sample(eligible, Math.min(SAMPLE, eligible.length));
  console.log(`\nsampled ${picked.length} of ${eligible.length} eligible skills: ${picked.join(", ")}\n`);

  // --- Step 3: drive each prompt and assert the skill fired and answered. ---
  const failures: string[] = [];
  for (const skill of picked) {
    const prompt = SAFE_SKILLS[skill];
    const d = new Driver(BIN);
    await new Promise((r) => setTimeout(r, 1200));
    const t0 = Date.now();
    process.stdout.write(`── ${skill}\n   prompt: ${prompt}\n`);

    const res = await Promise.race([
      d.call("agent.run", {
        message: prompt,
        mode: "autopilot",
        history: [],
        session: `e2e-${skill}`,
      }),
      new Promise<Ev>((r) =>
        setTimeout(() => r({ error: `deadline ${DEADLINE_MS}ms exceeded` }), DEADLINE_MS),
      ),
    ]);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // The skill must have been invoked...
    const hit = d.toolCalls.find((t) => t.includes(skill.replace(/-/g, "_")));
    // ...and produced a non-empty, non-error result.
    const result = d.toolResults.find((r) => r.tool === hit);
    const answer =
      res.result && typeof res.result === "object" && "text" in res.result
        ? String((res.result as { text: unknown }).text)
        : "";

    if (res.error) {
      failures.push(`${skill}: run failed — ${JSON.stringify(res.error).slice(0, 200)}`);
      console.log(`   FAIL (${secs}s) ${JSON.stringify(res.error).slice(0, 200)}\n`);
    } else if (!hit) {
      // This is the exact regression this suite exists to catch: the model
      // announced the work but never called the tool.
      failures.push(
        `${skill}: never invoked (tools called: ${d.toolCalls.join(", ") || "none"}) — answer: "${answer.slice(0, 120)}"`,
      );
      console.log(`   FAIL (${secs}s) skill never invoked. called: ${d.toolCalls.join(", ") || "none"}\n`);
    } else if (!result || !result.result.trim() || /^error:/i.test(result.result)) {
      failures.push(`${skill}: invoked but returned no usable result`);
      console.log(`   FAIL (${secs}s) invoked but empty/error result\n`);
    } else {
      console.log(`   PASS (${secs}s) via ${hit}`);
      console.log(`   answer: ${answer.slice(0, 160).replace(/\s+/g, " ")}\n`);
    }
    d.kill();
  }

  console.log("═".repeat(60));
  if (failures.length) {
    console.log(`FAILED ${failures.length}/${picked.length}`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`PASSED ${picked.length}/${picked.length} sampled skills`);
}

main().catch((e) => {
  console.error(`e2e harness error: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
