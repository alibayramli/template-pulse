import type {
  CacheService,
  HttpAuthService,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { InputError, ServiceUnavailableError } from '@backstage/errors';
import type { Request, Response } from 'express';
import Router from 'express-promise-router';
import {
  executionsReadAllPermission,
  executionsReadPermission,
  type Execution,
  type ExecutionAnalytics,
} from '@abayramli/backstage-plugin-template-pulse-common';
import {
  aggregateExecutions,
  authorizeExecutionQuery,
  parseExecutionFacetQuery,
  parseExecutionQuery,
  type ExecutionHistory,
  type TeamMembersClient,
} from '@abayramli/backstage-plugin-template-pulse-node';
import type { ScaffolderTasksClient } from './ScaffolderTasksClient';

type Task = Awaited<
  ReturnType<ScaffolderTasksClient['listTasks']>
>['items'][number];
type Credentials = Parameters<ScaffolderTasksClient['listTasks']>[1]['credentials'];
type Options = {
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  scaffolder: Pick<ScaffolderTasksClient, 'listTasks' | 'getLogs'>;
  cache: CacheService;
  logger: LoggerService;
  maxTasks: number;
  history?: ExecutionHistory;
  teams: Pick<TeamMembersClient, 'getMembers'>;
};

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

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
  credentials: Credentials,
  callerRef: string,
  { scaffolder, cache, logger }: Options,
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
  const cached = await withAbort(cache.get<{ durationMs: number }>(key), signal);
  if (cached) return { ...execution, durationMs: cached.durationMs };
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

export function createRouter(options: Options) {
  const { httpAuth, permissions, scaffolder, maxTasks, history } = options;
  const router = Router();
  let activeAnalyticsRequests = 0;

  async function runAnalytics<T>(
    req: Request,
    res: Response,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (activeAnalyticsRequests >= 4) {
      res.setHeader('Retry-After', '2');
      throw new ServiceUnavailableError(
        'Template Pulse analytics is busy. Try again shortly.',
      );
    }
    activeAnalyticsRequests++;
    const controller = new AbortController();
    const { signal } = controller;
    const timeout = setTimeout(() => {
      controller.abort(
        new ServiceUnavailableError(
          'Template Pulse analytics timed out. Narrow the filters and try again.',
        ),
      );
    }, 30_000);
    timeout.unref();
    const abort = () => {
      if (!res.writableEnded)
        controller.abort(
          new ServiceUnavailableError('Analytics request cancelled'),
        );
    };
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      return await withAbort(operation(signal), signal);
    } finally {
      clearTimeout(timeout);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
      controller.abort();
      activeAnalyticsRequests--;
    }
  }

  router.get('/permissions', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const [own, all] = await permissions.authorize(
      [
        { permission: executionsReadPermission },
        { permission: executionsReadAllPermission },
      ],
      { credentials },
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      canSearchHistory: Boolean(history),
      canReadOwn: own?.result === AuthorizeResult.ALLOW,
      canReadAll: all?.result === AuthorizeResult.ALLOW,
    });
  });

  router.get('/facets', async (req, res) => {
    const { query, facet, search } = parseExecutionFacetQuery(req.query);
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorizeExecutionQuery({ query, credentials, permissions });
    const searchFacets = history?.searchFacets?.bind(history);
    if (!searchFacets)
      throw new InputError('Filter search requires the database history source.');
    const result = await runAnalytics(req, res, signal =>
      searchFacets(query, credentials, facet, search, signal),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  });

  router.get('/analytics', async (req, res) => {
    const query = parseExecutionQuery(req.query);
    const { scope } = query;

    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const callerRef = credentials.principal.userEntityRef;
    await authorizeExecutionQuery({ query, credentials, permissions });

    const analytics = await runAnalytics(req, res, async signal => {
      if (history) {
        return history.search(query, credentials, maxTasks, signal);
      }
      if (query.allTime || query.offset || query.cursor) {
        throw new InputError(
          'All-history search and result pagination require the database history source.',
        );
      }
      const teamMembers = query.teamRef
        ? new Set(
            await withAbort(
              options.teams.getMembers(query.teamRef, credentials, signal),
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
          scaffolder.listTasks(
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
          projectTask(task, credentials, callerRef, options, signal, timingBudget),
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
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(analytics);
  });

  return router;
}
