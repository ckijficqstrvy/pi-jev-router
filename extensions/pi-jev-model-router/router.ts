import type { JevRouterConfig, RouteChain, RouteTarget, Tier } from "./config";
import { TIERS } from "./config";
import type { SpendSnapshot } from "./budget";
import { formatUsd } from "./budget";
import type { RouteAnalysis } from "./jev";

export interface AvailableModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface Decision {
  /** Tier chosen by the semantic judgment, before affordability. */
  desiredTier: Tier;
  /** Tier actually used after budget and availability. */
  tier: Tier;
  target: RouteTarget;
  model?: AvailableModel;
  tierIndex: number;
  demandScore: number;
  budgetPressure: number;
  downgraded: boolean;
  lowConfidenceFallback: boolean;
  /** True when kind-specific models (not the generic tier chain) were used. */
  kindSpecialised: boolean;
  reason: string;
  notes: string[];
}

export function tierIndex(tier: Tier | undefined): number {
  const index = TIERS.indexOf(tier ?? "standard");
  return index < 0 ? 1 : index;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function findModel(
  models: readonly AvailableModel[],
  target: RouteTarget,
): AvailableModel | undefined {
  return (
    models.find((m) => m.provider === target.provider && m.id === target.model) ??
    models.find((m) => m.id === target.model) ??
    undefined
  );
}

export function firstAvailable(
  models: readonly AvailableModel[],
  chain: RouteChain,
): { target: RouteTarget; model: AvailableModel } | undefined {
  for (const target of chain) {
    const model = findModel(models, target);
    if (model) return { target, model };
  }
  return undefined;
}

/** Best-effort reverse lookup: which tier does this model key sit on? */
export function tierForModel(modelKey: string | undefined, config: JevRouterConfig): number | undefined {
  if (!modelKey) return undefined;
  for (const tier of TIERS) {
    if (config.routes[tier].some((t) => `${t.provider}/${t.model}` === modelKey)) return tierIndex(tier);
  }
  for (const chain of Object.values(config.kindModels)) {
    const hit = chain.find((t) => `${t.provider}/${t.model}` === modelKey);
    if (hit) return tierIndex(hit.minTier);
  }
  return undefined;
}

export interface DecideOptions {
  models: readonly AvailableModel[];
  spend: SpendSnapshot;
}

/**
 * Compose the Jev judgments into a tier, then apply affordability and availability.
 *
 *   demand = 0.55 * complexity + 0.45 * capability_deserved, nudged by deep reasoning
 *   demand = max(demand, kind floor)          // planning/review never go cheap
 *   then: confidence guard -> budget guard -> availability guard
 *
 * Kind-specialist models (Codex for implementation, Opus for review, ...) are
 * tried first when the chosen tier is at or above their `minTier`.
 */
export function decide(
  analysis: RouteAnalysis,
  config: JevRouterConfig,
  options: DecideOptions,
): Decision | undefined {
  const notes: string[] = [];
  const { spend } = options;

  let demand = 0.55 * analysis.complexity + 0.45 * analysis.budgetIntensity;
  if (analysis.deepReasoning >= 0.65) demand += 0.75;
  else if (analysis.deepReasoning <= 0.2) demand -= 0.25;
  demand = clamp(demand, 0, 3);

  const kindFloor = tierIndex(config.kindMinimumTier[analysis.kind] ?? "quick");
  if (demand < kindFloor) {
    notes.push(`${analysis.kind} floors at ${TIERS[kindFloor]}`);
    demand = kindFloor;
  }

  const desiredIndex = clamp(Math.round(demand), 0, TIERS.length - 1);
  let index = desiredIndex;
  let lowConfidenceFallback = false;

  // Confidence guard: don't spend premium money on an unsure classification.
  if (
    config.confidenceThreshold > 0 &&
    analysis.kindConfidence > 0 &&
    analysis.kindConfidence < config.confidenceThreshold &&
    index > 1
  ) {
    notes.push(`low kind confidence ${analysis.kindConfidence.toFixed(2)} → standard`);
    index = 1;
    lowConfidenceFallback = true;
  }

  // Budget guard: hard pressure forces the cheap tier unless the work is clearly architectural.
  let downgraded = false;
  if (spend.pressure >= config.budget.hardRatio && spend.pressure > 0) {
    const forced = demand >= 2.5 ? 1 : 0;
    if (forced < index) {
      notes.push(
        `budget ${(spend.pressure * 100).toFixed(0)}% of cap (${formatUsd(spend.today)} today) → capped at ${TIERS[forced]}`,
      );
      index = forced;
      downgraded = true;
    }
  } else if (spend.pressure >= config.budget.softRatio && spend.pressure > 0) {
    if (index > 0) {
      notes.push(`budget ${(spend.pressure * 100).toFixed(0)}% of cap → one tier down`);
      index -= 1;
      downgraded = true;
    }
  }

  // Candidate order: kind specialists for the chosen tier, then the tier chain,
  // then neighbouring tiers (nearest first) so an unavailable model never blocks routing.
  // Specialists are ranked by how close their `minTier` is to the chosen tier, so a
  // cheap specialist does not win a premium-quality turn.
  const kindChain = (config.kindModels[analysis.kind] ?? [])
    .filter((target) => tierIndex(target.minTier) <= index)
    .sort((a, b) => tierIndex(b.minTier) - tierIndex(a.minTier));
  const ordered: RouteTarget[] = [...kindChain, ...config.routes[TIERS[index]]];
  for (let offset = 1; offset < TIERS.length; offset += 1) {
    if (index - offset >= 0) ordered.push(...config.routes[TIERS[index - offset]]);
    if (index + offset < TIERS.length) ordered.push(...config.routes[TIERS[index + offset]]);
  }

  const available = firstAvailable(options.models, ordered);
  if (!available) return undefined;

  const usedKindChain = kindChain.some(
    (t) => t.provider === available.target.provider && t.model === available.target.model,
  );
  const effectiveIndex = usedKindChain
    ? index
    : Math.max(
        index,
        TIERS.findIndex((tier) =>
          config.routes[tier].some(
            (t) => t.provider === available.target.provider && t.model === available.target.model,
          ),
        ),
      );
  if (effectiveIndex !== index) {
    notes.push(`${TIERS[index]} chain unavailable → ${TIERS[effectiveIndex]}`);
    downgraded = effectiveIndex < index;
    index = effectiveIndex;
  }

  const reason =
    `${analysis.kind} · complexity ${analysis.complexity.toFixed(2)}/3 · ` +
    `capability ${analysis.budgetIntensity.toFixed(2)}/3 · reasoning ${analysis.deepReasoning.toFixed(2)}` +
    ` → ${TIERS[desiredIndex]}${index === desiredIndex ? "" : ` (used ${TIERS[index]})`}`;

  return {
    desiredTier: TIERS[desiredIndex],
    tier: TIERS[index],
    target: available.target,
    model: available.model,
    tierIndex: index,
    demandScore: demand,
    budgetPressure: spend.pressure,
    downgraded,
    lowConfidenceFallback,
    kindSpecialised: usedKindChain,
    reason,
    notes,
  };
}

export function describeDecision(decision: Decision): string {
  const target = decision.model
    ? `${decision.model.provider}/${decision.model.id}`
    : `${decision.target.provider}/${decision.target.model}`;
  return `${decision.reason} → ${target}`;
}