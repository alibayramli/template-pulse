import type {
  AuthService,
  BackstageCredentials,
  DiscoveryService,
} from '@backstage/backend-plugin-api';
import { ResponseError, ServiceUnavailableError } from '@backstage/errors';
import type {
  LogEvent,
  ScaffolderTask,
} from '@backstage/plugin-scaffolder-common';

async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  onBytes?: (size: number) => void,
) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new ServiceUnavailableError(
      'Scaffolder response exceeds the analytics size limit',
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (!signal.aborted) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      onBytes?.(chunk.value.byteLength);
      if (bytes > maxBytes)
        throw new ServiceUnavailableError(
          'Scaffolder response exceeds the analytics size limit',
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted();
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// Use the public task endpoints without pulling in Scaffolder's action utilities.
export class ScaffolderTasksClient {
  constructor(
    private readonly options: {
      auth: AuthService;
      discovery: DiscoveryService;
    },
  ) {}

  async listTasks(
    request: { createdBy?: string; limit?: number; offset?: number },
    options: { credentials: BackstageCredentials; signal?: AbortSignal },
  ): Promise<{ items: ScaffolderTask[]; totalItems?: number }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const body = await this.get(
      `/v2/tasks?${params}`,
      options.credentials,
      8 * 1024 * 1024,
      options.signal,
    );
    return { items: body.tasks, totalItems: body.totalTasks };
  }

  async getLogs(
    request: { taskId: string },
    options: {
      credentials: BackstageCredentials;
      signal?: AbortSignal;
      onBytes?: (size: number) => void;
    },
  ): Promise<LogEvent[]> {
    return this.get(
      `/v2/tasks/${encodeURIComponent(request.taskId)}/events`,
      options.credentials,
      2 * 1024 * 1024,
      options.signal,
      options.onBytes,
    );
  }

  private async get(
    endpoint: string,
    credentials: BackstageCredentials,
    maxBytes: number,
    requestSignal?: AbortSignal,
    onBytes?: (size: number) => void,
  ) {
    const timeout = AbortSignal.timeout(30_000);
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, timeout])
      : timeout;
    signal.throwIfAborted();
    const baseUrl = await this.options.discovery.getBaseUrl('scaffolder');
    const { token } = await this.options.auth.getPluginRequestToken({
      onBehalfOf: credentials,
      targetPluginId: 'scaffolder',
    });
    signal.throwIfAborted();
    const response = await fetch(`${baseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) {
      const body = await readBody(response, 64 * 1024, signal);
      throw await ResponseError.fromResponse(
        new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      );
    }
    return JSON.parse(await readBody(response, maxBytes, signal, onBytes));
  }
}
