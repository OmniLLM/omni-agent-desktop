#!/usr/bin/env bun
/**
 * Live GitHub Copilot E2E — endpoint-routing verification.
 *
 * Copilot serves models on two request shapes: OpenAI Chat Completions
 * (POST /chat/completions) and OpenAI Responses (POST /responses). Sending a
 * model to the wrong endpoint yields HTTP 400 `unsupported_api_for_model`.
 * `copilotProvider().infer()` routes per model via the model→shape map in
 * `copilot-model-shapes.ts`. This harness proves the routing end-to-end
 * against the LIVE Copilot API using the token already stored by the app.
 *
 * What it does:
 *   1. Reads the long-lived token from the OS secret store (the same entry the
 *      device-flow login wrote: service "omni-agent-desktop",
 *      name "github-copilot.token"). Never prints it.
 *   2. Calls listCopilotModels() to fetch the live catalog.
 *   3. Buckets every model by its routed shape (chat / responses / messages /
 *      gemini) and picks ONE representative per family the user asked about:
 *      claude, gpt (both chat and responses variants), mai, gemini.
 *   4. Runs a real infer() against each representative with a benign,
 *      deterministic prompt and asserts a non-empty answer came back through
 *      the CORRECT endpoint (a wrong route would 400 and throw).
 *
 * MUST run under Bun (Bun.secrets + Bun-native fetch). Read-only: it only
 * sends a trivial "reply OK" prompt; no tools, no mutations.
 *
 * Usage:
 *   bun agent-core/e2e/copilot-live.mjs
 *   bun agent-core/e2e/copilot-live.mjs --model gpt-5.5 --vision # include image input
 *   bun agent-core/e2e/copilot-live.mjs --max-per-family 2 --json
 *   OMNI_AGENT_INSECURE_TLS=1 bun agent-core/e2e/copilot-live.mjs  # corp proxy
 *
 * Exit codes: 0 all passed · 1 any failed · 2 no token / nothing to test.
 */

// NOTE: --insecure-tls must be honored BEFORE ../src/http.ts is imported,
// because that module reads OMNI_AGENT_INSECURE_TLS once at load time. Set the
// env var here (pre-import) if the flag is present, then import lazily below.
if (process.argv.includes("--insecure-tls")) {
  process.env.OMNI_AGENT_INSECURE_TLS = "1";
}

const { listCopilotModels, copilotProvider } = await import(
  "../src/providers/copilot.ts"
);
const { selectCopilotShape } = await import(
  "../src/providers/copilot-model-shapes.ts"
);

const KEYRING_SERVICE = "omni-agent-desktop";
const TOKEN_NAME = "github-copilot.token";
const PROMPT = 'Reply with exactly the two characters: OK';
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// A sample tool in OpenAI Chat Completions shape — the SAME shape agent-core's
// real run loop passes. Exercising a tool-enabled turn is essential: the
// /responses endpoint needs a FLAT tool schema, and sending the nested Chat
// shape yields 400 `Missing required parameter: 'tools[0].name'`. A text-only
// probe would miss that regression entirely.
const SAMPLE_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Return the current time. Test-only, takes no arguments.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

function parseArgs(argv) {
  const opts = {
    model: "",
    maxPerFamily: 1,
    json: false,
    insecureTls: false,
    vision: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--vision") opts.vision = true;
    else if (a === "--insecure-tls") opts.insecureTls = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--model") opts.model = argv[++i] ?? "";
    else if (a === "--max-per-family") opts.maxPerFamily = Number(argv[++i] ?? 1);
    else throw new Error(`unexpected argument: ${a}`);
  }
  return opts;
}

/** The user-facing family label for a model, independent of routed shape. */
function familyOf(model) {
  const m = String(model).toLowerCase();
  if (m.includes("claude")) return "claude";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("mai")) return "mai";
  if (m.includes("gpt") || /^o[134]/.test(m)) return "gpt";
  return "other";
}

async function readCopilotToken() {
  const bun = globalThis.Bun;
  if (!bun?.secrets?.get) {
    throw new Error(
      "Bun.secrets unavailable — run this harness with `bun`, not node.",
    );
  }
  return bun.secrets.get({ service: KEYRING_SERVICE, name: TOKEN_NAME });
}

/**
 * Pick representative models to exercise. We want coverage of each user-named
 * family AND each routed endpoint, so gpt is split into its chat and responses
 * variants (that split is the whole point of the routing bug).
 */
