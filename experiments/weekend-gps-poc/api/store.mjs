import pg from 'pg';
import { ENV_ID, POCError, id, secret, sha256 } from './validation.mjs';

export class Store {
  constructor(connectionString, maxDevices = 1) {
    this.pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
    this.maxDevices = maxDevices;
  }
  async close() {
    await this.pool.end();
  }
  async health() {
    await this.pool.query('SELECT PostGIS_Version()');
  }
  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async issueInvitation() {
    return this.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('geops-poc-enrollment'))");
      const count = await db.query(
        'SELECT count(*)::int AS n FROM poc_device WHERE revoked_at IS NULL',
      );
      if (count.rows[0].n >= this.maxDevices) throw new POCError(409, 'device_limit');
      await db.query(
        'UPDATE poc_invitation SET cancelled_at=now() WHERE consumed_at IS NULL AND cancelled_at IS NULL',
      );
      const invitation_id = id(),
        invitation_secret = secret();
      const saved = await db.query(
        "INSERT INTO poc_invitation(id,environment_id,secret_hash,expires_at) VALUES ($1,$2,$3,now()+interval '10 minutes') RETURNING expires_at",
        [invitation_id, ENV_ID, sha256(invitation_secret)],
      );
      return {
        environment_id: ENV_ID,
        invitation_id,
        invitation_secret,
        expires_at: saved.rows[0].expires_at,
      };
    });
  }
  async enroll(input) {
    return this.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('geops-poc-enrollment'))");
      const invitation = await db.query('SELECT * FROM poc_invitation WHERE id=$1 FOR UPDATE', [
        input.invitation_id,
      ]);
      const row = invitation.rows[0];
      if (
        !row ||
        row.environment_id !== ENV_ID ||
        row.secret_hash !== sha256(input.invitation_secret)
      )
        throw new POCError(401, 'invalid_invitation');
      if (row.consumed_at || row.cancelled_at) throw new POCError(409, 'invitation_used');
      if (new Date(row.expires_at).getTime() <= Date.now())
        throw new POCError(410, 'invitation_expired');
      const count = await db.query(
        'SELECT count(*)::int AS n FROM poc_device WHERE revoked_at IS NULL',
      );
      if (count.rows[0].n >= this.maxDevices) throw new POCError(409, 'device_limit');
      const device_id = id(),
        device_token = secret();
      await db.query('INSERT INTO poc_device(id,environment_id,token_hash) VALUES ($1,$2,$3)', [
        device_id,
        ENV_ID,
        sha256(device_token),
      ]);
      await db.query('UPDATE poc_invitation SET consumed_at=now() WHERE id=$1', [
        input.invitation_id,
      ]);
      return { environment_id: ENV_ID, device_id, device_token };
    });
  }
  async deviceForToken(token) {
    const result = await this.pool.query(
      'SELECT id,revoked_at FROM poc_device WHERE token_hash=$1 AND environment_id=$2',
      [sha256(token), ENV_ID],
    );
    return result.rows[0] ?? null;
  }
  async devices() {
    const result = await this.pool.query(
      'SELECT d.id,d.enrolled_at,d.revoked_at,max(l.captured_at) AS last_capture,max(l.received_at) AS last_received,count(l.event_id)::int AS location_count FROM poc_device d LEFT JOIN poc_location l ON l.device_id=d.id GROUP BY d.id ORDER BY d.enrolled_at DESC',
    );
    return result.rows;
  }
  async revoke(deviceId) {
    const result = await this.pool.query(
      'UPDATE poc_device SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 RETURNING id',
      [deviceId],
    );
    if (!result.rowCount) throw new POCError(404, 'device_not_found');
    return { status: 'revoked' };
  }
  async ingest(deviceId, batch) {
    return this.transaction(async (db) => {
      const active = await db.query(
        'SELECT id FROM poc_device WHERE id=$1 AND revoked_at IS NULL FOR UPDATE',
        [deviceId],
      );
      if (!active.rowCount) throw new POCError(403, 'device_revoked');
      const accepted_event_ids = [],
        duplicate_event_ids = [];
      for (const event of batch.events) {
        const inserted = await db.query(
          'INSERT INTO poc_location(device_id,event_id,captured_at,geom,accuracy_m,digest) VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,$6,$7) ON CONFLICT DO NOTHING RETURNING event_id',
          [
            deviceId,
            event.event_id,
            event.captured_at,
            event.longitude,
            event.latitude,
            event.accuracy_m,
            event.digest,
          ],
        );
        if (inserted.rowCount) accepted_event_ids.push(event.event_id);
        else {
          const old = await db.query(
            'SELECT digest FROM poc_location WHERE device_id=$1 AND event_id=$2',
            [deviceId, event.event_id],
          );
          if (old.rows[0]?.digest !== event.digest) throw new POCError(409, 'event_conflict');
          duplicate_event_ids.push(event.event_id);
        }
      }
      return {
        batch_id: batch.batch_id,
        accepted_event_ids,
        duplicate_event_ids,
        persisted_at: new Date().toISOString(),
      };
    });
  }
  async latest(deviceId) {
    const result = await this.pool.query(
      'SELECT event_id,captured_at,received_at,ST_Y(geom::geometry) AS latitude,ST_X(geom::geometry) AS longitude,accuracy_m FROM poc_location WHERE device_id=$1 ORDER BY captured_at DESC,event_id DESC LIMIT 1',
      [deviceId],
    );
    return result.rows[0] ?? null;
  }
  async history(deviceId, range) {
    const result = await this.pool.query(
      'SELECT event_id,captured_at,received_at,ST_Y(geom::geometry) AS latitude,ST_X(geom::geometry) AS longitude,accuracy_m FROM poc_location WHERE device_id=$1 AND captured_at >= $2 AND captured_at <= $3 ORDER BY captured_at ASC,event_id ASC LIMIT 5000',
      [deviceId, range.from, range.to],
    );
    return result.rows;
  }
  async metrics(deviceId, range) {
    const result = await this.pool.query(
      "SELECT count(*)::int AS location_count,avg(accuracy_m)::float AS average_accuracy_m,max(received_at) AS last_received,count(*) FILTER (WHERE received_at-captured_at > interval '2 minutes')::int AS delayed_count FROM poc_location WHERE device_id=$1 AND captured_at >= $2 AND captured_at <= $3",
      [deviceId, range.from, range.to],
    );
    const intervals = await this.pool.query(
      'SELECT avg(gap)::float AS average_interval_seconds,max(gap)::float AS max_interval_seconds FROM (SELECT extract(epoch FROM captured_at-lag(captured_at) OVER (ORDER BY captured_at,event_id)) AS gap FROM poc_location WHERE device_id=$1 AND captured_at >= $2 AND captured_at <= $3) q',
      [deviceId, range.from, range.to],
    );
    return { ...result.rows[0], ...intervals.rows[0] };
  }
  async purge(retentionHours) {
    const result = await this.pool.query(
      "DELETE FROM poc_location WHERE received_at < now() - ($1::int * interval '1 hour')",
      [retentionHours],
    );
    return result.rowCount;
  }
}
