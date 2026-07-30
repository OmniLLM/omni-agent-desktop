/**
 * Live end-to-end test of the calendar path:
 *
 *   user prompt  ->  A2A hub  ->  OmniLauncher agent  ->  workiq MCP
 *
 * This is NOT part of `npm test`. Like `e2e-live-skills.ts` it needs a running
 * hub, a reachable OmniLauncher upstream and a real workiq/Graph session, so it
 * is opt-in via `npm run e2e:workiq`.
 *
 * It deliberately drives `agent-core`'s own `fetchCard`/`toolsFromCard`/
 * `delegate` rather than raw HTTP, so a regression in the desktop's A2A client
 * fails this test too — the point is to exercise the path the app actually uses.
 *
 * WHY THIS TEST EXISTS -- two real failure modes it pins down:
 *
 *   1. The skill is NOT called "workiq". Sending skillId "workiq" gets
 *      `Tool not found: workiq` from the upstream. The real ids are
 *      `plugin:tool:mcp_workiq_*` (ask, fetch, get_schema, search_paths, ...),
 *      namespaced by the hub to `omnilauncher.plugin:tool:mcp_workiq_ask`.
 *      A rename upstream silently breaks the desktop; this test catches it.
 *
 *   2. Card discovery can go out of sync with routing. The hub has been
 *      observed routing to omnilauncher skills correctly while omitting them
 *      from the composite agent card it serves — which means the model never
 *      sees the tool even though calling it works. So this test asserts
 *      DISCOVERY separately from INVOCATION, and reports which one broke.
 *
 * READ-ONLY: `mcp_workiq_ask` only queries the calendar. No entity create/
 * update/delete tool is exercised here, by design.
 */
import { fetchCard, toolsFromCard, delegate, type A2aTool } from "../agent-core/src/a2a.js";
import { loadSettings } from "../agent-core/src/settings.js";

/** Suffix of the workiq skill to exercise. Override with E2E_WORKIQ_SKILL. */
const SKILL_SUFFIX = process.env.E2E_WORKIQ_SKILL ?? "mcp_workiq_ask";
/** The prompt a user would type into the launcher. */
const PROMPT = process.env.E2E_WORKIQ_PROMPT ?? "my upcoming meetings tomorrow";
/** Calendar round-trips through Graph take ~20s; allow generous headroom. */
const DEADLINE_MS = Number(process.env.E2E_DEADLINE_MS ?? 180_000);

function fail(msg: string): never {
  console.error(`\nFAIL  ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const conns = settings.a2a_connections.filter((c) => c.enabled);
  if (!conns.length) fail("no enabled A2A connections in settings");

  // --- Step 1: discovery. Can the desktop even SEE the workiq skill? --------
  // This is the half that has broken before while routing still worked.
  const discovered: A2aTool[] = [];
  for (const conn of conns) {
    const tools = toolsFromCard(conn, await fetchCard(conn.endpoint, conn.token));
    console.log(`discovered ${tools.length} tools from "${conn.name}" (${conn.endpoint})`);
    discovered.push(...tools);
  }

  const workiq = discovered.filter((t) => t.skill_id.includes("mcp_workiq"));
  if (!workiq.length) {
    fail(
      `no workiq skills in the agent card (${discovered.length} tools discovered). ` +
        `The hub may be routing to omnilauncher without advertising its skills, ` +
        `so the model can never choose this tool.`,
    );
  }
  console.log(`found ${workiq.length} workiq skills: ${workiq.map((t) => t.skill_id).join(", ")}`);

  const tool = workiq.find((t) => t.skill_id.endsWith(SKILL_SUFFIX));
  if (!tool) {
    fail(
      `"${SKILL_SUFFIX}" not exposed. Available workiq skills: ` +
        workiq.map((t) => t.skill_id).join(", "),
    );
  }

  // --- Step 2: invocation. Does the full chain answer the calendar prompt? --
  console.log(`\n── ${tool.skill_id}\n   prompt: ${PROMPT}`);
  const t0 = Date.now();
  let answer: string;
  try {
    answer = await delegate(tool, { task: PROMPT }, DEADLINE_MS);
  } catch (e) {
    fail(`delegate threw after ${((Date.now() - t0) / 1000).toFixed(1)}s — ${(e as Error).message}`);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!answer.trim()) fail(`empty answer after ${secs}s`);

  // The upstream returns "Tool not found: <x>" as a FAILED task, which delegate
  // already raises on. This guards the case where it comes back as plain text.
  if (/tool not found/i.test(answer)) fail(`upstream rejected the skill — ${answer.slice(0, 200)}`);

  // A calendar answer should reference meetings/events or say the day is clear.
  // Kept loose on purpose: asserting specific meeting titles would make the
  // test depend on whoever's calendar is configured.
  if (!/meeting|event|calendar|schedul|no .*(meeting|event)/i.test(answer)) {
    fail(`answer doesn't look like a calendar result (${secs}s) — "${answer.slice(0, 200)}"`);
  }

  console.log(`\nPASS (${secs}s) via ${tool.skill_id}`);
  console.log("─".repeat(60));
  console.log(answer.slice(0, 1200));
}

main().catch((e) => {
  console.error(`e2e harness error: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
