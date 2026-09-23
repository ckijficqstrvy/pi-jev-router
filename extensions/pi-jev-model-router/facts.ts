/**
 * L1 — model facts: dated, refreshable data about models (capability rank +
 * a price snapshot). This is the *facts* layer of the four-layer design:
 *
 *   L3 explicit routes/kindModels in config.json  (never filtered)
 *   L2 policy: profile / ceilings / deny / allow / prefer (config + env)
 *   L1 facts:  this file — who is strong, who is cheap, when we checked
 *   L0 mechanism: decide() composition, guards, fallbacks (code)
 *
 * Capability numbers are a snapshot of the Artificial Analysis intelligence
 * index (max-thinking configuration) cross-checked against Terminal-Bench 4.0
 * and community leaderboards; prices are a snapshot of the pi model catalogue.
 * Both go stale — refresh per README "Refreshing model facts". A corrupt or
 * missing facts file never breaks routing: the loader falls back to the
 * authored DEFAULT routes (fail-open, same rule as everything else here).
 */
import type { Tier } from "./config";
import { TIERS } from "./config";
import FACTS from "./model-facts.json";

/** The shipped facts snapshot (schema-validated at use time, never at import). */
export const MODEL_FACTS: FactsFile = FACTS as FactsFile;

export interface ModelFact {
  /** Routable model id exactly as pi's catalogue knows it (aliases ok). */
  model: string;
  provider: string;
  /** Composite capability snapshot (AA intelligence index, max thinking), higher = stronger. */
  capability: number;
  /** Catalogue list price at snapshot time, USD per million tokens. */
  price: { input: number; output: number };
  /** Capability value is an estimate, not a measured AA entry. */
  estimated?: boolean;
  note?: string;
}

export interface FactsFile {
  generatedAt: string;
  source: string;
  models: ModelFact[];
}

/** The metric every ceiling uses: input + 2×output (agent traffic writes plenty of tokens). */
export function blendedOf(price: { input: number; output: number }): number {
  return price.input + 2 * price.output;
}

/** Schema guard — a bad facts file must degrade to the authored routes, never throw. */
export function factsValid(value: unknown): value is FactsFile {
  const file = value as FactsFile | undefined;
  if (!file || typeof file.generatedAt !== "string" || !Array.isArray(file.models)) return false;
  if (file.models.length === 0) return false;
  return file.models.every(
    (m) =>
      !!m &&
      typeof m.model === "string" &&
      m.model.length > 0 &&
      typeof m.provider === "string" &&
      typeof m.capability === "number" &&
      Number.isFinite(m.capability) &&
      !!m.price &&
      typeof m.price.input === "number" &&
      typeof m.price.output === "number" &&
      m.price.input >= 0 &&
      m.price.output >= 0,
  );
}

/** Capability-descending; ties keep file order (stable, so refreshes don't shuffle). */
export function rankedFacts(facts: FactsFile): ModelFact[] {
  return [...facts.models].sort((a, b) => b.capability - a.capability);
}

/**
 * Partition the ranked facts into disjoint price bands, one per tier.
 *
 * Bands are contiguous upper bounds in tier order (quick → premium): a model
 * lands in the first tier whose upper bound covers its blended price; `null`
 * = unbounded (open-ended premium). Price bands — not capability floors —
 * are what keep the tiers disjoint: the strongest affordable model would
 * otherwise saturate every tier (mimo-pro scores 46 at $2.17 blended).
 * Capability ordering then decides, within a band, which model leads.
 */
export function sliceBands(
  ranked: readonly ModelFact[],
  ceilings: readonly (number | null)[],
): ModelFact[][] {
  const bands: ModelFact[][] = TIERS.map(() => []);
  for (const fact of ranked) {
    const price = blendedOf(fact.price);
    for (let t = 0; t < TIERS.length; t += 1) {
      const upper = ceilings[t];
      if (upper === null || upper === undefined || price <= upper) {
        bands[t].push(fact);
        break;
      }
    }
  }
  return bands;
}
