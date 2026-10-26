// SPEC-03 Wave 4A: deterministic, conservative pair estimator.
export interface DwellParameters {
  max_gap_s: number;
  credit_cap_s: number;
  uncertainty_guard_s: number;
  max_accuracy_m: number;
  boundary_tolerance_m: number;
  max_speed_m_s: number;
}

export interface DwellSample {
  deviceId: string;
  eventId: string;
  sessionId: string;
  linkId: string;
  captureAnchorId: string;
  bootId: string;
  capturedAt: string;
  receivedAt: string;
  payloadDigest: string;
  accuracyM: number;
  distanceM: number;
  moveDistanceM: number | null;
  qualityState: string;
}

export interface DwellInterval {
  deviceId: string;
  sessionId: string;
  linkId: string;
  eventIdA: string;
  eventIdB: string;
  fromAt: string;
  toAt: string;
  observedS: number;
  creditedS: number;
  creditedFromAt: string;
}

export interface DwellResult {
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'INCOMPLETE' | 'INSUFFICIENT_EVIDENCE';
  requiredS: number;
  creditedS: number;
  percent: number;
  firstQualifiedAt: string | null;
  lastQualifiedAt: string | null;
  completedAt: string | null;
  sampleCount: number;
  uncertainCount: number;
  gapCount: number;
  intervals: DwellInterval[];
}

export function validateDwellParameters(value: unknown): DwellParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_dwell_parameters');
  const params = value as Record<string, unknown>;
  const names = [
    'max_gap_s',
    'credit_cap_s',
    'uncertainty_guard_s',
    'max_accuracy_m',
    'boundary_tolerance_m',
    'max_speed_m_s',
  ] as const;
  if (Object.keys(params).sort().join(',') !== [...names].sort().join(','))
    throw new Error('invalid_dwell_parameters');
  for (const name of names) {
    if (typeof params[name] !== 'number' || !Number.isFinite(params[name]))
      throw new Error('invalid_dwell_parameters');
  }
  const p = params as unknown as DwellParameters;
  if (
    !Number.isInteger(p.max_gap_s) ||
    p.max_gap_s < 1 ||
    p.max_gap_s > 3600 ||
    !Number.isInteger(p.credit_cap_s) ||
    p.credit_cap_s < 1 ||
    p.credit_cap_s > p.max_gap_s ||
    !Number.isInteger(p.uncertainty_guard_s) ||
    p.uncertainty_guard_s < 0 ||
    p.uncertainty_guard_s >= p.credit_cap_s ||
    p.max_accuracy_m <= 0 ||
    p.max_accuracy_m > 1000 ||
    p.boundary_tolerance_m < 0 ||
    p.boundary_tolerance_m > 100 ||
    p.max_speed_m_s <= 0 ||
    p.max_speed_m_s > 100
  )
    throw new Error('invalid_dwell_parameters');
  return p;
}

type Classification = 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN';
export function classifyDwellSample(
  sample: DwellSample,
  radiusM: number,
  params: DwellParameters,
): Classification {
  if (
    !Number.isFinite(sample.distanceM) ||
    sample.distanceM < 0 ||
    !Number.isFinite(sample.accuracyM) ||
    sample.accuracyM <= 0 ||
    sample.accuracyM > params.max_accuracy_m ||
    sample.qualityState !== 'DEVICE_REPORTED'
  )
    return 'UNCERTAIN';
  if (sample.distanceM + sample.accuracyM + params.boundary_tolerance_m <= radiusM) return 'INSIDE';
  if (sample.distanceM - sample.accuracyM > radiusM + params.boundary_tolerance_m) return 'OUTSIDE';
  return 'UNCERTAIN';
}

