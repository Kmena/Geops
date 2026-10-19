export type Capability =
  | 'gps.policy.read'
  | 'gps.policy.write'
  | 'gps.policy.assign'
  | 'gps.policy.activate'
  | 'gps.session.read'
  | 'gps.location.read'
  | 'gps.audit.read';

export type Evidence = 'OBSERVADO' | 'INFERIDO' | 'DESCONOCIDO';
export type PolicyState = 'ACTIVE' | 'DRAFT' | 'PAUSED';

export interface PolicyFixture {
  id: string;
  name: string;
  state: PolicyState;
  revision: number;
  daysIso: number[];
  startLocal: string;
  endLocal: string;
  timeZone: string;
  captureIntervalS: number;
  syncIntervalS: number;
  healthIntervalS: number;
  heartbeatMissingAfterS: number;
  validFrom: string;
  validUntil: string;
  deviceIds: string[];
  groupIds: string[];
  history: Array<{ revision: number; date: string; summary: string; state: string }>;
}

export interface HealthFact<T> {
  value: T | null;
  evidence: Evidence;
  observedAt: string | null;
}

export interface DeviceFixture {
  id: string;
  label: string;
  policyId: string | null;
  publishedRevision: number | null;
  appliedRevision: number | null;
  lastCommunication: HealthFact<string>;
  gps: HealthFact<string>;
  battery: HealthFact<number>;
  charging: HealthFact<string>;
  powerSave: HealthFact<string>;
  connectivity: HealthFact<string>;
  state: 'ONLINE' | 'GPS_UNAVAILABLE' | 'NO_COMMUNICATION' | 'UNKNOWN';
  possibleBatteryDepletion: boolean;
}

export interface SessionFixture {
  id: string;
  deviceId: string;
  window: string;
  scheduledStart: string;
  scheduledEnd: string;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  state: 'OPEN' | 'STOPPED' | 'MISSED_START' | 'INTERRUPTED' | 'PENDING';
  evidence: Evidence;
  interruption: string | null;
  pendingEvents: number;
  sync: string;
}

export const groups = [
  { id: 'ruta-norte', name: 'Ruta Norte', deviceIds: ['SYN-01', 'SYN-02'] },
  { id: 'soporte', name: 'Soporte', deviceIds: ['SYN-03'] },
] as const;

export const policies: PolicyFixture[] = [
  {
    id: 'POL-SYN-01',
    name: 'Jornada de campo',
    state: 'ACTIVE',
    revision: 3,
    daysIso: [1, 2, 3, 4, 5],
    startLocal: '08:00',
    endLocal: '17:00',
    timeZone: 'America/Guatemala',
    captureIntervalS: 60,
    syncIntervalS: 300,
    healthIntervalS: 300,
    heartbeatMissingAfterS: 900,
    validFrom: '2026-10-01T00:00',
    validUntil: '2026-12-31T23:59',
    deviceIds: [],
    groupIds: ['ruta-norte'],
    history: [
      {
        revision: 3,
        date: '19 oct 2026',
        summary: 'Frecuencia de salud separada',
        state: 'Publicada',
      },
      { revision: 2, date: '14 oct 2026', summary: 'Ajuste de sincronización', state: 'Histórica' },
      {
        revision: 1,
        date: '08 oct 2026',
        summary: 'Primera definición sintética',
        state: 'Histórica',
      },
    ],
  },
  {
    id: 'POL-SYN-02',
    name: 'Soporte vespertino',
    state: 'ACTIVE',
    revision: 1,
    daysIso: [1, 2, 3, 4, 5],
    startLocal: '13:00',
    endLocal: '21:00',
    timeZone: 'America/Guatemala',
    captureIntervalS: 120,
    syncIntervalS: 600,
    healthIntervalS: 600,
    heartbeatMissingAfterS: 1200,
    validFrom: '2026-10-01T00:00',
    validUntil: '2026-12-31T23:59',
    deviceIds: ['SYN-03'],
    groupIds: [],
    history: [
      {
        revision: 1,
        date: '10 oct 2026',
        summary: 'Primera definición sintética',
        state: 'Publicada',
      },
    ],
  },
];

const observed = <T>(value: T, at: string): HealthFact<T> => ({
  value,
  evidence: 'OBSERVADO',
  observedAt: at,
});
const inferred = <T>(value: T, at: string): HealthFact<T> => ({
  value,
  evidence: 'INFERIDO',
  observedAt: at,
});
const unknown = <T>(): HealthFact<T> => ({
  value: null,
  evidence: 'DESCONOCIDO',
  observedAt: null,
});

