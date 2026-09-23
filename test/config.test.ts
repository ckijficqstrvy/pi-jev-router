/**
 * Config loader tests: environment-variable overrides with validation.
 *
 * Run: npm test   (esbuild-bundled — no network, no pi runtime; every case
 * drives the pure resolveConfig()/applyEnvOverrides() core with an explicit
 * patch and env, never the real config file or process.env).
 */
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  applyEnvOverrides,
  resolveConfig,
} from "../extensions/pi-jev-model-router/config";

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

async function main(): Promise<void> {
  await test("no patch, no env → defaults, no warnings, no overrides", () => {
    const result = resolveConfig(undefined, {});
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.envOverrides, []);
  });

  await test("env wins over config.json and reports what it overrode", () => {
    const { config, warnings, envOverrides } = resolveConfig(
      { mode: "confirm", timeoutMs: 9000 },
      { JEV_ROUTER_MODE: "auto", JEV_ROUTER_TIMEOUT_MS: "1500" },
    );
    assert.equal(config.mode, "auto");
    assert.equal(config.timeoutMs, 1500);
    assert.deepEqual(warnings, []);
    assert.deepEqual(envOverrides, ["JEV_ROUTER_MODE", "JEV_ROUTER_TIMEOUT_MS"]);
  });

  await test("invalid enum value warns and the file value stands", () => {
    const { config, warnings, envOverrides } = resolveConfig({ mode: "confirm" }, { JEV_ROUTER_MODE: "turbo" });
    assert.equal(config.mode, "confirm");
    assert.deepEqual(envOverrides, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /JEV_ROUTER_MODE/);
    assert.match(warnings[0], /"turbo"/);
    assert.match(warnings[0], /auto, confirm, or notify/);
  });

  await test("booleans accept 1/0/true/false/yes/no/on/off case-insensitively", () => {
    assert.equal(resolveConfig(undefined, { JEV_ROUTER_ENABLED: "FALSE" }).config.enabled, false);
    assert.equal(resolveConfig(undefined, { JEV_ROUTER_ENABLED: "Yes" }).config.enabled, true);
    assert.equal(resolveConfig(undefined, { JEV_ROUTER_STICKINESS: "off" }).config.stickiness, false);
    const bad = resolveConfig(undefined, { JEV_ROUTER_ENABLED: "maybe" });
    assert.equal(bad.config.enabled, true);
    assert.equal(bad.warnings.length, 1);
    assert.match(bad.warnings[0], /1\/0, true\/false/);
  });

  await test("legacy JEV_ROUTER_OFF kill switch still works; JEV_ROUTER_ENABLED wins when both set", () => {
    assert.equal(resolveConfig(undefined, { JEV_ROUTER_OFF: "1" }).config.enabled, false);
    assert.equal(resolveConfig(undefined, { JEV_ROUTER_OFF: "true" }).config.enabled, false);
    // A falsy legacy value is honoured but changes nothing.
    const off = resolveConfig(undefined, { JEV_ROUTER_OFF: "0" });
    assert.equal(off.config.enabled, true);
    assert.deepEqual(off.envOverrides, []);
    assert.deepEqual(off.warnings, []);
    // Both set: the modern variable is applied last and wins.
    assert.equal(resolveConfig(undefined, { JEV_ROUTER_OFF: "1", JEV_ROUTER_ENABLED: "on" }).config.enabled, true);
  });

  await test("numbers validate type, integrality, and range", () => {
    const bad = resolveConfig(undefined, {
      JEV_ROUTER_TIMEOUT_MS: "12.5",
      JEV_ROUTER_MIN_PROMPT_CHARS: "-1",
      JEV_ROUTER_CONFIDENCE_THRESHOLD: "1.5",
      JEV_ROUTER_HISTORY_TURNS: "0x10",
    });
    assert.equal(bad.config.timeoutMs, DEFAULT_CONFIG.timeoutMs);
    assert.equal(bad.config.minPromptChars, DEFAULT_CONFIG.minPromptChars);
    assert.equal(bad.config.confidenceThreshold, DEFAULT_CONFIG.confidenceThreshold);
    assert.equal(bad.config.historyTurns, DEFAULT_CONFIG.historyTurns);
    assert.deepEqual(bad.envOverrides, []);
    assert.equal(bad.warnings.length, 4);

    const good = resolveConfig(undefined, {
      JEV_ROUTER_TIMEOUT_MS: "0",
      JEV_ROUTER_CONFIDENCE_THRESHOLD: "0.5",
      JEV_ROUTER_CACHE_DEADBAND: "0.25",
    });
    assert.equal(good.config.timeoutMs, 0);
    assert.equal(good.config.confidenceThreshold, 0.5);
    assert.equal(good.config.cache.deadband, 0.25);
    assert.deepEqual(good.warnings, []);
  });

  await test("budget caps accept amounts or none to remove the cap", () => {
    const { config, warnings, envOverrides } = resolveConfig(undefined, {
      JEV_ROUTER_BUDGET_DAILY_USD: "none",
      JEV_ROUTER_BUDGET_MONTHLY_USD: "42.5",
    });
    assert.ok(!("dailyUsd" in config.budget));
    assert.equal(config.budget.monthlyUsd, 42.5);
    assert.deepEqual(warnings, []);
    assert.deepEqual(envOverrides, ["JEV_ROUTER_BUDGET_DAILY_USD", "JEV_ROUTER_BUDGET_MONTHLY_USD"]);

    const bad = resolveConfig(undefined, { JEV_ROUTER_BUDGET_DAILY_USD: "-3" });
    assert.equal(bad.config.budget.dailyUsd, DEFAULT_CONFIG.budget.dailyUsd);
    assert.equal(bad.warnings.length, 1);
    assert.match(bad.warnings[0], /or "none"/);
  });

  await test("incoherent ratio overrides are dropped; coherent pairs apply", () => {
    // soft alone above the effective hard ratio → dropped with a warning.
    const r1 = resolveConfig(undefined, { JEV_ROUTER_BUDGET_SOFT_RATIO: "0.95" });
    assert.equal(r1.config.budget.softRatio, DEFAULT_CONFIG.budget.softRatio);
    assert.deepEqual(r1.envOverrides, []);
    assert.equal(r1.warnings.length, 1);
    assert.match(r1.warnings[0], /softRatio must be ≤ budget.hardRatio/);

    // coherent pair applies
    const r2 = resolveConfig(undefined, {
      JEV_ROUTER_BUDGET_SOFT_RATIO: "0.5",
      JEV_ROUTER_BUDGET_HARD_RATIO: "0.8",
    });
    assert.equal(r2.config.budget.softRatio, 0.5);
    assert.equal(r2.config.budget.hardRatio, 0.8);
    assert.deepEqual(r2.warnings, []);

    // incoherent pair → both dropped, file values stand
    const r3 = resolveConfig(undefined, {
      JEV_ROUTER_BUDGET_SOFT_RATIO: "0.9",
      JEV_ROUTER_BUDGET_HARD_RATIO: "0.4",
    });
    assert.deepEqual(r3.config.budget, DEFAULT_CONFIG.budget);
    assert.deepEqual(r3.envOverrides, []);
    assert.equal(r3.warnings.length, 1);
  });

  await test("config-file invariants are reported but never mutated", () => {
    const { config, warnings, envOverrides } = resolveConfig({ budget: { softRatio: 0.9, hardRatio: 0.5 } }, {});
    assert.equal(config.budget.softRatio, 0.9);
    assert.equal(config.budget.hardRatio, 0.5);
    assert.deepEqual(envOverrides, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /wrong order/);
  });

  await test("JEV_ROUTER_KIND_MIN_TIER validates kind=tier pairs", () => {
    const good = resolveConfig(undefined, { JEV_ROUTER_KIND_MIN_TIER: "plan=high,chat=standard" });
    assert.equal(good.config.kindMinimumTier.plan, "high");
    assert.equal(good.config.kindMinimumTier.chat, "standard");
    assert.deepEqual(good.warnings, []);

    // Unknown tier, unknown kind, and a malformed pair each reject the whole
    // variable and leave every floor unchanged.
    for (const raw of ["plan=ultra", "deploy=standard", "plan-high", "plan="]) {
      const bad = resolveConfig(undefined, { JEV_ROUTER_KIND_MIN_TIER: raw });
      assert.deepEqual(bad.config.kindMinimumTier, DEFAULT_CONFIG.kindMinimumTier);
      assert.equal(bad.warnings.length, 1, `expected a warning for ${JSON.stringify(raw)}`);
      assert.match(bad.warnings[0], /JEV_ROUTER_KIND_MIN_TIER/);
    }
  });

  await test("useDefaultModels=false via env drops built-in chains before the patch merges", () => {
    const { config, warnings } = resolveConfig(
      { routes: { quick: [{ provider: "openrouter", model: "custom/quick" }] } },
      { JEV_ROUTER_USE_DEFAULT_MODELS: "false" },
    );
    assert.equal(config.useDefaultModels, false);
    assert.equal(config.routes.quick.length, 1);
    assert.equal(config.routes.quick[0].model, "custom/quick");
    assert.deepEqual(config.routes.standard, []);
    assert.deepEqual(config.kindModels, {});
    assert.deepEqual(warnings, []);
  });

  await test("empty env values count as unset: silent, no override", () => {
    const { config, warnings, envOverrides } = resolveConfig(undefined, {
      JEV_ROUTER_MODE: "",
      JEV_ROUTER_TIMEOUT_MS: "   ",
    });
    assert.equal(config.mode, DEFAULT_CONFIG.mode);
    assert.deepEqual(warnings, []);
    assert.deepEqual(envOverrides, []);
  });

  await test("unprintable values are never echoed into warnings", () => {
    const junk = "\u0007".repeat(60);
    const { warnings } = resolveConfig(undefined, { JEV_ROUTER_JEV_MODEL: junk });
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes("\u0007"));
    assert.match(warnings[0], /unprintable value not shown/);
  });

  await test("applyEnvOverrides never mutates its input, DEFAULT_CONFIG included", () => {
    const result = applyEnvOverrides(DEFAULT_CONFIG, {
      JEV_ROUTER_MODE: "auto",
      JEV_ROUTER_HISTORY_TURNS: "3",
      JEV_ROUTER_BUDGET_DAILY_USD: "50",
      JEV_ROUTER_KIND_MIN_TIER: "plan=quick",
      JEV_ROUTER_CACHE_DEADBAND: "0.9",
    });
    assert.equal(result.config.mode, "auto");
    assert.equal(result.config.historyTurns, 3);
    assert.equal(result.config.budget.dailyUsd, 50);
    assert.equal(result.config.kindMinimumTier.plan, "quick");
    assert.equal(result.config.cache.deadband, 0.9);
    // DEFAULT_CONFIG must be pristine for every other consumer.
    assert.equal(DEFAULT_CONFIG.mode, "notify");
    assert.equal(DEFAULT_CONFIG.historyTurns, 0);
    assert.equal(DEFAULT_CONFIG.budget.dailyUsd, 5);
    assert.equal(DEFAULT_CONFIG.kindMinimumTier.plan, "high");
    assert.equal(DEFAULT_CONFIG.cache.deadband, 0.25);
  });

  await test("scalar reachability: every non-structured knob has an env variable", () => {
    // Guard against future fields drifting out of the env schema: every scalar
    // on the config must change under some JEV_ROUTER_* variable. (Structured
    // settings — routes, kindModels — are config.json-only by design; the
    // kindMinimumTier map is reachable via JEV_ROUTER_KIND_MIN_TIER.)
    const config = resolveConfig(undefined, {
      JEV_ROUTER_ENABLED: "false",
      JEV_ROUTER_MODE: "auto",
      JEV_ROUTER_USE_DEFAULT_MODELS: "false",
      JEV_ROUTER_JEV_MODEL: "jev-x",
      JEV_ROUTER_TIMEOUT_MS: "1",
      JEV_ROUTER_MIN_PROMPT_CHARS: "2",
      JEV_ROUTER_HISTORY_TURNS: "3",
      JEV_ROUTER_CONFIDENCE_THRESHOLD: "0.9",
      JEV_ROUTER_STICKINESS: "false",
      JEV_ROUTER_BUDGET_DAILY_USD: "none",
      JEV_ROUTER_BUDGET_MONTHLY_USD: "1",
      JEV_ROUTER_BUDGET_SOFT_RATIO: "0.2",
      JEV_ROUTER_BUDGET_HARD_RATIO: "0.3",
      JEV_ROUTER_CACHE_AWARE: "false",
      JEV_ROUTER_CACHE_DEADBAND: "0.4",
      JEV_ROUTER_CACHE_MAX_PENALTY_USD: "0.01",
      JEV_ROUTER_CACHE_BYPASS_TIER_DELTA: "5",
    }).config;
    assert.deepEqual(config, {
      ...DEFAULT_CONFIG,
      enabled: false,
      mode: "auto",
      useDefaultModels: false,
      jevModel: "jev-x",
      timeoutMs: 1,
      minPromptChars: 2,
      historyTurns: 3,
      confidenceThreshold: 0.9,
      stickiness: false,
      // useDefaultModels=false → bring-your-own base: built-in chains dropped.
      routes: { quick: [], standard: [], high: [], premium: [] },
      kindModels: {},
      budget: { monthlyUsd: 1, softRatio: 0.2, hardRatio: 0.3 },
      cache: { aware: false, deadband: 0.4, maxPenaltyUsd: 0.01, bypassTierDelta: 5 },
    });
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
