import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

export interface AuditRecord {
  actorType: 'ADMIN' | 'DEVICE' | 'SYSTEM';
  actorId?: string;
  deviceId?: string;
  action: string;
  outcome: 'success' | 'rejected' | 'failure';
  correlationId: string;
  previousState?: string;
  nextState?: string;
  metadata?: Record<string, string | number | boolean>;
}

export async function appendAudit(db: Queryable, event: AuditRecord): Promise<void> {
  await db.query(
    'INSERT INTO audit_event(id,actor_type,actor_id,device_id,action,outcome,correlation_id,previous_state,next_state,metadata_redacted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      randomUUID(),
      event.actorType,
      event.actorId ?? null,
      event.deviceId ?? null,
      event.action,
      event.outcome,
      event.correlationId,
      event.previousState ?? null,
      event.nextState ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}
