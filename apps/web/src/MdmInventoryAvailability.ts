import type { MdmStatus } from './api/client.js';

export function mdmInventoryAvailability(status: MdmStatus | null): {
  loadDevices: boolean;
  message: string | null;
} {
  if (!status) return { loadDevices: false, message: null };
  if (status.oauth_configured === false)
    return { loadDevices: false, message: 'Servicio ManageEngine sin configurar.' };
  if (status.provider === 'manageengine' && !status.authorized)
    return { loadDevices: false, message: 'ManageEngine no conectado.' };
  return { loadDevices: true, message: null };
}
