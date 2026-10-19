/** Public browser prefix. The API itself keeps its canonical /v1 routes. */
export const webBase = import.meta.env?.BASE_URL ?? '/';

export function apiPath(path: `/v1/${string}`, base = webBase): string {
  if (base !== '/' && base !== '/staging/') throw new Error('Unsupported GEOPS Web base');
  return `${base.slice(0, -1)}${path}`;
}
