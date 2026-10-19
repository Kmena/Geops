/** Dedicated Staging hostname serves the Web and canonical API at root. */
export const webBase = import.meta.env?.BASE_URL ?? '/';

export function apiPath(path: `/v1/${string}`, base = webBase): string {
  if (base !== '/') throw new Error('Unsupported GEOPS Web base');
  return path;
}
