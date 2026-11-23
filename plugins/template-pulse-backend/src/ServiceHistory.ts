import type {
  BackstageCredentials,
  BackstageUserPrincipal,
  CacheService,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { InputError, NotAllowedError } from '@backstage/errors';
import type {
  Execution,
  ExecutionAnalytics,
  ExecutionQuery,
} from '@abayramli/backstage-plugin-template-pulse-common';
import {
  aggregateExecutions,
  type ExecutionHistory,
  type TeamMembersClient,
} from '@abayramli/backstage-plugin-template-pulse-node';
import type { ScaffolderTasksClient } from './ScaffolderTasksClient';
import { withAbort } from './withAbort';

type Task = Awaited<
  ReturnType<ScaffolderTasksClient['listTasks']>
>['items'][number];
type ServiceHistoryOptions = {
  scaffolder: Pick<ScaffolderTasksClient, 'listTasks' | 'getLogs'>;
  teams: Pick<TeamMembersClient, 'getMembers'>;
  cache: Pick<CacheService, 'get' | 'set'>;
  logger: Pick<LoggerService, 'debug'>;
};

function ownerRef(task: Task): string | undefined {
  // The HTTP task record also carries createdBy. Prefer it over the decorated
  // catalog identity; older Scaffolder service typings only declare spec.user.
  return (
    (task as Task & { createdBy?: string }).createdBy ?? task.spec.user?.ref
  );
}

async function mapLimited<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  signal: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        signal.throwIfAborted();
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

function taskMetadata(task: Task): Execution {
  return {
    id: task.id,
    templateRef: task.spec.templateInfo?.entityRef ?? 'unknown',
    templateName:
      task.spec.templateInfo?.entity?.metadata.title ??
      task.spec.templateInfo?.entity?.metadata.name ??
      task.spec.templateInfo?.entityRef ??
      'Unknown template',
    userRef: ownerRef(task),
    status: task.status,
    createdAt: task.createdAt,
  };
}

async function projectTask(
  task: Task,
  credentials: BackstageCredentials,
  callerRef: string,
  { scaffolder, cache, logger }: ServiceHistoryOptions,
  signal: AbortSignal,
  timingBudget: { remainingBytes: number },
): Promise<Execution> {
  signal.throwIfAborted();
  const execution = taskMetadata(task);

  if (!['completed', 'failed', 'cancelled'].includes(task.status))
    return execution;

  // Cache only the timing projection, scoped to the caller. Access is evaluated
  // on each request and task listing still uses the caller's credentials.
  const key = JSON.stringify([
    callerRef,
    task.id,
    task.status,
    task.lastHeartbeatAt,
  ]);
  try {
    const cached = await withAbort(cache.get<{ durationMs: number }>(key), signal);
    if (cached) return { ...execution, durationMs: cached.durationMs };
  } catch {
    signal.throwIfAborted();
    logger.debug(`Execution timing cache read failed for task ${task.id}`);
  }
  if (timingBudget.remainingBytes <= 0) return execution;

  try {
    const events = await withAbort(
      scaffolder.getLogs(
        { taskId: task.id },
        {
          credentials,
          signal,
          onBytes: size => {
            timingBudget.remainingBytes -= size;
            if (timingBudget.remainingBytes < 0)
              throw new Error('Analytics timing response budget exceeded');
          },
        },
      ),
      signal,
    );
    const end = events
      .filter(event => ['completion', 'cancelled'].includes(event.type))
      .filter(event => !event.body.status || event.body.status === task.status)
      .map(event => Date.parse(event.createdAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    const durationMs = end - Date.parse(task.createdAt);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      execution.durationMs = durationMs;
      await withAbort(cache.set(key, { durationMs }, { ttl: 60_000 }), signal);
    }
  } catch {
    signal.throwIfAborted();
    // Retained task metadata can outlive its events. Never infer a finish time
    // from a heartbeat, or send raw event messages to the dashboard.
    logger.debug(`Execution timing unavailable for task ${task.id}`);
  }
  return execution;
}

export class ServiceHistory implements ExecutionHistory {
  constructor(private readonly options: ServiceHistoryOptions) {}

  async search(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    maxTasks: number,
    signal = AbortSignal.timeout(30_000),
  ): Promise<ExecutionAnalytics> {
    if (query.allTime || query.offset || query.cursor) {
      throw new InputError(
        'All-history search and result pagination require the database history source.',
      );
    }
    const principal = credentials.principal as Partial<BackstageUserPrincipal> | undefined;
    if (principal?.type !== 'user' || typeof principal.userEntityRef !== 'string')
      throw new NotAllowedError('Execution analytics require user credentials');
    const callerRef = principal.userEntityRef;
    const { scope } = query;
    const teamMembers = query.teamRef
      ? new Set(
          await withAbort(
            this.options.teams.getMembers(query.teamRef, credentials, signal),
            signal,
          ),
        )
      : undefined;

    // Page the public service rather than relying on private Scaffolder tables.
    // Its task policy continues to apply, including administrator restrictions.
    const tasks = new Map<string, Task>();
    let sourceTotal: number | undefined;
    let offset = 0;
    let more = false;
    while (offset < maxTasks) {
      signal.throwIfAborted();
      const limit = Math.min(100, maxTasks - offset);
      const page = await withAbort(
        this.options.scaffolder.listTasks(
          {
            createdBy: scope === 'mine' ? callerRef : query.userRef,
            limit,
            offset,
          },
          { credentials, signal },
        ),
        signal,
      );
      sourceTotal = page.totalItems;
      for (const task of page.items) {
        if (
          (scope === 'all' || ownerRef(task) === callerRef) &&
          (!teamMembers || teamMembers.has(ownerRef(task) ?? ''))
        )
          tasks.set(task.id, task);
      }
      offset += page.items.length;
      more =
        sourceTotal === undefined
          ? page.items.length === limit
          : offset < sourceTotal;
      if (!page.items.length || !more) break;
    }

    const metadata = [...tasks.values()].map(taskMetadata);
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);
    // Apply cohort filters before reading timings; execution search/status are detail-only.
    // The public Scaffolder service does not support these filters itself.
    const cohort = [...tasks.values()].filter(task => {
      const row = taskMetadata(task);
      const date = Date.parse(row.createdAt);
      return (
        date >= from &&
        date < to &&
        (!query.templateRef || row.templateRef === query.templateRef) &&
        (!query.userRef || row.userRef === query.userRef)
      );
    });
    const timingBudget = { remainingBytes: 16 * 1024 * 1024 };
    const rows = await mapLimited(
      cohort,
      task =>
        projectTask(task, credentials, callerRef, this.options, signal, timingBudget),
      signal,
    );
    rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const result: ExecutionAnalytics = {
      scope,
      ...aggregateExecutions(rows, query, maxTasks),
      facets: {
        templates: [
          ...new Map(
            metadata.map(row => [
              row.templateRef,
              { id: row.templateRef, name: row.templateName },
            ]),
          ).values(),
        ].sort((a, b) => a.name.localeCompare(b.name)),
        users: [
          ...new Set(
            metadata
              .map(row => row.userRef)
              .filter((ref): ref is string => Boolean(ref)),
          ),
        ].sort(),
      },
      window: {
        historySource: 'service',
        limit: maxTasks,
        scanned: metadata.length,
        sourceTotal,
        truncated: more,
        oldestAt: metadata.map(row => row.createdAt).sort()[0],
        generatedAt: new Date().toISOString(),
      },
    };
    signal.throwIfAborted();
    return result;
  }
}
