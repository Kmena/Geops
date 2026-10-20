import type { Device } from './api/client.js';

/** Public identifiers only. The phone must still prove possession of its enrolled private key. */
export function activationQrPayload(
  device: Pick<Device, 'id' | 'key_id' | 'installation_id'>,
  origin: string,
  expiresAt: string,
): string {
  if (!device.key_id || !device.installation_id) throw new Error('activation_not_ready');
  return JSON.stringify({
    format: 'geops-activation-v1',
    origin,
    geops_device_id: device.id,
    key_id: device.key_id,
    installation_id: device.installation_id,
    expires_at: expiresAt,
  });
}
