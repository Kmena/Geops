import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.mjs';
import { validateBatch } from '../validation.mjs';

test('PostGIS aislado: inscripción, persistencia, idempotencia, revocación y retención', async () => {
  if (
    process.env.POC_TEST_MODE !== 'synthetic' ||
    process.env.POC_PUBLIC_ORIGIN !== 'http://127.0.0.1:3601' ||
    process.env.POC_CAPTURE_ENABLED !== 'false' ||
    !process.env.POC_DATABASE_URL?.endsWith('/geops_poc')
  )
    throw new Error('Integration test requires local synthetic PoC database with capture disabled');
  const store = new Store(process.env.POC_DATABASE_URL, 1);
  let deviceId = null,
    invitationId = null;
  try {
    await store.health();
    const current = await store.devices();
    assert.equal(current.length, 0, 'Only run in an empty synthetic PoC database');
    const invitation = await store.issueInvitation();
    invitationId = invitation.invitation_id;
    const enrollment = await store.enroll(invitation);
    deviceId = enrollment.device_id;
    await assert.rejects(store.enroll(invitation), { code: 'invitation_used' });
    assert.equal((await store.deviceForToken(enrollment.device_token)).id, deviceId);
    const earlier = {
      event_id: randomUUID(),
      captured_at: new Date(Date.now() - 60_000).toISOString(),
      latitude: 0.01,
      longitude: 0.02,
      accuracy_m: 10,
    };
    const later = {
      event_id: randomUUID(),
      captured_at: new Date().toISOString(),
      latitude: 0.03,
      longitude: 0.04,
      accuracy_m: 8,
    };
    const batch = validateBatch({
      schema_version: 1,
      batch_id: randomUUID(),
      events: [later, earlier],
    });
    const first = await store.ingest(deviceId, batch);
    assert.deepEqual(first.accepted_event_ids, [later.event_id, earlier.event_id]);
    const retry = await store.ingest(deviceId, batch);
    assert.deepEqual(retry.duplicate_event_ids, [later.event_id, earlier.event_id]);
    const history = await store.history(deviceId, {
      from: new Date(Date.now() - 120_000).toISOString(),
      to: new Date(Date.now() + 1000).toISOString(),
    });
    assert.deepEqual(
      history.map((item) => item.event_id),
      [earlier.event_id, later.event_id],
    );
    assert.equal(Number(history[0].latitude), earlier.latitude);
    assert.equal(Number(history[0].longitude), earlier.longitude);
    const conflict = validateBatch({
      schema_version: 1,
      batch_id: randomUUID(),
      events: [{ ...earlier, longitude: 0.06 }],
    });
    await assert.rejects(store.ingest(deviceId, conflict), { code: 'event_conflict' });
    await store.revoke(deviceId);
    assert.ok((await store.deviceForToken(enrollment.device_token)).revoked_at);
    await assert.rejects(store.ingest(deviceId, batch), { code: 'device_revoked' });
    await store.pool.query(
      "UPDATE poc_location SET received_at=now()-interval '4 hours' WHERE device_id=$1",
      [deviceId],
    );
    assert.equal(await store.purge(3), 2);
  } finally {
    if (deviceId) {
      await store.pool.query('DELETE FROM poc_location WHERE device_id=$1', [deviceId]);
      await store.pool.query('DELETE FROM poc_device WHERE id=$1', [deviceId]);
    }
    if (invitationId)
      await store.pool.query('DELETE FROM poc_invitation WHERE id=$1', [invitationId]);
    await store.close();
  }
});
