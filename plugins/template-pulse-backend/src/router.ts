import type {
  HttpAuthService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { InputError, ServiceUnavailableError } from '@backstage/errors';
import type { Request, Response } from 'express';
import Router from 'express-promise-router';
import {
  executionsReadAllPermission,
  executionsReadPermission,
} from '@abayramli/backstage-plugin-template-pulse-common';
import {
  authorizeExecutionQuery,
  parseExecutionFacetQuery,
  parseExecutionQuery,
  type ExecutionHistory,
} from '@abayramli/backstage-plugin-template-pulse-node';
import { withAbort } from './withAbort';

type Options = {
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  maxTasks: number;
  history: ExecutionHistory;
  fallbackHistory?: ExecutionHistory;
};

export function createRouter({ httpAuth, permissions, maxTasks, history, fallbackHistory }: Options) {
  const router = Router();
  let activeAnalyticsRequests = 0;

  async function resolveHistory(): Promise<ExecutionHistory> {
    if (fallbackHistory && !(await history.canSearchHistory?.()))
      return fallbackHistory;
    return history;
  }

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
    const canReadOwn = own?.result === AuthorizeResult.ALLOW;
    const canReadAll = all?.result === AuthorizeResult.ALLOW;
    const canSearchHistory =
      (canReadOwn || canReadAll) &&
      (await history.canSearchHistory?.().catch(() => false)) === true;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ canSearchHistory, canReadOwn, canReadAll });
  });

  router.get('/facets', async (req, res) => {
    const { query, facet, search } = parseExecutionFacetQuery(req.query);
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorizeExecutionQuery({ query, credentials, permissions });
    const result = await runAnalytics(req, res, async signal => {
      const source = await resolveHistory();
      if (!source.searchFacets)
        throw new InputError('Filter search requires the database history source.');
      return source.searchFacets(query, credentials, facet, search, signal);
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  });

  router.get('/analytics/page', async (req, res) => {
    const query = parseExecutionQuery(req.query);
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorizeExecutionQuery({ query, credentials, permissions });
    if (!query.cursor) throw new InputError('A history cursor is required.');
    const page = await runAnalytics(req, res, async signal => {
      const source = await resolveHistory();
      if (!source.searchPage)
        throw new InputError('Pagination requires the database history source.');
      return source.searchPage(query, credentials, maxTasks, signal);
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(page);
  });

  router.get('/executions', async (req, res) => {
    const query = parseExecutionQuery(req.query);
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorizeExecutionQuery({ query, credentials, permissions });
    if (query.cursor || query.offset)
      throw new InputError('Run search starts on the first page.');
    const { items, page } = await runAnalytics(req, res, async signal => {
      const source = await resolveHistory();
      const search = source.searchExecutions ?? source.search;
      return search.call(source, query, credentials, maxTasks, signal);
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items, page });
  });

  router.get('/analytics', async (req, res) => {
    const query = parseExecutionQuery(req.query);
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorizeExecutionQuery({ query, credentials, permissions });
    const analytics = await runAnalytics(req, res, async signal => {
      const source = await resolveHistory();
      return source.search(query, credentials, maxTasks, signal);
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(analytics);
  });

  return router;
}