export function evaluateDwell(input: {
  samples: DwellSample[];
  barriers: string[];
  radiusM: number;
  requiredS: number;
  startsAt: string;
  endsAt: string;
  now: string;
  parameters: DwellParameters;
}): DwellResult {
  const { radiusM, requiredS, startsAt, endsAt, now, parameters } = input;
  if (!Number.isFinite(radiusM) || radiusM <= 0 || !Number.isInteger(requiredS) || requiredS <= 0)
    throw new Error('invalid_dwell_snapshot');
  const start = Date.parse(startsAt),
    end = Date.parse(endsAt),
    current = Date.parse(now);
  if (![start, end, current].every(Number.isFinite) || start >= end)
    throw new Error('invalid_dwell_window');
  const unique = new Map<string, DwellSample>();
  for (const sample of input.samples) {
    const at = Date.parse(sample.capturedAt);
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const key = `${sample.deviceId}:${sample.eventId}`;
    if (!unique.has(key)) unique.set(key, sample);
  }
  const samples = [...unique.values()].sort(
    (a, b) =>
      Date.parse(a.capturedAt) - Date.parse(b.capturedAt) ||
      a.eventId.localeCompare(b.eventId) ||
      a.deviceId.localeCompare(b.deviceId),
  );
  const barriers = input.barriers
    .map(Date.parse)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let creditedS = 0,
    uncertainCount = 0,
    gapCount = 0;
  let firstQualifiedAt: string | null = null,
    lastQualifiedAt: string | null = null,
    completedAt: string | null = null;
  const intervals: DwellInterval[] = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!sample) continue;
    const classification = classifyDwellSample(sample, radiusM, parameters);
    if (classification === 'UNCERTAIN') uncertainCount++;
    if (index === 0) continue;
    const previous = samples[index - 1];
    if (
      !previous ||
      classification !== 'INSIDE' ||
      classifyDwellSample(previous, radiusM, parameters) !== 'INSIDE'
    )
      continue;
    const from = Date.parse(previous.capturedAt),
      to = Date.parse(sample.capturedAt);
    const observedS = Math.floor((to - from) / 1000);
    if (observedS <= 0) continue;
    if (observedS > parameters.max_gap_s) {
      gapCount++;
      continue;
    }
    if (
      sample.deviceId !== previous.deviceId ||
      sample.sessionId !== previous.sessionId ||
      sample.linkId !== previous.linkId ||
      sample.bootId !== previous.bootId ||
      sample.captureAnchorId !== previous.captureAnchorId ||
      barriers.some((barrier) => barrier > from && barrier <= to)
    )
      continue;
    if (
      sample.moveDistanceM !== null &&
      (!Number.isFinite(sample.moveDistanceM) ||
        sample.moveDistanceM / observedS > parameters.max_speed_m_s)
    )
      continue;
    const credit = Math.max(
      0,
      Math.min(observedS, parameters.credit_cap_s) - parameters.uncertainty_guard_s,
    );
    if (credit <= 0) continue;
    const creditedFrom = to - credit * 1000;
    intervals.push({
      deviceId: sample.deviceId,
      sessionId: sample.sessionId,
      linkId: sample.linkId,
      eventIdA: previous.eventId,
      eventIdB: sample.eventId,
      fromAt: previous.capturedAt,
      toAt: sample.capturedAt,
      observedS,
      creditedS: credit,
      creditedFromAt: new Date(creditedFrom).toISOString(),
    });
    if (!firstQualifiedAt) firstQualifiedAt = previous.capturedAt;
    lastQualifiedAt = sample.capturedAt;
    if (!completedAt && creditedS + credit >= requiredS)
      completedAt = new Date(creditedFrom + (requiredS - creditedS) * 1000).toISOString();
    creditedS += credit;
  }
  const status =
    current < start
      ? 'PENDING'
      : creditedS >= requiredS
        ? 'COMPLETED'
        : current < end
          ? 'IN_PROGRESS'
          : creditedS > 0
            ? 'INCOMPLETE'
            : 'INSUFFICIENT_EVIDENCE';
  return {
    status,
    requiredS,
    creditedS,
    percent: Math.min(100, Math.round((creditedS / requiredS) * 10000) / 100),
    firstQualifiedAt,
    lastQualifiedAt,
    completedAt,
    sampleCount: samples.length,
    uncertainCount,
    gapCount,
    intervals,
  };
}

// Union of physical credited ranges; a shared geozone can satisfy two visit requirements,
// but cannot create two copies of the same observed physical second in an aggregate.
export function uniquePhysicalSeconds(intervals: DwellInterval[]): number {
  const ranges = intervals
    .map((item) => [Date.parse(item.creditedFromAt), Date.parse(item.toAt)] as const)
    .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && to > from)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    from = -1,
    to = -1;
  for (const [nextFrom, nextTo] of ranges) {
    if (from < 0) {
      from = nextFrom;
      to = nextTo;
      continue;
    }
    if (nextFrom <= to) to = Math.max(to, nextTo);
    else {
      total += (to - from) / 1000;
      from = nextFrom;
      to = nextTo;
    }
  }
  if (from >= 0) total += (to - from) / 1000;
  return total;
}
