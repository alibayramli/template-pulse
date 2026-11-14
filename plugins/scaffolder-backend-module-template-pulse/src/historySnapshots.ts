import { createHash, randomUUID } from 'node:crypto';
import type { CacheService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import type { ExecutionQuery } from '@abayramli/backstage-plugin-template-pulse-common';
import type { QueryPermissionResponse } from '@backstage/plugin-permission-common';

const TTL_MS = 120_000;
export const MAX_SNAPSHOT_IDS = 50_000;
const MAX_TOTAL_IDS = 200_000;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
type Snapshot = { ids: string[]; binding: string; expiresAt: number };
type Reservation = { count: number; bytes: number; caller: string; expiresAt: number; pending: boolean };

async function cacheOperation<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('History snapshot cache timed out')), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function snapshotBinding(
  query: ExecutionQuery & { teamMembers?: string[] },
  caller: string,
  decision: QueryPermissionResponse,
  limit: number,
) {
  return createHash('sha256').update(JSON.stringify({
    caller, decision, limit,
    scope: query.scope, from: query.from, to: query.to,
    templateRef: query.templateRef, userRef: query.userRef, teamRef: query.teamRef,
    teamMembers: query.teamMembers ? [...query.teamMembers].sort() : undefined,
    status: query.status, query: query.query || undefined, allTime: Boolean(query.allTime),
    sortBy: query.sortBy ?? 'createdAt', sortDirection: query.sortDirection ?? 'descending',
  })).digest('hex');
}

/** Stores only ordered IDs; every page still queries the currently authorized task rows. */
export class HistorySnapshots {
  private readonly local = new Map<string, Snapshot>();
  private readonly reservations = new Map<string, Reservation>();

  constructor(private readonly cache?: CacheService) {}

  private prune() {
    for (const [id, entry] of this.reservations) {
      if (entry.expiresAt <= Date.now()) {
        this.reservations.delete(id);
        this.local.delete(id);
      }
    }
  }

  async create(ids: string[], binding: string, caller: string): Promise<string | undefined> {
    this.prune();
    const callerEntries = [...this.reservations].filter(([, entry]) => entry.caller === caller);
    if (callerEntries.length >= 4) {
      const oldestEntry = callerEntries.find(([, entry]) => !entry.pending);
      if (!oldestEntry) return undefined;
      const [oldest] = oldestEntry;
      try {
        if (this.cache) await cacheOperation(this.cache.delete(`history-snapshot:${oldest}`));
      } catch {
        return undefined;
      }
      this.reservations.delete(oldest);
      this.local.delete(oldest);
    }
    const entries = [...this.reservations.values()];
    const bytes = Buffer.byteLength(JSON.stringify(ids));
    if (
      ids.length > MAX_SNAPSHOT_IDS ||
      entries.length >= 32 ||
      entries.filter(entry => entry.caller === caller).length >= 4 ||
      ids.length + entries.reduce((sum, entry) => sum + entry.count, 0) > MAX_TOTAL_IDS ||
      bytes + entries.reduce((sum, entry) => sum + entry.bytes, 0) > MAX_TOTAL_BYTES
    ) return undefined;
    const id = randomUUID();
    const expiresAt = Date.now() + TTL_MS;
    const record = { ids, binding, expiresAt };
    const reservation = { count: ids.length, bytes, caller, expiresAt, pending: true };
    this.reservations.set(id, reservation);
    try {
      if (this.cache) await cacheOperation(this.cache.set(`history-snapshot:${id}`, record, { ttl: TTL_MS }));
      else this.local.set(id, record);
      reservation.pending = false;
      return id;
    } catch {
      // A timed-out write can still finish. Keep its budget reserved until the
      // absolute expiry, and never evict it while the outcome is uncertain.
      return undefined;
    }
  }

  async read(cursor: string, binding: string): Promise<{ id: string; ids: string[]; offset: number }> {
    this.prune();
    const match = /^([a-f0-9-]{36})\.(\d{1,6})$/.exec(cursor);
    const expired = () => new InputError('History cursor expired. Reload this view.');
    if (!match) throw expired();
    const id = match[1];
    let record: Snapshot | undefined;
    try {
      record = this.cache
        ? await cacheOperation(this.cache.get<Snapshot>(`history-snapshot:${id}`))
        : this.local.get(id);
    } catch {
      throw expired();
    }
    const offset = Number(match[2]);
    if (!record || record.expiresAt <= Date.now() || record.binding !== binding || offset > record.ids.length)
      throw expired();
    return { id, ids: record.ids, offset };
  }
}
