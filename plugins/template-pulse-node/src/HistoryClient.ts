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
  ServiceUnavailableError,
} from '@backstage/errors';
import type {
  ExecutionAnalytics,
  ExecutionFacet,
  ExecutionFacetPage,
  ExecutionQuery,
} from '@abayramli/backstage-plugin-template-pulse-common';

/** Read execution analytics on behalf of the current caller. @public */
export interface ExecutionHistory {
  canSearchHistory?(): Promise<boolean>;
  search(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ExecutionAnalytics>;
  searchExecutions?(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Pick<ExecutionAnalytics, 'items' | 'page'>>;
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
  private availability?: { expiresAt: number; result: Promise<boolean> };

  constructor(
    private readonly options: {
      auth: AuthService;
      discovery: DiscoveryService;
      /** Bound the upstream HTTP request, including response body reads. Default 30000 ms. */
      timeoutMs?: number;
    },
  ) {}

  async canSearchHistory(): Promise<boolean> {
    const now = Date.now();
    if (this.availability && this.availability.expiresAt > now)
      return this.availability.result;

    const result = this.checkAvailability();
    this.availability = { expiresAt: now + 30_000, result };
    try {
      return await result;
    } catch (error) {
      if (this.availability?.result === result) this.availability = undefined;
      throw error;
    }
  }

  private async checkAvailability(): Promise<boolean> {
    const credentials = await this.options.auth.getOwnServiceCredentials();
    const response = await this.fetchEndpoint(
      'capabilities',
      credentials,
      AbortSignal.timeout(this.options.timeoutMs ?? 3_000),
    );
    if (response.status === 204) return true;
    await response.body?.cancel();
    if (response.status === 404) return false;
    throw new ServiceUnavailableError('Could not check Scaffolder database history availability.');
  }

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

  async searchExecutions(
    query: ExecutionQuery,
    credentials: BackstageCredentials,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Pick<ExecutionAnalytics, 'items' | 'page'>> {
    return this.request(
      'executions',
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
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    const response = await this.fetchEndpoint(
      `${endpoint}?${params}`,
      credentials,
      requestSignal,
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

  private async fetchEndpoint(
    path: string,
    credentials: BackstageCredentials,
    signal: AbortSignal,
  ): Promise<Response> {
    signal.throwIfAborted();
    const baseUrl = await this.options.discovery.getBaseUrl('scaffolder');
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: credentials,
      targetPluginId: 'scaffolder',
    });
    return fetch(`${baseUrl}/modules/template-pulse/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
  }
}
