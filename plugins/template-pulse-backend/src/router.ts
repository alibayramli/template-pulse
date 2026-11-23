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
};

export function createRouter({ httpAuth, permissions, maxTasks, history }: Options) {
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
      canSearchHistory: Boolean(history.searchFacets),
      canReadOwn: own?.result === AuthorizeResult.ALLOW,
      canReadAll: all?.result === AuthorizeResult.ALLOW,
    });
  });

  router.get('/facets', async (req, res) => {
    const { query, facet, search } = parseExecutionFacetQuery(req.query);
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorizeExecutionQuery({ query, credentials, permissions });
    const searchFacets = history.searchFacets?.bind(history);
    if (!searchFacets)
      throw new InputError('Filter search requires the database history source.');
    const result = await runAnalytics(req, res, signal =>
      searchFacets(query, credentials, facet, search, signal),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  });

  router.get('/analytics/page', async (req, res) => {
    const query = parseExecutionQuery(req.query);
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorizeExecutionQuery({ query, credentials, permissions });
    if (!query.cursor) throw new InputError('A history cursor is required.');
    const searchPage = history.searchPage?.bind(history);
    if (!searchPage)
      throw new InputError('Pagination requires the database history source.');
    const page = await runAnalytics(req, res, signal =>
      searchPage(query, credentials, maxTasks, signal),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(page);
  });

  router.get('/analytics', async (req, res) => {
    const query = parseExecutionQuery(req.query);
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorizeExecutionQuery({ query, credentials, permissions });
    const analytics = await runAnalytics(req, res, signal =>
      history.search(query, credentials, maxTasks, signal),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(analytics);
  });

  return router;
}
