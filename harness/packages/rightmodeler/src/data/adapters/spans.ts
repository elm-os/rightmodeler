import {
  normalizedRunSchema,
  type NormalizedRun,
  type NormalizedStep,
} from "../normalized-run.js";
import {
  compareStartValues,
  isRecord,
  optionalString,
  otlpAttributes,
  otlpSpans,
  recordList,
  requiredString,
  startValue,
  type ExcludedTraceStep,
  type TraceAdaptResult,
  type TraceExclusionReason,
  type TraceFormat,
} from "./shared.js";

export interface TraceSpan {
  readonly recordIndex: number;
  readonly sourceIndex: number;
  readonly span: Record<string, unknown>;
  readonly attributes: Record<string, unknown>;
  readonly traceId: string | undefined;
  readonly spanId: string | undefined;
  readonly parentSpanId: string | undefined;
}

export interface SpanTree {
  parentOf(span: TraceSpan): TraceSpan | undefined;
  childrenOf(span: TraceSpan): readonly TraceSpan[];
}

type StepFields = Omit<
  NormalizedStep,
  "stepIndex" | "trajectoryId" | "timestamp"
>;

export type SpanStep =
  | { readonly kind: "skip" }
  | { readonly kind: "excluded"; readonly reason: TraceExclusionReason }
  | { readonly kind: "step"; readonly step: StepFields };

interface ClassifiedStep {
  readonly span: TraceSpan;
  readonly traceId: string;
  readonly step: StepFields;
}

export function traceSpans(records: readonly unknown[]): TraceSpan[] {
  const spans: TraceSpan[] = [];
  for (const [recordIndex, record] of records.entries()) {
    if (!isRecord(record)) continue;
    const candidates = Array.isArray(record.resourceSpans)
      ? otlpSpans(record).map((span) => ({
          span,
          attributes: otlpAttributes(span),
        }))
      : [
          {
            span: record,
            attributes: isRecord(record.attributes)
              ? record.attributes
              : otlpAttributes(record),
          },
        ];
    for (const { span, attributes } of candidates) {
      spans.push({
        recordIndex,
        sourceIndex: spans.length,
        span,
        attributes,
        traceId: optionalString(span.traceId ?? span.trace_id),
        spanId: optionalString(span.spanId ?? span.span_id),
        parentSpanId: optionalString(span.parentSpanId ?? span.parent_span_id),
      });
    }
  }
  return spans;
}

function spanTree(spans: readonly TraceSpan[]): SpanTree {
  const byId = new Map<string, TraceSpan>();
  for (const span of spans) {
    if (span.traceId !== undefined && span.spanId !== undefined) {
      byId.set(`${span.traceId}\0${span.spanId}`, span);
    }
  }
  const parentOf = (span: TraceSpan) =>
    span.traceId === undefined || span.parentSpanId === undefined
      ? undefined
      : byId.get(`${span.traceId}\0${span.parentSpanId}`);
  const children = new Map<TraceSpan, TraceSpan[]>();
  for (const span of spans) {
    const parent = parentOf(span);
    if (parent === undefined) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(span);
    children.set(parent, siblings);
  }
  return { parentOf, childrenOf: (span) => children.get(span) ?? [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function adaptSpans(
  format: TraceFormat,
  label: string,
  records: unknown,
  classify: (span: TraceSpan, tree: SpanTree) => SpanStep,
): TraceAdaptResult {
  const list = recordList(records, format, `${label} trace records`);
  const dropped = new Map<number, string>();
  for (const [recordIndex, record] of list.entries()) {
    if (!isRecord(record)) {
      dropped.set(recordIndex, `${label} record must be an object`);
    }
  }

  const spans = traceSpans(list);
  const tree = spanTree(spans);
  let steps: ClassifiedStep[] = [];
  let excludedSteps: ExcludedTraceStep[] = [];
  for (const span of spans) {
    try {
      const result = classify(span, tree);
      if (result.kind === "skip") continue;
      const traceId = requiredString(
        span.traceId,
        `${label} span ${span.sourceIndex + 1} trace ID`,
        format,
      );
      if (result.kind === "excluded") {
        excludedSteps.push({
          recordIndex: span.recordIndex,
          traceId,
          reason: result.reason,
        });
      } else {
        steps.push({ span, traceId, step: result.step });
      }
    } catch (error) {
      if (!dropped.has(span.recordIndex)) {
        dropped.set(span.recordIndex, errorMessage(error));
      }
    }
  }
  steps = steps.filter(({ span }) => !dropped.has(span.recordIndex));

  const traceCounts = new Map<string, number>();
  for (const { traceId } of steps) {
    traceCounts.set(traceId, (traceCounts.get(traceId) ?? 0) + 1);
  }
  for (const { span, traceId } of steps) {
    if (
      (traceCounts.get(traceId) ?? 0) > 1 &&
      startValue(span.span) === undefined &&
      !dropped.has(span.recordIndex)
    ) {
      dropped.set(
        span.recordIndex,
        `${label} trajectory ${traceId} is missing its start time`,
      );
    }
  }
  steps = steps.filter(({ span }) => !dropped.has(span.recordIndex));
  excludedSteps = excludedSteps.filter(
    ({ recordIndex }) => !dropped.has(recordIndex),
  );

  const grouped = new Map<string, ClassifiedStep[]>();
  for (const step of steps) {
    const group = grouped.get(step.traceId) ?? [];
    group.push(step);
    grouped.set(step.traceId, group);
  }
  const runs: NormalizedRun[] = [...grouped.entries()].map(
    ([traceId, group]) => {
      group.sort(
        (left, right) =>
          compareStartValues(
            startValue(left.span.span),
            startValue(right.span.span),
          ) || left.span.sourceIndex - right.span.sourceIndex,
      );
      return normalizedRunSchema.parse({
        version: "2",
        traceId,
        sourceFormat: format,
        steps: group.map(({ span, step }, stepIndex) => {
          const timestamp = startValue(span.span);
          return {
            stepIndex,
            ...step,
            trajectoryId: traceId,
            ...(timestamp === undefined ? {} : { timestamp }),
          };
        }),
      });
    },
  );

  return {
    runs,
    droppedRecords: [...dropped.entries()]
      .sort(([left], [right]) => left - right)
      .map(([recordIndex, reason]) => ({ recordIndex, reason })),
    excludedSteps,
  };
}
