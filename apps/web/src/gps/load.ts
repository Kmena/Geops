import { ApiClientError } from '../api/client.js';
import type { GpsRemote, RemoteGpsDevice, RemotePolicy } from './remote.js';

export interface GpsOverview {
  capabilities: string[];
  policies: RemotePolicy[];
  devices: RemoteGpsDevice[];
}

export function gpsReadErrorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError))
    return 'No se pudo completar la consulta. Inténtalo de nuevo.';
  if (error.status === 0) return 'No hay conexión con el servidor. Comprueba la red y reintenta.';
  if (error.status === 401) return 'La sesión expiró. Vuelve a iniciar sesión.';
  if (error.status === 403) return 'No tienes la capacidad necesaria para esta consulta.';
  if (error.status === 409) return 'Los datos cambiaron. Actualiza la vista antes de continuar.';
  if (error.status === 429) return 'Se alcanzó la cuota. Espera antes de reintentar.';
  if (error.code === 'invalid_response')
    return 'El servidor devolvió una respuesta GPS inválida. Reintenta o informa al administrador.';
  if (error.status === 404) return 'El dispositivo no está disponible en tu tenant.';
  if (error.status >= 500) return 'El servicio GPS no está disponible. Reintenta más tarde.';
  return 'Consulta inválida o servicio no disponible.';
}

export async function loadGpsOverview(
  remote: GpsRemote,
  signal: AbortSignal,
  onCapabilities: (capabilities: string[], tenantIds: string[]) => void,
): Promise<GpsOverview> {
  const { capabilities, tenant_ids } = await remote.capabilities(signal);
  onCapabilities(capabilities, tenant_ids);
  const [policyPage, devicePage] = await Promise.all([
    capabilities.includes('gps.policy.read')
      ? remote.policies(undefined, signal)
      : Promise.resolve({ items: [], next_cursor: null }),
    capabilities.includes('gps.session.read')
      ? remote.devices(signal)
      : Promise.resolve({ items: [] }),
  ]);
  return { capabilities, policies: policyPage.items, devices: devicePage.items };
}
