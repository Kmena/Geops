import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Pool } from 'pg';
import { VisitEvaluationService } from '../src/visit-evaluation.js';

const prior = {
  mode: process.env.GEOPS_DATA_MODE,
  origin: process.env.GEOPS_ALLOWED_ORIGINS,
  cookie: process.env.GEOPS_ADMIN_COOKIE_NAME,
};
after(() => {
  process.env.GEOPS_DATA_MODE = prior.mode;
  process.env.GEOPS_ALLOWED_ORIGINS = prior.origin;
  process.env.GEOPS_ADMIN_COOKIE_NAME = prior.cookie;
});

test('historical technical preview computes dwell without writing visit evaluations', async () => {
  process.env.GEOPS_DATA_MODE = 'synthetic';
  process.env.GEOPS_ALLOWED_ORIGINS = 'https://geops-staging.duckdns.org';
  process.env.GEOPS_ADMIN_COOKIE_NAME = '__Host-geops_stage_admin';
  const writes: string[] = [];
  const sample = (eventId: string, capturedAt: string, moveDistance: number | null) => ({
    device_id: '33333333-3333-4333-8333-333333333333',
    event_id: eventId,
    session_id: '44444444-4444-4444-8444-444444444444',
    link_id: '55555555-5555-4555-8555-555555555555',
    capture_anchor_id: '66666666-6666-4666-8666-666666666666',
    boot_id: '77777777-7777-4777-8777-777777777777',
    captured_at: new Date(capturedAt),
    received_at: new Date(capturedAt),
    payload_digest: Buffer.alloc(32),
    accuracy_m: 5,
    quality_state: 'DEVICE_REPORTED',
    distance_m: 20,
    move_distance_m: moveDistance,
  });
  const client = {
    release() {},
    async query(sql: string) {
      if (/^(INSERT|UPDATE|DELETE)/.test(sql)) {
        writes.push(sql);
        if (!sql.startsWith('INSERT INTO audit_event')) throw new Error('Historical data write');
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM geops_operating_tenant'))
        return { rows: [{ tenant_id: 'stage' }], rowCount: 1 };
      if (sql.includes('current_database()')) return { rows: [{ name: 'geops_dev' }], rowCount: 1 };
      if (sql.includes("permission IN ('gps.location.read','visit.device.read')"))
        return {
          rows: [{ permission: 'gps.location.read' }, { permission: 'visit.device.read' }],
          rowCount: 2,
        };
      if (sql.includes('FROM route_assignment WHERE'))
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              agent_id: '88888888-8888-4888-8888-888888888888',
              state: 'PLANNED',
              starts_at: new Date('2026-10-29T00:00:00Z'),
              ends_at: new Date('2026-10-29T04:00:00Z'),
              snapshot_hash: 'a'.repeat(64),
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('FROM assignment_visit WHERE'))
        return {
          rows: [
            {
              stop_id: '22222222-2222-4222-8222-222222222222',
              geofence_revision: 1,
              latitude: 9.9,
              longitude: -84.1,
              radius_m: 100,
              min_dwell_effective_s: 600,
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('FROM visit_algorithm_revision'))
        return {
          rows: [
            {
              scope: 'TECHNICAL_ONLY',
              parameters: {
                max_gap_s: 300,
                credit_cap_s: 300,
                uncertainty_guard_s: 0,
                max_accuracy_m: 25,
                boundary_tolerance_m: 0,
                max_speed_m_s: 50,
                coverage_min_fraction: null,
                non_compliance_enabled: false,
              },
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('SELECT 1 FROM agent_device_link'))
        return { rows: [{ one: 1 }], rowCount: 1 };
      if (sql.includes('FROM position_event p JOIN agent_device_link'))
        return {
          rows: [
            sample('99999999-9999-4999-8999-999999999999', '2026-10-29T00:10:00Z', null),
            sample('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-10-29T00:15:00Z', 0),
          ],
          rowCount: 2,
        };
      if (sql.includes('FROM gps_session_event')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const service = new VisitEvaluationService(pool, () => new Date('2026-10-30T03:00:00Z'));
  const preview = await service.technicalPreview(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'Simulación técnica de SILA',
  );
  assert.equal(preview.persisted, false);
  assert.equal(preview.non_compliance_enabled, false);
  assert.equal(preview.algorithm_scope, 'TECHNICAL_ONLY');
  assert.equal(preview.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(preview.credited_s, 300);
  assert.equal(preview.sample_count, 2);
  assert.equal(preview.credited_intervals.length, 1);
  assert.equal(writes.length, 1);
  assert.ok(writes[0]?.startsWith('INSERT INTO audit_event'));
});
