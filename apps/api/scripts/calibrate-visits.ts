// Read-only calibration matrix. Run: node --import tsx apps/api/scripts/calibrate-visits.ts input.json
import { readFileSync } from 'node:fs';
import {
  evaluateDwell,
  validateDwellParameters,
  type DwellSample,
} from '../src/visit-dwell-engine.js';

type Case = {
  id: string;
  source: 'FIELD' | 'SYNTHETIC';
  truth: 'COMPLIANT' | 'NON_COMPLIANT';
  truth_reference: string;
  radius_m: number;
  required_s: number;
  starts_at: string;
  ends_at: string;
  samples: DwellSample[];
  barriers: string[];
};
type Input = { cases: Case[]; candidates: { name: string; parameters: unknown }[] };
const path = process.argv[2];
if (!path) throw new Error('Usage: calibrate-visits.ts input.json | --synthetic-demo');
const demo = (): Input => {
  const start = Date.parse('2026-10-28T18:00:00Z');
  const at = (minute: number) => new Date(start + minute * 60_000).toISOString();
  const point = (minute: number, id: string, distanceM: number): DwellSample => ({
    deviceId: 'synthetic-device',
    eventId: id,
    sessionId: 'synthetic-session',
    linkId: 'synthetic-link',
    captureAnchorId: 'synthetic-anchor',
    bootId: 'synthetic-boot',
    capturedAt: at(minute),
    receivedAt: at(minute + 1),
    payloadDigest: id,
    accuracyM: 5,
    distanceM,
    moveDistanceM: 0,
    qualityState: 'DEVICE_REPORTED',
  });
  const base = {
    max_gap_s: 300,
    credit_cap_s: 300,
    uncertainty_guard_s: 0,
    max_accuracy_m: 25,
    boundary_tolerance_m: 0,
    max_speed_m_s: 50,
  };
  return {
    cases: [
      {
        id: 'synthetic-compliant',
        source: 'SYNTHETIC',
        truth: 'COMPLIANT',
        truth_reference: 'SYNTHETIC_GENERATOR',
        radius_m: 100,
        required_s: 600,
        starts_at: at(0),
        ends_at: at(60),
        barriers: [],
        samples: [point(0, 'a', 0), point(5, 'b', 0), point(10, 'c', 0)],
      },
      {
        id: 'synthetic-outside',
        source: 'SYNTHETIC',
        truth: 'NON_COMPLIANT',
        truth_reference: 'SYNTHETIC_GENERATOR',
        radius_m: 100,
        required_s: 600,
        starts_at: at(0),
        ends_at: at(60),
        barriers: [],
        samples: Array.from({ length: 60 }, (_, minute) =>
          point(minute, `outside-${minute}`, 5000),
        ),
      },
    ],
    candidates: [
      {
        name: 'conservative_unapproved',
        parameters: { ...base, coverage_min_fraction: null, non_compliance_enabled: false },
      },
      {
        name: 'exploratory_90_percent_not_approved',
        parameters: { ...base, coverage_min_fraction: 0.9, non_compliance_enabled: true },
      },
    ],
  };
};
const input =
  path === '--synthetic-demo' ? demo() : (JSON.parse(readFileSync(path, 'utf8')) as Input);
if (!Array.isArray(input.cases) || !Array.isArray(input.candidates) || !input.candidates.length)
  throw new Error('cases and candidates required');
for (const item of input.cases) {
  if (
    !item.id ||
    !item.truth_reference ||
    !['FIELD', 'SYNTHETIC'].includes(item.source) ||
    !['COMPLIANT', 'NON_COMPLIANT'].includes(item.truth) ||
    !Array.isArray(item.samples) ||
    !Array.isArray(item.barriers)
  )
    throw new Error('invalid labeled case');
}
const percentile = (values: number[], fraction: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
};
const summarize = (cases: Case[]) => {
  const gaps: number[] = [],
    accuracies: number[] = [],
    delays: number[] = [];
  let duplicates = 0;
  for (const item of cases) {
    const seen = new Set<string>();
    const ordered = [...item.samples].sort(
      (a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt),
    );
    let previous: DwellSample | null = null;
    for (const sample of ordered) {
      const key = `${sample.deviceId}:${sample.eventId}`;
      if (seen.has(key)) duplicates++;
      seen.add(key);
      if (Number.isFinite(sample.accuracyM)) accuracies.push(sample.accuracyM);
      const delay = (Date.parse(sample.receivedAt) - Date.parse(sample.capturedAt)) / 1000;
      if (Number.isFinite(delay) && delay >= 0) delays.push(delay);
      if (previous) {
        const gap = (Date.parse(sample.capturedAt) - Date.parse(previous.capturedAt)) / 1000;
        if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
      }
      previous = sample;
    }
  }
  return {
    visits: cases.length,
    positions: cases.reduce((n, item) => n + item.samples.length, 0),
    duplicates,
    gap_s_p50: percentile(gaps, 0.5),
    gap_s_p95: percentile(gaps, 0.95),
    accuracy_m_p50: percentile(accuracies, 0.5),
    accuracy_m_p95: percentile(accuracies, 0.95),
    receipt_delay_s_p50: percentile(delays, 0.5),
    receipt_delay_s_p95: percentile(delays, 0.95),
  };
};
const matrix = input.candidates.map((candidate) => {
  if (!candidate.name) throw new Error('candidate name required');
  const parameters = validateDwellParameters(candidate.parameters);
  const outcomes = input.cases.map((item) => {
    const result = evaluateDwell({
      samples: item.samples,
      barriers: item.barriers,
      radiusM: item.radius_m,
      requiredS: item.required_s,
      startsAt: item.starts_at,
      endsAt: item.ends_at,
      now: item.ends_at,
      parameters,
    });
    const decision =
      result.status === 'COMPLETED'
        ? 'COMPLIANT'
        : result.status === 'INCOMPLETE' && parameters.non_compliance_enabled
          ? 'NON_COMPLIANT'
          : 'INSUFFICIENT_EVIDENCE';
    return {
      id: item.id,
      source: item.source,
      truth: item.truth,
      decision,
      inside_s: result.creditedS,
      outside_s: result.outsideCreditedS,
      unknown_s: result.unknownS,
      potential_inside_upper_s: result.potentialInsideUpperS,
      coverage_percent: result.coveragePercent,
    };
  });
  const metrics = (source: Case['source']) => {
    const selected = outcomes.filter((item) => item.source === source);
    return {
      cases: selected.length,
      false_compliant: selected.filter(
        (item) => item.truth === 'NON_COMPLIANT' && item.decision === 'COMPLIANT',
      ).length,
      false_non_compliant: selected.filter(
        (item) => item.truth === 'COMPLIANT' && item.decision === 'NON_COMPLIANT',
      ).length,
      indeterminate: selected.filter((item) => item.decision === 'INSUFFICIENT_EVIDENCE').length,
    };
  };
  return {
    name: candidate.name,
    parameters,
    field: metrics('FIELD'),
    synthetic: metrics('SYNTHETIC'),
    outcomes,
  };
});
process.stdout.write(
  `${JSON.stringify(
    {
      evidence: {
        field: summarize(input.cases.filter((item) => item.source === 'FIELD')),
        synthetic: summarize(input.cases.filter((item) => item.source === 'SYNTHETIC')),
      },
      matrix,
      field_calibrated: false,
      calibration_note:
        'Candidate comparison only; field approval requires verified reference cases and operational review.',
    },
    null,
    2,
  )}\n`,
);