export const devices: DeviceFixture[] = [
  {
    id: 'SYN-01',
    label: 'Equipo de prueba 01',
    policyId: 'POL-SYN-01',
    publishedRevision: 3,
    appliedRevision: 3,
    lastCommunication: observed('Hace 4 min', '19 oct · 10:42'),
    gps: observed('Disponible', '19 oct · 10:41'),
    battery: observed(72, '19 oct · 10:41'),
    charging: observed('No', '19 oct · 10:41'),
    powerSave: observed('Desactivado', '19 oct · 10:41'),
    connectivity: observed('Conectado', '19 oct · 10:41'),
    state: 'ONLINE',
    possibleBatteryDepletion: false,
  },
  {
    id: 'SYN-02',
    label: 'Equipo de prueba 02',
    policyId: 'POL-SYN-01',
    publishedRevision: 3,
    appliedRevision: 2,
    lastCommunication: inferred('Sin comunicación', '19 oct · 09:12'),
    gps: unknown<string>(),
    battery: observed(2, '19 oct · 09:12'),
    charging: observed('No', '19 oct · 09:12'),
    powerSave: observed('Activado', '19 oct · 09:12'),
    connectivity: unknown<string>(),
    state: 'NO_COMMUNICATION',
    possibleBatteryDepletion: true,
  },
  {
    id: 'SYN-03',
    label: 'Equipo de prueba 03',
    policyId: 'POL-SYN-02',
    publishedRevision: 1,
    appliedRevision: null,
    lastCommunication: unknown<string>(),
    gps: observed('No disponible', '19 oct · 13:04'),
    battery: unknown<number>(),
    charging: unknown<string>(),
    powerSave: unknown<string>(),
    connectivity: observed('Conectado', '19 oct · 13:04'),
    state: 'GPS_UNAVAILABLE',
    possibleBatteryDepletion: false,
  },
];

export const sessions: SessionFixture[] = [
  {
    id: 'SES-SYN-01',
    deviceId: 'SYN-01',
    window: '19 oct · jornada',
    scheduledStart: '08:00',
    scheduledEnd: '17:00',
    effectiveStart: '08:03',
    effectiveEnd: null,
    state: 'OPEN',
    evidence: 'OBSERVADO',
    interruption: null,
    pendingEvents: 0,
    sync: 'ACK 10:42',
  },
  {
    id: 'SES-SYN-02',
    deviceId: 'SYN-02',
    window: '19 oct · jornada',
    scheduledStart: '08:00',
    scheduledEnd: '17:00',
    effectiveStart: '08:06',
    effectiveEnd: null,
    state: 'INTERRUPTED',
    evidence: 'OBSERVADO',
    interruption: 'Proveedor GPS no disponible',
    pendingEvents: 3,
    sync: 'Pendiente desde 09:12',
  },
  {
    id: 'SES-SYN-03',
    deviceId: 'SYN-03',
    window: '19 oct · tarde',
    scheduledStart: '13:00',
    scheduledEnd: '21:00',
    effectiveStart: null,
    effectiveEnd: null,
    state: 'MISSED_START',
    evidence: 'OBSERVADO',
    interruption: 'Inicio FGS rechazado',
    pendingEvents: 1,
    sync: 'Evento pendiente',
  },
  {
    id: 'SES-SYN-04',
    deviceId: 'SYN-01',
    window: '18 oct · jornada',
    scheduledStart: '08:00',
    scheduledEnd: '17:00',
    effectiveStart: '08:04',
    effectiveEnd: '17:01',
    state: 'STOPPED',
    evidence: 'OBSERVADO',
    interruption: null,
    pendingEvents: 0,
    sync: 'ACK completo',
  },
  {
    id: 'SES-SYN-05',
    deviceId: 'SYN-02',
    window: '20 oct · jornada',
    scheduledStart: '08:00',
    scheduledEnd: '17:00',
    effectiveStart: null,
    effectiveEnd: null,
    state: 'PENDING',
    evidence: 'DESCONOCIDO',
    interruption: null,
    pendingEvents: 0,
    sync: 'No iniciada',
  },
];

export const historicalExperiment = {
  positions: 543,
  inferredSessions: 4,
  cadenceWithinTolerance: '81.82%',
  lateSyncs: 84,
  note: 'Referencia agregada del experimento de fin de semana. Las sesiones fueron inferidas; no son evidencia de sesiones efectivas.',
} as const;

export const fixtureCapabilities: Capability[] = [
  'gps.policy.read',
  'gps.policy.write',
  'gps.policy.assign',
  'gps.session.read',
];
