/**
 * Real-TypeSafe acceptance probe (network!):
 *  1. does the server accept & answer the 5th question? (classifyRequest parse)
 *  2. A/B latency: identical payload with 4 questions (pre-B) vs 5 (B)
 *  3. token cost of the 5th question (usage delta → per-question pricing check)
 *
 * Bundle+run via: npx esbuild test/latency.ts --bundle --packages=external \
 *   --platform=node --format=esm --outfile=node_modules/.cache/jev-latency.mjs \
 *   && node node_modules/.cache/jev-latency.mjs
 */
import { buildQuestions, classifyRequest } from "../extensions/pi-jev-model-router/jev";
import { loadConfig, resolveApiKey } from "../extensions/pi-jev-model-router/config";
import { resolveThinking } from "../extensions/pi-jev-model-router/router";

const config = loadConfig();
const cred = resolveApiKey();
if (!cred) {
  console.error("no API key (TYPESAFE_API_KEY / pi-typesafe auth)");
  process.exit(1);
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const allQuestions = buildQuestions();
const fourQuestions = Object.fromEntries(Object.entries(allQuestions).filter(([name]) => name !== "thinking_level"));

async function post(questions: Record<string, unknown>, request: string): Promise<{ ms: number; body: any }> {
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${cred!.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: { request, conversation_excerpt: null }, model: config.jevModel, questions }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const ms = Date.now() - started;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return { ms, body: await res.json() };
}

// ── 1. parse acceptance via the real code path ────────────────────────────────
const PARSE_PROMPT = "Refactor the JSON config loader to add environment-variable overrides with validation.";
console.log("— classifyRequest (5-question path) —");
let parseOk = 0;
try {
  const a = await classifyRequest({ prompt: PARSE_PROMPT }, config, cred.key);
  const resolved = resolveThinking(a, undefined, "standard");
  console.log(
    `  kind=${a.kind} cx=${a.complexity.toFixed(2)} cap=${a.budgetIntensity.toFixed(2)} ` +
      `thinking=${a.thinkingLevel ?? "MISSING"} (conf ${a.thinkingConfidence?.toFixed(2)}) ` +
      `→ resolved=${resolved.level}/${resolved.source} · ${a.latencyMs}ms · ` +
      `usage=${a.usage ? `${a.usage.input_tokens}/${a.usage.output_tokens}` : "n/a"}`,
  );
  if (a.thinkingLevel) parseOk = 1;
} catch (error) {
  console.log(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
}

// ── 2+3. A/B: 4 questions (pre-B) vs 5 questions (B), same request text ──────
const AB_PROMPTS = [
  "Design a rate limiter for a multi-tenant API gateway with strict p99 targets.",
  "Why does my Docker container exit with code 137 after a few minutes?",
  "Write a short release-notes blurb for v0.5.0 of a CLI tool.",
  "Diagnose the flaky test that fails 1 in 20 runs on CI only.",
  "Rename the variable and fix the lint errors in auth.ts.",
];
console.log("\n— A/B latency (4Q pre-B vs 5Q B, alternating, same prompts) —");
const lat4: number[] = [];
const lat5: number[] = [];
const tok4: number[] = [];
const tok5: number[] = [];
for (const prompt of AB_PROMPTS) {
  try {
    const r4 = await post(fourQuestions, prompt);
    const r5 = await post(allQuestions, prompt);
    lat4.push(r4.ms);
    lat5.push(r5.ms);
    const u4 = r4.body?.usage?.input_tokens;
    const u5 = r5.body?.usage?.input_tokens;
    if (typeof u4 === "number") tok4.push(u4);
    if (typeof u5 === "number") tok5.push(u5);
    const think5 = r5.body?.answers?.thinking_level?.choice ?? "MISSING";
    console.log(
      `  4Q ${String(r4.ms).padStart(4)}ms  5Q ${String(r5.ms).padStart(4)}ms  ` +
        `Δin=${typeof u4 === "number" && typeof u5 === "number" ? u5 - u4 : "?"} tok  thinking=${think5}`,
    );
  } catch (error) {
    console.log(`  A/B FAIL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const stats = (xs: number[]) =>
  xs.length === 0
    ? "n/a"
    : `min/med/max = ${Math.min(...xs)}/${[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]}/${Math.max(...xs)}ms`;
const avg = (xs: number[]) => (xs.length === 0 ? NaN : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));
console.log(`\n4Q: ${stats(lat4)}   avg input tok ${avg(tok4)}`);
console.log(`5Q: ${stats(lat5)}   avg input tok ${avg(tok5)}`);
console.log(`thinking_level parsed on real path: ${parseOk ? "yes" : "NO"} · Δinput tok ≈ ${avg(tok5) - avg(tok4)} (5th question overhead)`);
