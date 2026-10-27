import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from './errors.js';

export type GeocodingResult = { id: string; label: string; latitude: number; longitude: number };
type Fetcher = typeof fetch;
const invalid = () => new ApiError(422, 'invalid_geocoding_query', 'Invalid request');
const forbidden = () => new ApiError(403, 'geocoding_forbidden', 'Forbidden');
const unavailable = () => new ApiError(503, 'geocoding_unavailable', 'Geocoding unavailable');
const limited = () => new ApiError(429, 'geocoding_rate_limited', 'Try again later');
const PROVIDER = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'GEOPS-Geocoding/1.0 (+https://geops-staging.duckdns.org)';

/** Public Nominatim queries happen only after the administrator submits a search. */
export class GeocodingSearchService {
  constructor(
    private readonly pool: Pool,
    private readonly request: Fetcher = fetch,
  ) {}

  private async access(db: PoolClient, actorId: string): Promise<void> {
    const row = await db.query(
      `SELECT 1 FROM geops_operating_tenant t
       JOIN admin_user u ON u.id=$1 AND u.state='ACTIVE'
       JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.tenant_id=t.tenant_id AND a.revoked_at IS NULL
       JOIN admin_permission p ON p.admin_id=u.id AND p.permission='visit.catalog.read' AND p.revoked_at IS NULL
       WHERE t.singleton=true`,
      [actorId],
    );
    if (!row.rowCount) throw forbidden();
  }

  async search(actorId: string, input: string): Promise<{ items: GeocodingResult[] }> {
    const query = input.trim().replace(/\s+/g, ' ');
    if (
      query.length < 3 ||
      query.length > 160 ||
      [...input].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw invalid();
    if (process.env.GEOPS_GEOCODING_DISABLED === 'YES') throw unavailable();
    const digest = createHash('sha256').update(query.toLocaleLowerCase('es-GT')).digest();
    const db = await this.pool.connect();
    try {
      await this.access(db, actorId);
      const cached = await db.query<{ results: GeocodingResult[] }>(
        'SELECT results FROM geocoding_cache WHERE query_sha256=$1 AND expires_at>now()',
        [digest],
      );
      if (cached.rows[0]) return { items: cached.rows[0].results };
      await db.query('BEGIN');
      await this.access(db, actorId);
      const clock = await db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const actor = await db.query<{ window_start: Date; requests: number }>(
        'SELECT window_start,requests FROM geocoding_actor_bucket WHERE admin_id=$1 FOR UPDATE',
        [actorId],
      );
      const now = clock.rows[0]?.now;
      if (!now) throw unavailable();
      const previous = actor.rows[0];
      const activeWindow =
        previous !== undefined && now.getTime() - previous.window_start.getTime() < 60_000;
      if (activeWindow && previous.requests >= 20) throw limited();
      const slot = await db.query<{ permitted: boolean }>(
        'SELECT next_allowed_at <= clock_timestamp() AS permitted FROM geocoding_provider_slot WHERE singleton=true FOR UPDATE',
      );
      if (!slot.rows[0]?.permitted) throw limited();
      await db.query(
        "UPDATE geocoding_provider_slot SET next_allowed_at=clock_timestamp()+interval '1.1 seconds' WHERE singleton=true",
      );
      await db.query(
        `INSERT INTO geocoding_actor_bucket(admin_id,window_start,requests) VALUES($1,$2,$3)
         ON CONFLICT(admin_id) DO UPDATE SET window_start=$2,requests=$3`,
        [
          actorId,
          activeWindow ? previous.window_start : now,
          activeWindow ? previous.requests + 1 : 1,
        ],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }

    const url = new URL(PROVIDER);
    url.search = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '5',
      addressdetails: '0',
    }).toString();
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      throw unavailable();
    }
    if (response.status === 429) throw limited();
    if (!response.ok || Number(response.headers.get('content-length') ?? '0') > 128_000)
      throw unavailable();
    let raw: unknown;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 128_000) {
          await reader.cancel();
          throw unavailable();
        }
        chunks.push(part.value);
      }
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw unavailable();
    }
    if (!Array.isArray(raw)) throw unavailable();
    const items: GeocodingResult[] = raw.slice(0, 5).flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      const latitude = Number(item.lat),
        longitude = Number(item.lon);
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180 ||
        typeof item.display_name !== 'string' ||
        item.display_name.length > 500
      )
        return [];
      return [
        {
          id: `${String(item.osm_type ?? '')}:${String(item.osm_id ?? '')}`,
          label: item.display_name,
          latitude,
          longitude,
        },
      ];
    });
    await this.pool.query(
      `INSERT INTO geocoding_cache(query_sha256,results,expires_at) VALUES($1,$2,now()+interval '24 hours')
       ON CONFLICT(query_sha256) DO UPDATE SET results=EXCLUDED.results,fetched_at=now(),expires_at=EXCLUDED.expires_at`,
      [digest, JSON.stringify(items)],
    );
    return { items };
  }
}
