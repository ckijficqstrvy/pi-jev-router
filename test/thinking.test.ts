/**
 * B+C acceptance tests: the 5th Jev question (thinking_level), the resolution
 * chain (config pin > Jev > demand ladder > tier default), one-HTTP accounting,
 * and decide() regressions.
 *
 * Run: npm test   (esbuild-bundled, mocked fetch — no network, no pi runtime)
 */
import assert from "node:assert/strict";
import { classifyRequest, type RouteAnalysis } from "../extensions/pi-jev-model-router/jev";
import {
  DEFAULT_CONFIG,
  TIER_THINKING,
  THINKING_LEVELS,
  type JevRouterConfig,
} from "../extensions/pi-jev-model-router/config";
import {
  decide,
  demandScore,
  describeThinking,
  resolveThinking,
  thinkingLadder,
} from "../extensions/pi-jev-model-router/router";
import { emptyLedger, recordJevUsage } from "../extensions/pi-jev-model-router/budget";

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.stack : String(error)}`);
  }
}

function analysis(patch: Partial<RouteAnalysis> = {}): RouteAnalysis {
  return {
    kind: "implement",
    kindConfidence: 0.8,
    kindProbabilities: { implement: 0.8, refactor: 0.1 },
    complexity: 1.5,
    complexityConfidence: 0.7,
    budgetIntensity: 1.5,
    budgetIntensityConfidence: 0.7,
    deepReasoning: 0.5,
    latencyMs: 100,
    ...patch,
  };
}

const FULL_PAYLOAD = {
  answers: {
    task_kind: { choice: "implement", confidence: 0.82, probabilities: { implement: 0.82, refactor: 0.1 } },
    complexity: { score: 1.6, confidence: 0.7 },
    capability_deserved: { score: 1.4, confidence: 0.66 },
    needs_deep_reasoning: { noul: 0.4 },
    thinking_level: { choice: "medium", confidence: 0.78, probabilities: { medium: 0.78 } },
  },
  usage: { input_tokens: 400, output_tokens: 120 },
};

interface MockState {
  calls: number;
  bodies: Array<Record<string, any>>;
  queue: unknown[];
}

const mock: MockState = { calls: 0, bodies: [], queue: [] };

function installMockFetch(): void {
  (globalThis as Record<string, unknown>).fetch = async (_url: unknown, init?: { body?: string }) => {
    mock.calls += 1;
    if (init?.body) mock.bodies.push(JSON.parse(init.body));
    const payload = mock.queue.length > 0 ? mock.queue.shift() : FULL_PAYLOAD;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function main(): Promise<void> {
  installMockFetch();
  const config: JevRouterConfig = DEFAULT_CONFIG;

  await test("precedence: config pin beats Jev's judgment", () => {
    const a = analysis({ thinkingLevel: "high" });
    const r = resolveThinking(a, { provider: "p", model: "m", thinkingLevel: "off" }, "premium");
    assert.equal(r.level, "off");
    assert.equal(r.source, "pin");
    assert.equal(r.judged, "high", "raw judgment is still reported for audit");
    assert.ok(describeThinking(r).includes("judged high"));
  });

  await test("precedence: Jev judgment wins when there is no pin", () => {
    const a = analysis({ thinkingLevel: "high" });
    const r = resolveThinking(a, { provider: "p", model: "m" }, "standard");
    assert.equal(r.level, "high");
    assert.equal(r.source, "jev");
  });

  await test("precedence: missing 5th answer falls to the demand ladder", () => {
    const a = analysis({ thinkingLevel: undefined, complexity: 2, budgetIntensity: 2, deepReasoning: 0.9 });
    const r = resolveThinking(a, { provider: "p", model: "m" }, "standard");
    assert.equal(r.source, "ladder");
    assert.equal(r.level, "high", "demand 2.75 → rung high");
    assert.equal(r.judged, undefined);
  });

  await test("precedence: no analysis at all falls to the tier default", () => {
    const r = resolveThinking(undefined, undefined, "quick");
    assert.equal(r.source, "tier");
    assert.equal(r.level, TIER_THINKING.quick);
    assert.equal(resolveThinking(undefined, undefined, "premium").level, TIER_THINKING.premium);
  });

  await test("TIER_THINKING equals the pre-0.5 static table", () => {
    assert.deepEqual(TIER_THINKING, { quick: "off", standard: "low", high: "medium", premium: "high" });
  });

  await test("default routes carry no thinkingLevel (else the feature is dead)", () => {
    for (const tier of ["quick", "standard", "high", "premium"] as const) {
      for (const target of DEFAULT_CONFIG.routes[tier]) {
        assert.equal(target.thinkingLevel, undefined, `${tier} route must not pin by default`);
      }
    }
    for (const chain of Object.values(DEFAULT_CONFIG.kindModels)) {
      for (const target of chain) assert.equal(target.thinkingLevel, undefined);
    }
  });

  await test("ladder rungs line up with the tier table and are monotone", () => {
    // demand → expected rung
    const samples: Array<[number, RouteAnalysis]> = [
      [0, analysis({ complexity: 0, budgetIntensity: 0, deepReasoning: 0.5 })],
      [1, analysis({ complexity: 1, budgetIntensity: 1, deepReasoning: 0.5 })],
      [1.5, analysis({ complexity: 1.5, budgetIntensity: 1.5, deepReasoning: 0.5 })],
      [2, analysis({ complexity: 2, budgetIntensity: 2, deepReasoning: 0.5 })],
      [2.5, analysis({ complexity: 2.5, budgetIntensity: 2.5, deepReasoning: 0.5 })],
      [3, analysis({ complexity: 3, budgetIntensity: 3, deepReasoning: 1 })],
    ];
    const expected = ["off", "low", "medium", "medium", "high", "xhigh"];
    let previous = -1;
    for (let i = 0; i < samples.length; i += 1) {
      const [wantDemand, a] = samples[i];
      assert.equal(demandScore(a), wantDemand, `demand sample ${i}`);
      const rung = thinkingLadder(a);
      assert.ok(rung, "ladder must resolve for finite inputs");
      assert.equal(rung, expected[i], `ladder at demand ${wantDemand}`);
      const idx = (THINKING_LEVELS as readonly string[]).indexOf(rung);
      assert.ok(idx >= previous, "ladder is monotone in demand");
      previous = idx;
    }
  });

  await test("ladder never invents minimal/max, and bails to undefined on garbage", () => {
    for (const complexity of [0, 0.5, 1, 1.7, 2.2, 2.7, 3]) {
      for (const budgetIntensity of [0, 1, 2, 3]) {
        for (const deepReasoning of [0, 0.5, 1]) {
          const rung = thinkingLadder(analysis({ complexity, budgetIntensity, deepReasoning }));
          assert.ok(rung, "finite input resolves");
          assert.ok(["off", "low", "medium", "high", "xhigh"].includes(rung), `got ${rung}`);
        }
      }
    }
    const nan = analysis({ complexity: Number.NaN });
    assert.equal(thinkingLadder(nan), undefined, "non-finite input defers to the tier default");
    assert.equal(resolveThinking(nan, undefined, "high").source, "tier");
  });

  await test("one HTTP call: 5 questions, state whitelist intact", async () => {
    mock.calls = 0;
    mock.bodies = [];
    mock.queue = [FULL_PAYLOAD];
    const a = await classifyRequest({ prompt: "Refactor the config loader" }, config, "test-key");
    assert.equal(mock.calls, 1, "B must not add a second request");
    const body = mock.bodies[0];
    assert.deepEqual(Object.keys(body.state), ["request", "conversation_excerpt"], "privacy whitelist unchanged");
    const questions = body.questions;
    assert.equal(Object.keys(questions).length, 5, "exactly 5 questions");
    assert.equal(questions.thinking_level.type, "choice");
    assert.deepEqual(Object.keys(questions.thinking_level.criteria), [...THINKING_LEVELS]);
    assert.equal(a.thinkingLevel, "medium", "5th answer parsed");
    assert.equal(a.thinkingConfidence, 0.78);
    assert.equal(a.latencyMs >= 0, true);
  });

  await test("missing 5th answer: no throw, thinkingLevel undefined, ladder takes over", async () => {
    mock.calls = 0;
    const payload = JSON.parse(JSON.stringify(FULL_PAYLOAD)) as any;
    delete payload.answers.thinking_level;
    mock.queue = [payload];
    const a = await classifyRequest({ prompt: "Explain the cache guard" }, config, "test-key");
    assert.equal(a.thinkingLevel, undefined);
    assert.equal(a.kind, "implement", "other answers unaffected");
    const r = resolveThinking(a, { provider: "p", model: "m" }, "standard");
    assert.equal(r.source, "ladder");
  });

  await test("invalid 5th answer: rejected without throwing", async () => {
    mock.calls = 0;
    mock.queue = [{ answers: { ...FULL_PAYLOAD.answers, thinking_level: { choice: "banana" } } }];
    const a = await classifyRequest({ prompt: "Diagnose the flaky test" }, config, "test-key");
    assert.equal(a.thinkingLevel, undefined);
    mock.queue = [{ answers: { ...FULL_PAYLOAD.answers, thinking_level: null } }];
    const b = await classifyRequest({ prompt: "Diagnose the flaky test again" }, config, "test-key");
    assert.equal(b.thinkingLevel, undefined);
    assert.equal(mock.calls, 2, "one HTTP per call");
  });

  await test("accounting: one prompt = one request on the ledger", async () => {
    const ledger = emptyLedger();
    recordJevUsage(ledger, 400, 120);
    assert.equal(ledger.jev.requests, 1);
    assert.equal(ledger.jev.inputTokens, 400);
    recordJevUsage(ledger, 1, 1);
    assert.equal(ledger.jev.requests, 2, "increments once per prompt, never per question");
  });

  await test("decide() regression: demand/tier mapping unchanged", () => {
    const models = [
      { provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" },
      { provider: "openrouter", id: "xiaomi/mimo-v2.6-pro" },
      { provider: "openrouter", id: "~anthropic/claude-sonnet-latest" },
      { provider: "openrouter", id: "~anthropic/claude-opus-latest" },
    ];
    const spend = { today: 0, month: 0, pressure: 0, dailyCap: 5, monthlyCap: 100 };

    // demand 1.5 → round → high tier (kind floor standard, no guards trip)
    const d1 = decide(analysis({ complexity: 1.5, budgetIntensity: 1.5 }), config, { models, spend });
    assert.ok(d1);
    assert.equal(d1.tier, "high");
    // Pre-existing kind-specialist behaviour (decide() untouched by B+C): at
    // equal minTier the earlier chain entry wins, so implement prefers the
    // coding specialist over the generic high-tier chain.
    assert.equal(d1.model?.id, "xiaomi/mimo-v2.6-pro");
    assert.equal(d1.kindSpecialised, true);
    assert.equal(d1.demandScore, 1.5);

    // confidence guard: 0.2 < 0.34 → standard
    const d2 = decide(analysis({ kindConfidence: 0.2, complexity: 2.5, budgetIntensity: 2.5 }), config, {
      models,
      spend,
    });
    assert.ok(d2);
    assert.equal(d2.tier, "standard");
    assert.equal(d2.lowConfidenceFallback, true);

    // hard budget guard: pressure ≥ 0.9 forces quick for ordinary demand
    const d3 = decide(analysis({ complexity: 1 }), config, {
      models,
      spend: { ...spend, pressure: 0.95, today: 4.75 },
    });
    assert.ok(d3);
    assert.equal(d3.tier, "quick");
    assert.equal(d3.downgraded, true);

    // kind floor: plan never goes below high
    const d4 = decide(analysis({ kind: "plan", complexity: 0.2, budgetIntensity: 0.2, deepReasoning: 0 }), config, {
      models,
      spend,
    });
    assert.ok(d4);
    assert.equal(d4.tier, "high");
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
