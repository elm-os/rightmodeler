export const MIN_REVIEW_TRIALS = 10;
export const MIN_DISTINCT_STEPS = 2;
export const MIN_DISTINCT_TRAJECTORIES = 5;

export interface Interval {
  point: number;
  lower: number;
  upper: number;
}

export interface WilsonOptions {
  confidence?: number;
  comparisons?: number;
}

export interface ClusterBootstrapOptions {
  resamples: number;
  seed: number;
  confidence?: number;
  comparisons?: number;
}

export function wilson(
  passes: number,
  n: number,
  { confidence = 0.95, comparisons = 1 }: WilsonOptions = {},
): Interval {
  if (!Number.isSafeInteger(passes) || passes < 0) {
    throw new RangeError("passes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError("n must be a non-negative safe integer");
  }
  if (passes > n) {
    throw new RangeError("passes must not exceed n");
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError("confidence must be between 0 and 1");
  }
  if (!Number.isSafeInteger(comparisons) || comparisons < 1) {
    throw new RangeError("comparisons must be a positive safe integer");
  }
  if (n === 0) {
    return { point: 0, lower: 0, upper: 1 };
  }

  return wilsonForPoint(passes / n, n, confidence, comparisons);
}

function wilsonForPoint(
  point: number,
  n: number,
  confidence: number,
  comparisons: number,
): Interval {
  // Bonferroni controls the family-wise error rate by dividing alpha
  // across comparisons before computing the two-sided normal quantile.
  const alpha = (1 - confidence) / comparisons;
  const quantileProbability = 1 - alpha / 2;
  if (quantileProbability >= 1) {
    throw new RangeError("confidence and comparisons exceed numeric precision");
  }
  const z = inverseStandardNormal(quantileProbability);
  const zSquared = z * z;
  const denominator = 1 + zSquared / n;
  const center = (point + zSquared / (2 * n)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((point * (1 - point) + zSquared / (4 * n)) / n);

  return {
    point,
    lower: point === 0 ? 0 : Math.max(0, center - margin),
    upper: point === 1 ? 1 : Math.min(1, center + margin),
  };
}

export function clusterBootstrap(
  executionsByTrajectory: Readonly<Record<string, readonly boolean[]>>,
  {
    resamples,
    seed,
    confidence = 0.95,
    comparisons = 1,
  }: ClusterBootstrapOptions,
): Interval {
  if (!Number.isSafeInteger(resamples) || resamples < 1) {
    throw new RangeError("resamples must be a positive safe integer");
  }
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("seed must be a safe integer");
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError("confidence must be between 0 and 1");
  }
  if (!Number.isSafeInteger(comparisons) || comparisons < 1) {
    throw new RangeError("comparisons must be a positive safe integer");
  }

  const trajectories = Object.entries(executionsByTrajectory)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([trajectoryId, outcomes]) => {
      if (outcomes.length === 0) {
        throw new RangeError(
          `trajectory ${trajectoryId} must contain an execution`,
        );
      }
      if (outcomes.some((outcome) => typeof outcome !== "boolean")) {
        throw new TypeError(
          `trajectory ${trajectoryId} outcomes must be boolean`,
        );
      }
      return {
        executions: outcomes.length,
        passes: outcomes.filter(Boolean).length,
      };
    });

  if (trajectories.length === 0) {
    throw new RangeError("at least one trajectory is required");
  }

  const totalExecutions = trajectories.reduce(
    (total, trajectory) => total + trajectory.executions,
    0,
  );
  const totalPasses = trajectories.reduce(
    (total, trajectory) => total + trajectory.passes,
    0,
  );
  const random = seededRandom(seed);
  const bootstrapPoints: number[] = [];

  for (let sample = 0; sample < resamples; sample += 1) {
    let sampledExecutions = 0;
    let sampledPasses = 0;
    for (let draw = 0; draw < trajectories.length; draw += 1) {
      const trajectory =
        trajectories[Math.floor(random() * trajectories.length)]!;
      sampledExecutions += trajectory.executions;
      sampledPasses += trajectory.passes;
    }
    bootstrapPoints.push(sampledPasses / sampledExecutions);
  }

  bootstrapPoints.sort((left, right) => left - right);
  const alpha = (1 - confidence) / comparisons;
  const point = totalPasses / totalExecutions;
  // Percentile resampling can collapse when observed trajectories have the
  // same rate. The Wilson envelope uses the number of independent trajectory
  // units, never the larger execution count, to retain finite-sample
  // uncertainty without narrowing the trajectory-resampled interval.
  const finiteSampleInterval = wilsonForPoint(
    point,
    trajectories.length,
    confidence,
    comparisons,
  );
  return {
    point,
    lower: Math.min(
      percentile(bootstrapPoints, alpha / 2),
      finiteSampleInterval.lower,
    ),
    upper: Math.max(
      percentile(bootstrapPoints, 1 - alpha / 2),
      finiteSampleInterval.upper,
    ),
  };
}

function percentile(
  sortedValues: readonly number[],
  probability: number,
): number {
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex]!;
  const upper = sortedValues[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function inverseStandardNormal(probability: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269,
    -30.66479806614716, 2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];
  const lowerTail = 0.02425;
  const upperTail = 1 - lowerTail;

  if (probability < lowerTail) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
        c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (probability > upperTail) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
        c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }

  const q = probability - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r +
      a[5]!) *
      q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}
