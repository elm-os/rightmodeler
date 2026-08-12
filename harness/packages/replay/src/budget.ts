import { randomUUID } from "node:crypto";

import { budgetKey, type Store } from "@rightmodeler/core";

import type { ModelPricing } from "./provider.js";

interface BudgetLedger {
  authorizedTotalUsd?: number;
  spentUsd: number;
  reservations: Record<string, number>;
}

export interface BudgetState {
  authorizedTotalUsd?: number;
  spentUsd: number;
  reservedUsd: number;
}

export interface ReserveExecutionInput {
  contextTokens: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
}

export interface BudgetReservation {
  readonly reservedUsd: number;
  refund(actualCostUsd: number): Promise<void>;
}

export interface Budget {
  readonly store: Store;
  readonly projectId: string;
  readonly runId: string;
  reserveExecution(input: ReserveExecutionInput): Promise<BudgetReservation>;
  state(): Promise<BudgetState>;
}

export interface CreateBudgetOptions {
  store: Store;
  projectId: string;
  runId: string;
  authorizedTotalUsd?: number;
}

export class BudgetRefusalError extends Error {
  readonly requiredCapUsd: number;
  readonly authorizedTotalUsd: number;
  readonly causedByReservations: boolean;

  constructor(
    requiredCapUsd: number,
    authorizedTotalUsd: number,
    causedByReservations = false,
  ) {
    super(
      causedByReservations
        ? "Budget capacity is reserved by another in-flight execution"
        : `Budget cap is $${formatUsd(authorizedTotalUsd)}; raise it to at least $${formatUsd(requiredCapUsd)} to start this execution`,
    );
    this.name = "BudgetRefusalError";
    this.requiredCapUsd = requiredCapUsd;
    this.authorizedTotalUsd = authorizedTotalUsd;
    this.causedByReservations = causedByReservations;
  }
}

function formatUsd(value: number): string {
  return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

function assertAmount(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

function assertTokens(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function encode(ledger: BudgetLedger): Buffer {
  return Buffer.from(JSON.stringify(ledger), "utf8");
}

function decode(body: Uint8Array): BudgetLedger {
  return JSON.parse(Buffer.from(body).toString("utf8")) as BudgetLedger;
}

function reservedTotal(ledger: BudgetLedger): number {
  return Object.values(ledger.reservations).reduce(
    (total, amount) => total + amount,
    0,
  );
}

export function createBudget(options: CreateBudgetOptions): Budget {
  if (options.authorizedTotalUsd !== undefined) {
    assertAmount(options.authorizedTotalUsd, "authorizedTotalUsd");
  }
  const key = budgetKey(options.projectId, options.runId);

  async function load() {
    const entry = await options.store.get(key);
    if (entry === null) {
      return {
        ledger: {
          authorizedTotalUsd: options.authorizedTotalUsd,
          spentUsd: 0,
          reservations: {},
        } satisfies BudgetLedger,
        version: 0,
        fenceToken: 0,
      };
    }
    const ledger = {
      ...decode(entry.body),
      authorizedTotalUsd: options.authorizedTotalUsd,
    };
    return { ledger, version: entry.version, fenceToken: entry.fenceToken };
  }

  async function reserveExecution(
    input: ReserveExecutionInput,
  ): Promise<BudgetReservation> {
    assertTokens(input.contextTokens, "contextTokens");
    assertTokens(input.maxOutputTokens, "maxOutputTokens");
    assertAmount(input.pricing.input, "pricing.input");
    assertAmount(input.pricing.output, "pricing.output");
    const worstCaseUsd =
      input.contextTokens * input.pricing.input +
      input.maxOutputTokens * input.pricing.output;
    const reservationId = randomUUID();

    for (;;) {
      const current = await load();
      const requiredCapUsd = current.ledger.spentUsd + worstCaseUsd;
      const capacityRequiredUsd =
        requiredCapUsd + reservedTotal(current.ledger);
      if (
        current.ledger.authorizedTotalUsd !== undefined &&
        capacityRequiredUsd > current.ledger.authorizedTotalUsd
      ) {
        throw new BudgetRefusalError(
          requiredCapUsd,
          current.ledger.authorizedTotalUsd,
          requiredCapUsd <= current.ledger.authorizedTotalUsd,
        );
      }
      const next: BudgetLedger = {
        ...current.ledger,
        reservations: {
          ...current.ledger.reservations,
          [reservationId]: worstCaseUsd,
        },
      };
      const won = await options.store.compareAndSwap(
        key,
        current.version,
        encode(next),
        current.fenceToken,
      );
      if (!won) continue;

      let refunded = false;
      return {
        reservedUsd: worstCaseUsd,
        async refund(actualCostUsd: number): Promise<void> {
          assertAmount(actualCostUsd, "actualCostUsd");
          if (refunded) return;
          for (;;) {
            const latest = await load();
            if (latest.ledger.reservations[reservationId] === undefined) {
              refunded = true;
              return;
            }
            const reservations = { ...latest.ledger.reservations };
            delete reservations[reservationId];
            const finalized: BudgetLedger = {
              ...latest.ledger,
              spentUsd: latest.ledger.spentUsd + actualCostUsd,
              reservations,
            };
            const finalizedWon = await options.store.compareAndSwap(
              key,
              latest.version,
              encode(finalized),
              latest.fenceToken,
            );
            if (finalizedWon) {
              refunded = true;
              return;
            }
          }
        },
      };
    }
  }

  async function state(): Promise<BudgetState> {
    const { ledger } = await load();
    return {
      authorizedTotalUsd: ledger.authorizedTotalUsd,
      spentUsd: ledger.spentUsd,
      reservedUsd: reservedTotal(ledger),
    };
  }

  return {
    store: options.store,
    projectId: options.projectId,
    runId: options.runId,
    reserveExecution,
    state,
  };
}
