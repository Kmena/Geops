export interface GpsPolicySpec {
  /** Server-owned MDM entitlement; never accepted from a policy draft. */
  mdm_continuous?: boolean;
  name: string;
  days_iso: number[];
  start_local: string;
  end_local: string;
  time_zone: string;
  capture_interval_s: number;
  sync_interval_s: number;
  heartbeat_missing_after_s: number;
  health_interval_s: number;
  valid_from: string;
  valid_until: string;
  exceptions?: Array<{
    local_date: string;
    mode: 'OFF' | 'REPLACE';
    start_local?: string;
    end_local?: string;
    reason: string;
  }>;
}

export interface UtcWindow {
  local_date: string;
  start_at: string;
  end_at: string;
}
const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;
const utcDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function validatePolicy(input: unknown): GpsPolicySpec {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('invalid_policy');
  const p = input as Record<string, unknown>;
  const allowed = new Set([
    'name',
    'days_iso',
    'start_local',
    'end_local',
    'time_zone',
    'capture_interval_s',
    'sync_interval_s',
    'heartbeat_missing_after_s',
    'health_interval_s',
    'valid_from',
    'valid_until',
    'exceptions',
  ]);
  if (Object.keys(p).some((key) => !allowed.has(key))) throw new Error('invalid_policy');
  if (typeof p.name !== 'string' || p.name.trim().length < 1 || p.name.length > 120)
    throw new Error('invalid_policy');
  if (
    !Array.isArray(p.days_iso) ||
    p.days_iso.length < 1 ||
    p.days_iso.length > 7 ||
    p.days_iso.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
    new Set(p.days_iso).size !== p.days_iso.length
  )
    throw new Error('invalid_policy');
  if (
    typeof p.start_local !== 'string' ||
    typeof p.end_local !== 'string' ||
    !clock.test(p.start_local) ||
    !clock.test(p.end_local) ||
    p.start_local === p.end_local
  )
    throw new Error('invalid_policy');
  if (typeof p.time_zone !== 'string' || p.time_zone.length < 3 || p.time_zone.length > 80)
    throw new Error('invalid_policy');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: p.time_zone });
  } catch {
    throw new Error('invalid_policy');
  }
  const bounds: Array<[string, number, number]> = [
    ['capture_interval_s', 30, 300],
    ['sync_interval_s', 60, 900],
    ['heartbeat_missing_after_s', 300, 7200],
  ];
  if (
    bounds.some(
      ([key, min, max]) =>
        !Number.isInteger(p[key]) || (p[key] as number) < min || (p[key] as number) > max,
    )
  )
    throw new Error('invalid_policy');
  const healthInterval = p.health_interval_s ?? 300;
  if (
    !Number.isInteger(healthInterval) ||
    (healthInterval as number) < 60 ||
    (healthInterval as number) > 3600
  )
    throw new Error('invalid_policy');
  if (
    typeof p.valid_from !== 'string' ||
    typeof p.valid_until !== 'string' ||
    !utcDate.test(p.valid_from) ||
    !utcDate.test(p.valid_until) ||
    !Number.isFinite(Date.parse(p.valid_from)) ||
    !Number.isFinite(Date.parse(p.valid_until)) ||
    Date.parse(p.valid_from) >= Date.parse(p.valid_until)
  )
    throw new Error('invalid_policy');
  if (p.exceptions !== undefined) {
    if (!Array.isArray(p.exceptions) || p.exceptions.length > 366)
      throw new Error('invalid_policy');
    const dates = new Set<string>();
    for (const raw of p.exceptions) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_policy');
      const ex = raw as Record<string, unknown>;
      if (
        Object.keys(ex).some(
          (key) => !new Set(['local_date', 'mode', 'start_local', 'end_local', 'reason']).has(key),
        ) ||
        typeof ex.local_date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(ex.local_date) ||
        new Date(`${ex.local_date}T00:00:00Z`).toISOString().slice(0, 10) !== ex.local_date ||
        dates.has(ex.local_date) ||
        typeof ex.reason !== 'string' ||
        ex.reason.length < 8 ||
        ex.reason.length > 240
      )
        throw new Error('invalid_policy');
      dates.add(ex.local_date);
      if (ex.mode === 'OFF') {
        if (ex.start_local !== undefined || ex.end_local !== undefined)
          throw new Error('invalid_policy');
      } else if (ex.mode === 'REPLACE') {
        if (
          typeof ex.start_local !== 'string' ||
          typeof ex.end_local !== 'string' ||
          !clock.test(ex.start_local) ||
          !clock.test(ex.end_local) ||
          ex.start_local === ex.end_local
        )
          throw new Error('invalid_policy');
      } else throw new Error('invalid_policy');
    }
  }
  return { ...p, health_interval_s: healthInterval } as unknown as GpsPolicySpec;
}

