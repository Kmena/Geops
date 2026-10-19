import { groups, type Capability, type PolicyFixture } from './fixtures.js';

export const days = [
  { id: 1, label: 'Lun' },
  { id: 2, label: 'Mar' },
  { id: 3, label: 'Mié' },
  { id: 4, label: 'Jue' },
  { id: 5, label: 'Vie' },
  { id: 6, label: 'Sáb' },
  { id: 7, label: 'Dom' },
];

export function can(capabilities: readonly Capability[], permission: Capability): boolean {
  return capabilities.includes(permission);
}

export function assignedDevices(policy: Pick<PolicyFixture, 'deviceIds' | 'groupIds'>): string[] {
  return [
    ...new Set([
      ...policy.deviceIds,
      ...policy.groupIds.flatMap((id) => groups.find((group) => group.id === id)?.deviceIds ?? []),
    ]),
  ].sort();
}

export function assignmentConflicts(
  draft: PolicyFixture,
  others: readonly PolicyFixture[],
): string[] {
  const own = new Set(assignedDevices(draft));
  const conflicts = new Set<string>();
  for (const policy of others) {
    if (policy.id === draft.id || policy.state !== 'ACTIVE') continue;
    if (!(draft.validFrom < policy.validUntil && policy.validFrom < draft.validUntil)) continue;
    for (const device of assignedDevices(policy)) if (own.has(device)) conflicts.add(device);
  }
  return [...conflicts].sort();
}

export function validIanaZone(zone: string): boolean {
  if (zone === 'UTC') return true;
  if (!/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function validateDraft(draft: PolicyFixture): string[] {
  const errors: string[] = [];
  if (!draft.name.trim() || draft.name.length > 120)
    errors.push('El nombre debe tener entre 1 y 120 caracteres.');
  if (
    !draft.daysIso.length ||
    new Set(draft.daysIso).size !== draft.daysIso.length ||
    draft.daysIso.some((day) => day < 1 || day > 7)
  )
    errors.push('Selecciona días ISO válidos.');
  if (draft.startLocal === draft.endLocal) errors.push('Inicio y fin no pueden coincidir.');
  if (!validIanaZone(draft.timeZone)) errors.push('Selecciona una zona horaria IANA válida.');
  if (
    !Number.isInteger(draft.captureIntervalS) ||
    draft.captureIntervalS < 30 ||
    draft.captureIntervalS > 300
  )
    errors.push('GPS: entre 30 y 300 segundos.');
  if (
    !Number.isInteger(draft.syncIntervalS) ||
    draft.syncIntervalS < 60 ||
    draft.syncIntervalS > 900
  )
    errors.push('Sincronización: entre 60 y 900 segundos.');
  if (
    !Number.isInteger(draft.healthIntervalS) ||
    draft.healthIntervalS < 60 ||
    draft.healthIntervalS > 3600
  )
    errors.push('Salud: entre 60 y 3600 segundos.');
  if (
    !Number.isInteger(draft.heartbeatMissingAfterS) ||
    draft.heartbeatMissingAfterS < 300 ||
    draft.heartbeatMissingAfterS > 7200
  )
    errors.push('Silencio: entre 300 y 7200 segundos.');
  if (!draft.validFrom || !draft.validUntil || draft.validFrom >= draft.validUntil)
    errors.push('La vigencia UTC debe tener inicio anterior al fin.');
  return errors;
}

export function statusLabel(state: string): string {
  const labels: Record<string, string> = {
    ACTIVE: 'Publicada',
    DRAFT: 'Borrador local',
    PAUSED: 'Pausada',
    ONLINE: 'En línea',
    GPS_UNAVAILABLE: 'GPS no disponible',
    NO_COMMUNICATION: 'Sin comunicación',
    UNKNOWN: 'Desconocido',
    OPEN: 'Efectiva abierta',
    STOPPED: 'Efectiva cerrada',
    MISSED_START: 'Inicio fallido',
    INTERRUPTED: 'Interrumpida',
    PENDING: 'Programada',
  };
  return labels[state] ?? state;
}
