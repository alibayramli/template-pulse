import type { Knex } from 'knex';
import { ServiceUnavailableError } from '@backstage/errors';

export type RunHistoryQuery = <T>(query: PromiseLike<T> & {
  timeout: (milliseconds: number) => PromiseLike<T>;
}) => Promise<T>;

const REQUEST_TIMEOUT_MS = 15_000;
const STATEMENT_TIMEOUT_MS = 5_000;

/** Bound the work using Scaffolder's pool, including requests waiting for a connection. */
export class HistoryWorkload {
  private active = 0;

  async run<T>(
    db: Knex,
    postgres: boolean,
    signal: AbortSignal | undefined,
    action: (transaction: Knex, run: RunHistoryQuery) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 2)
      throw new ServiceUnavailableError('History analytics are busy. Try again shortly.');
    this.active++;
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let connection: Awaited<ReturnType<Knex.Client['acquireConnection']>>;
    let acquiring: Promise<unknown> | undefined;
    let acquisitionSettled = true;
    const timer = setTimeout(() => {
      controller.abort();
      if (connection && postgres) {
        // BEGIN/COMMIT are outside run(). Dispose the owned pg connection at
        // the overall deadline too; Client.end closes an active query's socket.
        connection.__knex__disposed = new Error('History analytics deadline exceeded');
        void Promise.resolve(connection.end()).catch(() => {});
      }
    }, REQUEST_TIMEOUT_MS);
    const check = () => {
      if (controller.signal.aborted || Date.now() >= deadline)
        throw new ServiceUnavailableError(
          'History analytics exceeded their time limit. Narrow the date range or filters and try again.',
        );
    };
    try {
      check();
      acquiring = Promise.resolve(db.client.acquireConnection());
      acquisitionSettled = false;
      connection = await new Promise((resolve, reject) => {
        const onAbort = () => reject(new ServiceUnavailableError('History analytics timed out waiting for the database.'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        acquiring!.then(
          acquired => {
            acquisitionSettled = true;
            controller.signal.removeEventListener('abort', onAbort);
            if (controller.signal.aborted) {
              void db.client.releaseConnection(acquired);
              onAbort();
            } else resolve(acquired);
          },
          error => {
            acquisitionSettled = true;
            controller.signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
        if (controller.signal.aborted) onAbort();
      });
      return await db.transaction(
        async transaction => {
          const run: RunHistoryQuery = async query => {
            check();
            if (postgres) {
              await transaction.raw("SELECT set_config('statement_timeout', ?, true)", [
                String(Math.max(1, Math.min(STATEMENT_TIMEOUT_MS, deadline - Date.now()))),
              ]).timeout(Math.max(1, Math.min(STATEMENT_TIMEOUT_MS + 1_000, deadline - Date.now())));
              check();
            }
            // The server bounds an in-flight PostgreSQL statement even after
            // disconnect. Stop at the next boundary without opening a second
            // connection for cancellation. Knex disposes timed-out connections.
            const result = await query.timeout(Math.max(1, Math.min(STATEMENT_TIMEOUT_MS + 1_000, deadline - Date.now())));
            check();
            return result;
          };
          return action(transaction, run);
        },
        {
          connection,
          ...(postgres ? { isolationLevel: 'repeatable read' as const, readOnly: true } : {}),
        },
      );
    } catch (error) {
      if (controller.signal.aborted || (error as { code?: string }).code === '57014' || (error as Error).name === 'KnexTimeoutError')
        throw new ServiceUnavailableError(
          'History analytics exceeded their time limit. Narrow the date range or filters and try again.',
        );
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (connection) await db.client.releaseConnection(connection);
      if (acquiring && !acquisitionSettled) {
        // An abandoned Knex pool acquisition still exists. Keep its slot until
        // it settles so repeated disconnects cannot grow an unbounded queue.
        void acquiring.then(() => this.active--, () => this.active--);
      } else this.active--;
    }
  }
}