function pickTargets(models, opts) {
  if (opts.model) {
    const hit = models.find((m) => m.id.toLowerCase() === opts.model.toLowerCase());
    if (!hit) throw new Error(`--model "${opts.model}" not in the live catalog`);
    return [{ id: hit.id, shape: selectCopilotShape(hit.id), family: familyOf(hit.id) }];
  }

  // Bucket by (family, shape) so gpt-chat and gpt-responses are distinct.
  const buckets = new Map();
  for (const m of models) {
    const shape = selectCopilotShape(m.id);
    const key = `${familyOf(m.id)}:${shape}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ id: m.id, shape, family: familyOf(m.id) });
  }

  const targets = [];
  for (const [, list] of buckets) {
    // Prefer shorter ids (usually the canonical model, not a dated snapshot).
    list.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
    for (const t of list.slice(0, Math.max(1, opts.maxPerFamily))) targets.push(t);
  }
  return targets;
}

function makeConfig(model) {
  return {
    endpoint: "",
    api_key: "",
    api_shape: "openai-compatible",
    model,
    azure_deployments: [],
    azure_api_version: "",
    manual_models: "",
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "Usage: bun agent-core/e2e/copilot-live.mjs [--model <id>] [--max-per-family <n>] [--vision] [--insecure-tls] [--json]\n",
    );
    return 0;
  }
  // --insecure-tls is applied pre-import at the top of this file.

  const token = await readCopilotToken();
  if (!token) {
    process.stderr.write(
      "BLOCKED: no Copilot token in the secret store. Connect GitHub Copilot in the app first.\n",
    );
    return 2;
  }

  process.stderr.write("Fetching live Copilot model catalog…\n");
  const models = await listCopilotModels(token);
  if (!models.length) {
    process.stderr.write("BLOCKED: Copilot returned no models.\n");
    return 2;
  }

  const targets = pickTargets(models, opts);
  if (!targets.length) {
    process.stderr.write("BLOCKED: no representative models selected.\n");
    return 2;
  }

  const results = [];
  for (const t of targets) {
    const provider = copilotProvider(makeConfig(t.id), token);
    const endpoint = t.shape === "responses" ? "/responses" : "/chat/completions";
    const started = Date.now();
    try {
      // 1) Text-only turn: proves basic endpoint routing.
      const plain = await provider.infer("You are a terse test probe.", [
        { role: "user", content: PROMPT },
      ], []);
      const text = (plain?.text ?? "").trim();
      if (!text) throw new Error("empty response (text-only turn)");

      // 2) Tool-enabled turn: proves the per-endpoint tool schema is correct.
      // This is the turn that catches the `tools[0].name` 400 on /responses.
      await provider.infer("You are a terse test probe. Use a tool if helpful.", [
        { role: "user", content: "What time is it? Call the tool." },
      ], SAMPLE_TOOLS);

      // 3) Optional vision turn: proves Copilot's /responses image schema.
      if (opts.vision && t.shape !== "responses") {
        throw new Error("--vision requires a responses-model target");
      }
      if (opts.vision) {
        const vision = await provider.infer("You are a terse test probe.", [
          {
            role: "user",
            content: "What is in this image?",
            images: [
              {
                data_url: TINY_PNG,
                mime_type: "image/png",
                name: "pixel.png",
              },
            ],
          },
        ], []);
        if (!(vision?.text ?? "").trim()) {
          throw new Error("empty response (vision turn)");
        }
      }

      results.push({
        model: t.id,
        family: t.family,
        shape: t.shape,
        endpoint,
        pass: true,
        ms: Date.now() - started,
        sample: text.slice(0, 40),
        error: "",
      });
    } catch (e) {
      results.push({
        model: t.id,
        family: t.family,
        shape: t.shape,
        endpoint,
        pass: false,
        ms: Date.now() - started,
        sample: "",
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ total: results.length, passed, failed, results }, null, 2) + "\n",
    );
  } else {
    process.stdout.write("\nCopilot live E2E — endpoint routing\n");
    process.stdout.write("=".repeat(72) + "\n");
    for (const r of results) {
      const mark = r.pass ? "PASS" : "FAIL";
      process.stdout.write(
        `[${mark}] ${r.family.padEnd(7)} ${r.model.padEnd(28)} → ${r.endpoint.padEnd(18)} ${r.ms}ms\n`,
      );
      if (!r.pass) process.stdout.write(`        ${r.error}\n`);
      else if (r.sample) process.stdout.write(`        “${r.sample}”\n`);
    }
    process.stdout.write("=".repeat(72) + "\n");
    process.stdout.write(`${passed}/${results.length} passed\n`);
  }

  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`ERROR: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