function offsetMinutes(at: number, zone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value;
  if (name === 'GMT' || name === 'UTC') return 0;
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name ?? '');
  if (!m) throw new Error('unsupported_timezone_offset');
  return (m[1] === '+' ? 1 : -1) * (Number(m[2]!) * 60 + Number(m[3] ?? 0));
}

function localMinute(at: number, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function resolveLocal(date: string, time: string, zone: string, boundary: 'start' | 'end'): number {
  const naive = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 6)
    offsets.add(offsetMinutes(naive + delta * 3600_000, zone));
  const target = `${date}T${time}`;
  const candidates = [...offsets].map((offset) => naive - offset * 60_000);
  const matches = candidates.filter((at) => localMinute(at, zone) === target).sort((a, b) => a - b);
  if (matches.length) return boundary === 'start' ? matches[0]! : matches.at(-1)!;
  // Nonexistent local minute: move to the first valid local minute after a DST gap.
  const first = Math.min(...candidates) - 3 * 3600_000;
  const last = Math.max(...candidates) + 3 * 3600_000;
  for (let at = first - (first % 60_000); at <= last; at += 60_000) {
    const local = localMinute(at, zone);
    if (local.startsWith(date) && local >= target) return at;
  }
  throw new Error('unresolvable_local_time');
}

export function windowsForRange(policy: GpsPolicySpec, from: Date, until: Date): UtcWindow[] {
  if (
    policy.start_local === policy.end_local &&
    (!policy.mdm_continuous ||
      policy.start_local !== '00:00' ||
      policy.days_iso.length !== 7 ||
      new Set(policy.days_iso).size !== 7 ||
      (policy.exceptions?.length ?? 0) !== 0)
  )
    throw new Error('invalid_policy');
  const result: UtcWindow[] = [];
  const lower = Math.max(from.getTime(), Date.parse(policy.valid_from));
  const upper = Math.min(until.getTime(), Date.parse(policy.valid_until));
  if (lower >= upper) return result;
  const exceptions = new Map(policy.exceptions?.map((ex) => [ex.local_date, ex]) ?? []);
  const startDay = Date.parse(
    `${new Date(lower - 2 * 86400_000).toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const lastDay = upper + 2 * 86400_000;
  for (let day = startDay; day < lastDay; day += 86400_000) {
    const localDate = new Date(day).toISOString().slice(0, 10);
    const weekday = new Date(day).getUTCDay() || 7;
    const exception = exceptions.get(localDate);
    if (exception?.mode === 'OFF' || (!exception && !policy.days_iso.includes(weekday))) continue;
    const startLocal = exception?.mode === 'REPLACE' ? exception.start_local! : policy.start_local;
    const endLocal = exception?.mode === 'REPLACE' ? exception.end_local! : policy.end_local;
    const nextDate = new Date(day + 86400_000).toISOString().slice(0, 10);
    const start = resolveLocal(localDate, startLocal, policy.time_zone, 'start');
    const end = resolveLocal(
      endLocal <= startLocal ? nextDate : localDate,
      endLocal,
      policy.time_zone,
      'end',
    );
    const clippedStart = Math.max(start, lower);
    const clippedEnd = Math.min(end, upper);
    if (clippedStart < clippedEnd)
      result.push({
        local_date: localDate,
        start_at: new Date(clippedStart).toISOString(),
        end_at: new Date(clippedEnd).toISOString(),
      });
  }
  return result.sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
}
