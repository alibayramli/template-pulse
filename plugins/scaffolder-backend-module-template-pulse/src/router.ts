import type {
  HttpAuthService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { InputError, NotAllowedError, ServiceUnavailableError } from '@backstage/errors';
import { taskReadPermission } from '@backstage/plugin-scaffolder-common/alpha';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  authorizeExecutionQuery,
  parseExecutionFacetQuery,
  parseExecutionQuery,
  type TeamMembersClient,
} from '@abayramli/backstage-plugin-template-pulse-node';
import Router from 'express-promise-router';
import type { Request, Response } from 'express';
import type { DatabaseHistoryStore } from './historyStore';

export function createRouter(options: {
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  historyStore: DatabaseHistoryStore;
  teams: Pick<TeamMembersClient, 'getMembers'>;
}) {
  const { httpAuth, permissions, historyStore } = options;
  const router = Router();
  const handle = (view: 'analytics' | 'page' | 'facets') => async (req: Request, res: Response) => {
    const facetQuery = view === 'facets' ? parseExecutionFacetQuery(req.query) : undefined;
    const query = facetQuery?.query ?? parseExecutionQuery(req.query);
    const limit = req.query.limit ?? '200';
    if (
      typeof limit !== 'string' ||
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 1000
    )
      throw new InputError('limit must be an integer between 1 and 1000');
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    // This endpoint also enforces analytics permissions when called directly.
    await authorizeExecutionQuery({ query, credentials, permissions });
    const [decision] = await permissions.authorizeConditional(
      [{ permission: taskReadPermission }],
      { credentials },
    );
    if (!decision || decision.result === AuthorizeResult.DENY)
      throw new NotAllowedError('Scaffolder task access denied');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ServiceUnavailableError(
      'History analytics exceeded their time limit. Narrow the date range or filters and try again.',
    )), 15_000);
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', onClose);
    res.once('close', onClose);
    try {
      const teamMembers = query.teamRef
        ? await options.teams.getMembers(query.teamRef, credentials, controller.signal)
        : undefined;
      const historyQuery = teamMembers ? { ...query, teamMembers } : query;
      const caller = credentials.principal.userEntityRef;
      const method = view === 'page' ? 'searchPage' : 'search';
      const result = facetQuery
        ? await historyStore.searchFacets(historyQuery, caller, decision, facetQuery.facet, facetQuery.search, controller.signal)
        : await historyStore[method](historyQuery, caller, decision, Number(limit), controller.signal);
      controller.signal.throwIfAborted();
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } finally {
      clearTimeout(timer);
      req.removeListener('aborted', onClose);
      res.removeListener('close', onClose);
    }
  };
  router.get('/modules/template-pulse/analytics', handle('analytics'));
  router.get('/modules/template-pulse/analytics/page', handle('page'));
  router.get('/modules/template-pulse/facets', handle('facets'));
  return router;
}
