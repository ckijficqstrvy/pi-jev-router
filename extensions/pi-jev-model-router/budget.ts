import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BudgetConfig } from "./config";

export interface LedgerBucket {
  total: number;
  byModel: Record<string, number>;
}

export interface Ledger {
  version: 1;
  days: Record<string, LedgerBucket>;
  months: Record<string, LedgerBucket>;
  jev: { requests: number; inputTokens: number; outputTokens: number };
  updatedAt: string;
}

export function emptyLedger(): Ledger {
  return { version: 1, days: {}, months: {}, jev: { requests: 0, inputTokens: 0, outputTokens: 0 }, updatedAt: new Date().toISOString() };
}

export function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function loadLedger(file: string): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Ledger>;
    return {
      ...emptyLedger(),
      ...parsed,
      days: parsed.days ?? {},
      months: parsed.months ?? {},
      jev: { requests: 0, inputTokens: 0, outputTokens: 0, ...(parsed.jev ?? {}) },
    };
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(file: string, ledger: Ledger): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    ledger.updatedAt = new Date().toISOString();
    writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  } catch {
    // Ledger persistence is best-effort; routing must never break because of it.
  }
}

function addTo(bucket: LedgerBucket, modelKey: string, usd: number): void {
  bucket.total = round4(bucket.total + usd);
  bucket.byModel[modelKey] = round4((bucket.byModel[modelKey] ?? 0) + usd);
}

export function recordCost(ledger: Ledger, modelKey: string, usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const now = new Date();
  const day = dayKey(now);
  const month = monthKey(now);
  ledger.days[day] ??= { total: 0, byModel: {} };
  ledger.months[month] ??= { total: 0, byModel: {} };
  addTo(ledger.days[day], modelKey, usd);
  addTo(ledger.months[month], modelKey, usd);
}

export function recordJevUsage(ledger: Ledger, inputTokens = 0, outputTokens = 0): void {
  ledger.jev.requests += 1;
  ledger.jev.inputTokens += inputTokens;
  ledger.jev.outputTokens += outputTokens;
}

export interface SpendSnapshot {
  today: number;
  month: number;
  /** max(today/dailyCap, month/monthlyCap); 0 when no caps are configured. */
  pressure: number;
  dailyCap?: number;
  monthlyCap?: number;
}

export function spendSnapshot(ledger: Ledger, budget: BudgetConfig): SpendSnapshot {
  const today = ledger.days[dayKey()]?.total ?? 0;
  const month = ledger.months[monthKey()]?.total ?? 0;
  const ratios: number[] = [];
  if (budget.dailyUsd && budget.dailyUsd > 0) ratios.push(today / budget.dailyUsd);
  if (budget.monthlyUsd && budget.monthlyUsd > 0) ratios.push(month / budget.monthlyUsd);
  return {
    today,
    month,
    pressure: ratios.length > 0 ? Math.max(...ratios) : 0,
    dailyCap: budget.dailyUsd,
    monthlyCap: budget.monthlyUsd,
  };
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}