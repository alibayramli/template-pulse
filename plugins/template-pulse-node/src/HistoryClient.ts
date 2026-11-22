import type {
  AuthService,
  BackstageCredentials,
  DiscoveryService,
} from '@backstage/backend-plugin-api';
import {
  InputError,
  NotAllowedError,
  NotFoundError,
  ResponseError,
} from '@backstage/errors';
import type {
  ExecutionAnalytics,
  ExecutionFacet,
  ExecutionFacetPage,
  ExecutionQuery,
} from '@abayramli/backstage-plugin-template-pulse-common';

/** The authenticated HTTP interface to the Scaffolder history module. @public */
export interface ExecutionHistory {
  search(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ExecutionAnalytics>;
  searchPage?(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Pick<ExecutionAnalytics, 'items' | 'page'>>;
  searchFacets?(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    facet: ExecutionFacet,
    search: string,
    signal?: AbortSignal,
  ): Promise<ExecutionFacetPage>;
}

/** Calls the Scaffolder module on behalf of the current user. @public */
export class HistoryClient implements ExecutionHistory {
  constructor(
    private readonly options: {
      auth: AuthService;
      discovery: DiscoveryService;
      /** Bound the upstream HTTP request, including response body reads. Default 30000 ms. */
      timeoutMs?: number;
    },
  ) {}

  async search(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ExecutionAnalytics> {
    return this.request(
      'analytics',
      query,
      credentials,
      new URLSearchParams({ limit: String(limit) }),
      signal,
    );
  }

  async searchPage(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Pick<ExecutionAnalytics, 'items' | 'page'>> {
    return this.request(
      'analytics/page',
      query,
      credentials,
      new URLSearchParams({ limit: String(limit) }),
      signal,
    );
  }

  async searchFacets(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    facet: ExecutionFacet,
    search: string,
    signal?: AbortSignal,
  ): Promise<ExecutionFacetPage> {
    return this.request(
      'facets',
      query,
      credentials,
      new URLSearchParams({ facet, facetQuery: search }),
      signal,
    );
  }

  private async request<T>(
    endpoint: string,
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    params: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      ...(signal ? [signal] : []),
    ]);
    requestSignal.throwIfAborted();
    const baseUrl = await this.options.discovery.getBaseUrl('scaffolder');
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: credentials,
      targetPluginId: 'scaffolder',
    });
    const response = await fetch(
      `${baseUrl}/modules/template-pulse/${endpoint}?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: requestSignal,
      },
    );
    if (response.status === 404)
      throw new NotFoundError(
        'Database history requires @abayramli/backstage-plugin-scaffolder-backend-module-template-pulse in the Scaffolder backend.',
      );
    if (!response.ok) {
      const error = await ResponseError.fromResponse(response);
      if (response.status === 403)
        throw new NotAllowedError(
          error.cause.message || 'Scaffolder history access denied',
        );
      if (response.status === 400)
        throw new InputError(error.cause.message || 'Invalid history query');
      throw error;
    }
    return response.json();
  }
}
