import { randomUUID } from "node:crypto";

import {
  budgetKey,
  runKey,
  runMetaSchema,
  type Store,
} from "@rightmodeler/core";

import type { ModelPricing } from "./provider.js";

interface BudgetLedger {
  authorizedTotalUsd?: number;
  spentUsd: number;
  reservations: Record<string, ReservationLedgerEntry>;
}

interface ReservationLedgerEntry {
  reservedUsd: number;
  runId: string;
  heartbeatAt: string;
}

export const DEFAULT_RESERVATION_STALENESS_WINDOW_MS = 10 * 60 * 1_000;

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
  heartbeat(): Promise<void>;
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
  reservationStalenessWindowMs?: number;
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
  const value: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Budget ledger must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    (record.authorizedTotalUsd !== undefined &&
      (typeof record.authorizedTotalUsd !== "number" ||
        !Number.isFinite(record.authorizedTotalUsd) ||
        record.authorizedTotalUsd < 0)) ||
    typeof record.spentUsd !== "number" ||
    !Number.isFinite(record.spentUsd) ||
    record.spentUsd < 0 ||
    typeof record.reservations !== "object" ||
    record.reservations === null ||
    Array.isArray(record.reservations)
  ) {
    throw new Error("Budget ledger is malformed");
  }
  const reservations: Record<string, ReservationLedgerEntry> = {};
  for (const [reservationId, reservation] of Object.entries(
    record.reservations,
  )) {
    if (
      typeof reservation !== "object" ||
      reservation === null ||
      Array.isArray(reservation)
    ) {
      throw new Error(`Budget reservation ${reservationId} is malformed`);
    }
    const entry = reservation as Record<string, unknown>;
    if (
      typeof entry.reservedUsd !== "number" ||
      !Number.isFinite(entry.reservedUsd) ||
      entry.reservedUsd < 0 ||
      typeof entry.runId !== "string" ||
      entry.runId.length === 0 ||
      typeof entry.heartbeatAt !== "string" ||
      Number.isNaN(Date.parse(entry.heartbeatAt))
    ) {
      throw new Error(`Budget reservation ${reservationId} is malformed`);
    }
    reservations[reservationId] = {
      reservedUsd: entry.reservedUsd,
      runId: entry.runId,
      heartbeatAt: entry.heartbeatAt,
    };
  }
  return {
    ...(record.authorizedTotalUsd === undefined
      ? {}
      : { authorizedTotalUsd: record.authorizedTotalUsd }),
    spentUsd: record.spentUsd,
    reservations,
  };
}

function reservedTotal(ledger: BudgetLedger): number {
  return Object.values(ledger.reservations).reduce(
    (total, reservation) => total + reservation.reservedUsd,
    0,
  );
}

export function createBudget(options: CreateBudgetOptions): Budget {
  if (options.authorizedTotalUsd !== undefined) {
    assertAmount(options.authorizedTotalUsd, "authorizedTotalUsd");
  }
  const reservationStalenessWindowMs =
    options.reservationStalenessWindowMs ??
    DEFAULT_RESERVATION_STALENESS_WINDOW_MS;
  if (
    !Number.isSafeInteger(reservationStalenessWindowMs) ||
    reservationStalenessWindowMs < 0
  ) {
    throw new Error(
      "reservationStalenessWindowMs must be a non-negative safe integer",
    );
  }
  const key = budgetKey(options.projectId, options.runId);

  async function load() {
    for (;;) {
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
      const reservations: Record<string, ReservationLedgerEntry> = {};
      let expired = false;
      for (const [reservationId, reservation] of Object.entries(
        ledger.reservations,
      )) {
        const owner = await options.store.get(
          runKey(options.projectId, reservation.runId),
        );
        const ownerTerminal =
          owner !== null &&
          runMetaSchema.parse(
            JSON.parse(Buffer.from(owner.body).toString("utf8")) as unknown,
          ).status !== "running";
        const stale =
          Date.now() - Date.parse(reservation.heartbeatAt) >
          reservationStalenessWindowMs;
        if (ownerTerminal || stale) {
          expired = true;
        } else {
          reservations[reservationId] = reservation;
        }
      }
      if (!expired) {
        return {
          ledger,
          version: entry.version,
          fenceToken: entry.fenceToken,
        };
      }
      const won = await options.store.compareAndSwap(
        key,
        entry.version,
        encode({ ...ledger, reservations }),
        entry.fenceToken,
      );
      if (won) continue;
    }
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
          [reservationId]: {
            reservedUsd: worstCaseUsd,
            runId: options.runId,
            heartbeatAt: new Date().toISOString(),
          },
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
        async heartbeat(): Promise<void> {
          if (refunded) return;
          for (;;) {
            const latest = await load();
            const reservation = latest.ledger.reservations[reservationId];
            if (reservation === undefined) {
              throw new Error("Budget reservation is no longer active");
            }
            const next: BudgetLedger = {
              ...latest.ledger,
              reservations: {
                ...latest.ledger.reservations,
                [reservationId]: {
                  ...reservation,
                  heartbeatAt: new Date().toISOString(),
                },
              },
            };
            const heartbeatWon = await options.store.compareAndSwap(
              key,
              latest.version,
              encode(next),
              latest.fenceToken,
            );
            if (heartbeatWon) return;
          }
        },
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
