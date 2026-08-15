import {
  normalizedRunSchema,
  type NormalizedRun,
  type NormalizedStep,
} from "../normalized-run.js";
import {
  TraceAdaptError,
  compareStartValues,
  isRecord,
  recordList,
  strictRuns,
  type DroppedTraceRecord,
  type NamedTraceAdapter,
  type TraceAdaptResult,
  type TraceFormat,
} from "./shared.js";

export interface MappedTraceStep {
  traceId: string;
  sortValue?: string;
  step: NormalizedStep;
}

interface RowAdapterOptions {
  format: TraceFormat;
  label: string;
  detect(sample: unknown): number;
  mapRecord(
    record: Record<string, unknown>,
    recordIndex: number,
  ): MappedTraceStep[];
}

function buildRuns(
  format: TraceFormat,
  mapped: Array<MappedTraceStep & { recordIndex: number }>,
): NormalizedRun[] {
  const grouped = new Map<
    string,
    Array<MappedTraceStep & { recordIndex: number }>
  >();
  for (const item of mapped) {
    const group = grouped.get(item.traceId) ?? [];
    group.push(item);
    grouped.set(item.traceId, group);
  }

  return [...grouped.entries()].map(([traceId, group]) => {
    group.sort(
      (left, right) =>
        compareStartValues(left.sortValue, right.sortValue) ||
        left.recordIndex - right.recordIndex,
    );
    const steps = group.map(({ step }, stepIndex) => ({
      ...step,
      stepIndex,
    }));
    return normalizedRunSchema.parse({
      version: "2",
      traceId,
      sourceFormat: format,
      steps,
    });
  });
}

export function createRowAdapter(
  options: RowAdapterOptions,
): NamedTraceAdapter {
  const adaptWithReport = (records: unknown): TraceAdaptResult => {
    const source = recordList(records, options.format, options.label);
    const mapped: Array<MappedTraceStep & { recordIndex: number }> = [];
    const droppedRecords: DroppedTraceRecord[] = [];

    for (const [recordIndex, candidate] of source.entries()) {
      if (!isRecord(candidate)) {
        droppedRecords.push({
          recordIndex,
          reason: `${options.label} record must be an object`,
        });
        continue;
      }
      try {
        const steps = options.mapRecord(candidate, recordIndex);
        if (steps.length === 0) {
          droppedRecords.push({
            recordIndex,
            reason: "record does not contain a mappable model call",
          });
        } else {
          mapped.push(...steps.map((step) => ({ ...step, recordIndex })));
        }
      } catch (error) {
        droppedRecords.push({
          recordIndex,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      runs: buildRuns(options.format, mapped),
      droppedRecords,
    };
  };

  return {
    name: options.format,
    detect: options.detect,
    adapt(records) {
      const source = recordList(records, options.format, options.label);
      if (source.length === 0) {
        throw new TraceAdaptError(
          options.format,
          `${options.label} trace contains no records`,
        );
      }
      return strictRuns(options.format, adaptWithReport(source));
    },
    adaptWithReport,
  };
}
