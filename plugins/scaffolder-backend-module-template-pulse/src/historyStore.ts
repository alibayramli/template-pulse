import type { Knex } from 'knex';
import type { CacheService } from '@backstage/backend-plugin-api';
import { InputError, NotAllowedError, ServiceUnavailableError } from '@backstage/errors';
import {
  AuthorizeResult,
  type PermissionCondition,
  type PermissionCriteria,
  type QueryPermissionResponse,
} from '@backstage/plugin-permission-common';
import type {
  DailyActivity,
  Execution,
  ExecutionAnalytics,
  ExecutionFacet,
  ExecutionFacetPage,
  ExecutionQuery,
} from '@abayramli/backstage-plugin-template-pulse-common';
import {
  executionProjection,
  filterExecutionDetails,
  mapMetrics,
  metricsQuery,
  orderExecutionDetails,
} from './historySql';
import { HistoryWorkload, type RunHistoryQuery } from './historyWorkload';
import { HistorySnapshots, MAX_SNAPSHOT_IDS, snapshotBinding } from './historySnapshots';

type HistoryQuery = ExecutionQuery & { teamMembers?: string[] };

function applyConditions(
  query: Knex.QueryBuilder,
  criteria: PermissionCriteria<PermissionCondition>,
) {
  if ('allOf' in criteria) {
    if (!criteria.allOf.length) query.whereRaw('1 = 1');
    for (const condition of criteria.allOf)
      query.andWhere(builder => applyConditions(builder, condition));
  } else if ('anyOf' in criteria) {
    if (!criteria.anyOf.length) query.whereRaw('1 = 0');
    else
      query.andWhere(builder => {
        for (const condition of criteria.anyOf)
          builder.orWhere(branch => applyConditions(branch, condition));
      });
  } else if ('not' in criteria) {
    query.whereNot(builder => applyConditions(builder, criteria.not));
  } else {
    const owners = criteria.params?.createdBy;
    if (
      criteria.resourceType !== 'scaffolder-task' ||
      criteria.rule !== 'IS_TASK_OWNER' ||
      !Array.isArray(owners) ||
      !owners.every(owner => typeof owner === 'string')
    ) {
      // Never drop a policy condition that this database adapter cannot enforce.
      throw new NotAllowedError(
        'Database history does not support this task permission condition. Use the service history source for custom task rules.',
      );
    }
    query.whereIn('t.created_by', owners);
  }
}

function isoDate(value: Date | string) {
  if (value instanceof Date) return value.toISOString();
  return new Date(
    value.includes('T') ? value : `${value.replace(' ', 'T')}Z`,
  ).toISOString();
}

/** Read-only adapter for the standard Scaffolder SQL task store. */
export class DatabaseHistoryStore {
  private database?: Promise<Knex>;
  private readonly workload = new HistoryWorkload();
  private readonly snapshots: HistorySnapshots;

  constructor(
    private readonly getClient: () => Promise<Knex>,
    private readonly maxHistoryRows = 10_000,
    options: { cache?: CacheService } = {},
  ) {
    this.snapshots = new HistorySnapshots(options.cache);
    if (
      !Number.isInteger(maxHistoryRows) ||
      maxHistoryRows < 1 ||
      maxHistoryRows > 100_000
    ) {
      throw new Error(
        'templatePulse.maxHistoryRows must be an integer between 1 and 100000.',
      );
    }
  }

  /** Called after Scaffolder startup, when its own migrations have completed. */
  async initialize(): Promise<void> {
    await this.getDatabase();
  }

  private getDatabase(): Promise<Knex> {
    this.database ??= this.validateDatabase().catch(error => {
      this.database = undefined;
      throw error;
    });
    return this.database;
  }

  private async validateDatabase(): Promise<Knex> {
    const db = await this.getClient();
    const client = db.client.config.client;
    if (
      !['pg', 'postgres', 'postgresql', 'better-sqlite3', 'sqlite3'].includes(
        client,
      )
    ) {
      throw new Error(
        'Database history supports PostgreSQL and SQLite Scaffolder task stores.',
      );
    }
    // Scaffolder owns these tables and migrations, as well as the connection pool.
    const [taskColumns, eventColumns] = await Promise.all([
      db('tasks').columnInfo(),
      db('task_events').columnInfo(),
    ]);
    if (
      !['id', 'spec', 'status', 'created_at', 'created_by'].every(
        key => key in taskColumns,
      ) ||
      !['task_id', 'body', 'event_type', 'created_at'].every(
        key => key in eventColumns,
      )
    ) {
      throw new Error(
        'The Scaffolder task store schema is incompatible with database history. Check that Scaffolder migrations have completed and use service history for custom task stores.',
      );
    }
    return db;
  }

  async search(
    query: HistoryQuery,
    callerRef: string,
    decision: QueryPermissionResponse,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ExecutionAnalytics> {
    this.validateAccess(query, decision);
    signal?.throwIfAborted();
    const binding = snapshotBinding(query, callerRef, decision, limit);
    const snapshot = query.cursor
      ? await this.snapshots.read(query.cursor, binding)
      : undefined;
    const db = await this.getDatabase();
    const postgres = this.isPostgres(db);
    const result = await this.workload.run(
      db,
      postgres,
      signal,
      (transaction, run) => this.searchDatabase(transaction, postgres, query, callerRef, decision, limit, run, snapshot),
    );
    if (result.analytics.page.hasMore) {
      const id = snapshot?.id ?? (result.snapshotIds
        ? await this.snapshots.create(result.snapshotIds, binding, callerRef)
        : undefined);
      if (id) result.analytics.page.nextCursor = `${id}.${result.analytics.page.offset + limit}`;
      else result.analytics.page.continuationUnavailable = true;
    }
    return result.analytics;
  }

  async searchPage(
    query: HistoryQuery,
    callerRef: string,
    decision: QueryPermissionResponse,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Pick<ExecutionAnalytics, 'items' | 'page'>> {
    this.validateAccess(query, decision);
    if (!query.cursor) throw new InputError('A history cursor is required.');
    signal?.throwIfAborted();
    const binding = snapshotBinding(query, callerRef, decision, limit);
    const { id, ids, offset } = await this.snapshots.read(query.cursor, binding);
    const db = await this.getDatabase();
    const postgres = this.isPostgres(db);
    const nextOffset = offset + limit;
    const items = await this.workload.run(db, postgres, signal, (transaction, run) => {
      const { base, metadata } = this.metadataQueries(transaction, postgres, query, callerRef, decision);
      return this.readPageItems(transaction, postgres, metadata(base), ids.slice(offset, nextOffset), query, run);
    });
    const page: ExecutionAnalytics['page'] = {
      offset,
      limit,
      total: ids.length,
      hasMore: nextOffset < ids.length,
    };
    if (page.hasMore) page.nextCursor = `${id}.${nextOffset}`;
    return { items, page };
  }

  private validateAccess(query: HistoryQuery, decision: QueryPermissionResponse) {
    if (query.teamRef && !query.teamMembers)
      throw new InputError(
        'Team membership must be resolved before reading history',
      );
    if (decision.result === AuthorizeResult.DENY)
      throw new NotAllowedError('Scaffolder task access denied');
    if (
      decision.result === AuthorizeResult.CONDITIONAL &&
      (decision.pluginId !== 'scaffolder' ||
        decision.resourceType !== 'scaffolder-task')
    ) {
      throw new NotAllowedError(
        'Unsupported Scaffolder task permission decision',
      );
    }
  }

  private isPostgres(db: Knex) {
    return ['pg', 'postgres', 'postgresql'].includes(db.client.config.client);
  }

  private metadataQueries(
    db: Knex,
    postgres: boolean,
    query: HistoryQuery,
    callerRef: string,
    decision: QueryPermissionResponse,
  ) {
    const json = (column: string, path: string[]) =>
      postgres
        ? `(${column}::jsonb #>> '{${path.join(',')}}')`
        : `json_extract(${column}, '$.${path.join('.')}')`;
    const userRef = `COALESCE(t.created_by, ${json('t.spec', [
      'user',
      'ref',
    ])})`;
    const templateRef = `COALESCE(${json('t.spec', [
      'templateInfo',
      'entityRef',
    ])}, 'unknown')`;
    const templateName = `COALESCE(${json('t.spec', [
      'templateInfo',
      'entity',
      'metadata',
      'title',
    ])}, ${json('t.spec', [
      'templateInfo',
      'entity',
      'metadata',
      'name',
    ])}, ${json('t.spec', ['templateInfo', 'entityRef'])}, 'Unknown template')`;
    const base = db('tasks as t');
    if (decision.result === AuthorizeResult.CONDITIONAL)
      applyConditions(base, decision.conditions);
    if (query.scope === 'mine') base.whereRaw(`${userRef} = ?`, [callerRef]);
    else if (query.userRef) base.whereRaw(`${userRef} = ?`, [query.userRef]);
    if (query.teamMembers) {
      if (query.teamMembers.length)
        base.whereRaw(
          `${userRef} IN (${query.teamMembers.map(() => '?').join(', ')})`,
          query.teamMembers,
        );
      else base.whereRaw('1 = 0');
    }

    // Membership intersects task permissions before any counts or facets.
    const metadata = (source: Knex.QueryBuilder) =>
      source
        .clone()
        .select(
          't.id',
          't.status',
          't.created_at',
          db.raw(`${templateRef} AS template_ref`),
          db.raw(`${templateName} AS template_name`),
          db.raw(`${userRef} AS user_ref`),
        );
    return { base, metadata, templateRef };
  }

  private facetChoices(db: Knex, source: Knex.QueryBuilder, facet: ExecutionFacet, search = '') {
    const choices = facet === 'template'
      ? db.from(db.from(source.clone().as('authorized')).select(
          'template_ref AS id',
          'template_name AS name',
          db.raw('ROW_NUMBER() OVER (PARTITION BY template_ref ORDER BY created_at DESC, id DESC) AS latest_rank'),
        ).as('ranked_choices')).select('id', 'name').where('latest_rank', 1)
      : db.from(source.clone().as('choices')).distinct('user_ref AS id', 'user_ref AS name').whereNotNull('user_ref').whereNot('user_ref', '');
    const result = db.from(choices.as('facet_choices')).select('id', 'name');
    if (search) {
      const pattern = `%${search.toLowerCase().replace(/[!%_]/g, value => `!${value}`)}%`;
      result.where(builder => builder
        .whereRaw("LOWER(id) LIKE ? ESCAPE '!'", [pattern])
        .orWhereRaw("LOWER(name) LIKE ? ESCAPE '!'", [pattern]));
    }
    return result.orderByRaw('LOWER(name) ASC').orderBy('id').limit(101);
  }

  private facetMetadata(
    db: Knex,
    postgres: boolean,
    query: HistoryQuery,
    callerRef: string,
    decision: QueryPermissionResponse,
    facet: ExecutionFacet,
  ) {
    const facetQuery = {
      ...query,
      ...(facet === 'user' && query.scope === 'all' ? { userRef: undefined } : {}),
    };
    const { base, metadata, templateRef } = this.metadataQueries(db, postgres, facetQuery, callerRef, decision);
    if (!query.allTime) base
      .where('t.created_at', '>=', postgres ? query.from : query.from.slice(0, 19).replace('T', ' '))
      .where('t.created_at', '<', postgres ? query.to : query.to.slice(0, 19).replace('T', ' '));
    if (facet === 'user' && query.templateRef) base.whereRaw(`${templateRef} = ?`, [query.templateRef]);
    return metadata(base);
  }

  private async guardSqliteRows(db: Knex, source: Knex.QueryBuilder, run: RunHistoryQuery) {
    // Native synchronous SQLite statements cannot be interrupted by a timer.
    // Check a bounded set of IDs before timing projections or facet windows.
    const bounded = source.clone().clearSelect().select('t.id').limit(50_001);
    const count = await run(db.from(bounded.as('bounded_history')).count({ total: '*' }).first());
    if (Number(count?.total ?? 0) > 50_000)
      throw new ServiceUnavailableError('SQLite history analytics cover up to 50000 runs per request. Narrow the date range or filters and try again.');
  }

  async searchFacets(
    query: HistoryQuery,
    callerRef: string,
    decision: QueryPermissionResponse,
    facet: ExecutionFacet,
    search: string,
    signal?: AbortSignal,
  ): Promise<ExecutionFacetPage> {
    this.validateAccess(query, decision);
    const db = await this.getDatabase();
    const postgres = this.isPostgres(db);
    return this.workload.run(db, postgres, signal, async (transaction, run) => {
      const source = this.facetMetadata(transaction, postgres, query, callerRef, decision, facet);
      if (!postgres) await this.guardSqliteRows(transaction, source, run);
      const choices = await run(this.facetChoices(transaction, source, facet, search));
      return {
        items: choices.slice(0, 100).map(row => ({ id: row.id as string, name: row.name as string })),
        hasMore: choices.length > 100,
      };
    });
  }

  private async readPageItems(
    db: Knex,
    postgres: boolean,
    metadata: Knex.QueryBuilder,
    ids: string[] | Knex.QueryBuilder,
    query: HistoryQuery,
    run: RunHistoryQuery,
  ): Promise<Execution[]> {
    const executions = executionProjection(db, metadata.whereIn('t.id', ids), postgres);
    const details = db.from(executions.as('page')).select('*');
    const rows = await run(Array.isArray(ids) ? details : orderExecutionDetails(details, query));
    if (Array.isArray(ids)) {
      const positions = new Map(ids.map((id, index) => [id, index]));
      rows.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
    }
    return rows.map(row => ({
      id: row.id,
      status: row.status,
      templateRef: row.template_ref,
      templateName: row.template_name,
      userRef: row.user_ref ?? undefined,
      createdAt: isoDate(row.created_at),
      durationMs:
        row.duration_ms === null || row.duration_ms === undefined
          ? undefined
          : Number(row.duration_ms),
    }));
  }

  private async searchDatabase(
    db: Knex,
    postgres: boolean,
    query: HistoryQuery,
    callerRef: string,
    decision: QueryPermissionResponse,
    limit: number,
    run: RunHistoryQuery,
    snapshot?: { id: string; ids: string[]; offset: number },
  ): Promise<{ analytics: ExecutionAnalytics; snapshotIds?: string[] }> {
    const { base, metadata, templateRef } = this.metadataQueries(db, postgres, query, callerRef, decision);

    // A transaction has one connection; execute its statements sequentially.
    const cohort = base.clone();
    if (!query.allTime) {
      cohort
        .where(
          't.created_at',
          '>=',
          postgres ? query.from : query.from.slice(0, 19).replace('T', ' '),
        )
        .where(
          't.created_at',
          '<',
          postgres ? query.to : query.to.slice(0, 19).replace('T', ' '),
        );
    }
    if (query.templateRef)
      cohort.whereRaw(`${templateRef} = ?`, [query.templateRef]);
    const executions = executionProjection(db, metadata(cohort), postgres);
    const details = filterExecutionDetails(
      db.from(metadata(cohort).as('cohort')),
      query,
    );
    if (!postgres) {
      await this.guardSqliteRows(db, cohort, run);
    }
    const templateSource = this.facetMetadata(db, postgres, query, callerRef, decision, 'template');
    const userSource = this.facetMetadata(db, postgres, query, callerRef, decision, 'user');
    if (!postgres) {
      await this.guardSqliteRows(db, templateSource, run);
      await this.guardSqliteRows(db, userSource, run);
    }
    const templateChoices = await run(this.facetChoices(db, templateSource, 'template'));
    const userChoices = await run(this.facetChoices(db, userSource, 'user'));
    const offset = snapshot?.offset ?? query.offset ?? 0;
    // Only elapsed sorting needs completion events for every matching execution.
    const sortableDetails =
      query.sortBy === 'durationMs'
        ? filterExecutionDetails(db.from(executions.clone().as('cohort')), query)
        : details.clone();
    const pageIds = orderExecutionDetails(sortableDetails.clone().select('id'), query)
      .limit(limit)
      .offset(offset);
    // Materialize completion timings once for the three ranking dimensions.
    const metricSource = db.select('*').from('execution_cohort');
    const summaryQuery = metricsQuery(db, metricSource)
      .select(db.raw('MIN(created_at) AS oldest_at'))
      .select(db.raw("'summary' AS kind, NULL AS id, NULL AS name, MAX(created_at) AS last_run"));
    const groupedMetrics = (kind: 'template' | 'user') => metricsQuery(db, metricSource, kind)
      .select(db.raw('MIN(created_at) AS oldest_at'))
      .select(db.raw('? AS kind', [kind]))
      .orderBy('total', 'desc').orderBy('id').limit(this.maxHistoryRows + 1);
    const metricColumns = ['total', 'completed', 'failed', 'cancelled', 'active', 'users', 'templates', 'timed_completed', 'average_ms', 'p95_ms', 'oldest_at', 'kind', 'id', 'name', 'last_run'];
    const metricRows = await run(db.withMaterialized('execution_cohort', executions)
      .from(summaryQuery.as('summary')).select(metricColumns)
      .unionAll([
        db.from(groupedMetrics('template').as('templates')).select(metricColumns),
        db.from(groupedMetrics('user').as('users')).select(metricColumns),
      ]));
    const summaryRow = metricRows.find(row => row.kind === 'summary')!;
    const templateRows = metricRows.filter(row => row.kind === 'template');
    const userRows = metricRows.filter(row => row.kind === 'user');
    const matchingCount = await run(details.clone().count({ total: '*' }).first());
    const matchingTotal = snapshot?.ids.length ?? Number(matchingCount?.total ?? 0);
    let snapshotIds: string[] | undefined;
    if (!snapshot && offset + limit < matchingTotal && matchingTotal <= MAX_SNAPSHOT_IDS) {
      const ids = await run(orderExecutionDetails(sortableDetails.clone().select('id'), query).limit(MAX_SNAPSHOT_IDS));
      snapshotIds = ids.map((row: { id: string }) => row.id);
    }
    const orderedIds = snapshot?.ids.slice(offset, offset + limit) ?? snapshotIds?.slice(offset, offset + limit);
    const rows = await this.readPageItems(db, postgres, metadata(base), orderedIds ?? pageIds, query, run);
    const dailyRows = await run(db
      .from(metadata(cohort).as('cohort'))
      .where(
        'created_at',
        '>=',
        postgres ? query.from : query.from.slice(0, 19).replace('T', ' '),
      )
      .where(
        'created_at',
        '<',
        postgres ? query.to : query.to.slice(0, 19).replace('T', ' '),
      )
      .select(
        db.raw(
          `${
            postgres
              ? "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')"
              : 'substr(created_at, 1, 10)'
          } AS date`,
        ),
      )
      .select(db.raw('COUNT(*) AS total'))
      .select(
        db.raw(
          "SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed",
        ),
      )
      .select(
        db.raw("SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed"),
      )
      .groupBy('date'));
    const rollups = (results: typeof templateRows, kind: 'template' | 'user') =>
      results.slice(0, this.maxHistoryRows)
        .map(row => {
          const userName =
            row.id === 'unknown' ? 'Unknown user' : (row.id as string);
          return {
            id: row.id as string,
            name: kind === 'template' ? (row.name as string) : userName,
            lastRun: isoDate(row.last_run),
            ...mapMetrics(row),
          };
        })
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const daily = new Map(dailyRows.map(row => [row.date, row]));
    const activity: DailyActivity[] = [];
    for (
      let day = Date.parse(query.from);
      day < Date.parse(query.to);
      day += 86_400_000
    ) {
      const date = new Date(day).toISOString().slice(0, 10);
      const row = daily.get(date);
      const total = Number(row?.total ?? 0);
      const completed = Number(row?.completed ?? 0);
      const failed = Number(row?.failed ?? 0);
      activity.push({
        date,
        total,
        completed,
        failed,
        other: total - completed - failed,
      });
    }
    const summary = mapMetrics(summaryRow);
    return { snapshotIds, analytics: {
      scope: query.scope,
      items: rows,
      summary,
      templates: rollups(templateRows, 'template'),
      users: rollups(userRows, 'user'),
      rollupsTruncated: {
        templates: templateRows.length > this.maxHistoryRows,
        users: userRows.length > this.maxHistoryRows,
      },
      activity,
      page: { offset, limit, total: matchingTotal, hasMore: offset + limit < matchingTotal },
      facets: {
        templates: [
          ...new Map(
            templateChoices.slice(0, 100).map(row => [
              row.id,
              { id: row.id as string, name: row.name as string },
            ]),
          ).values(),
        ].sort((a, b) => a.name.localeCompare(b.name)),
        users: userChoices.slice(0, 100)
          .map(row => row.id as string)
          .filter(Boolean)
          .sort(),
        hasMore: { templates: templateChoices.length > 100, users: userChoices.length > 100 },
      },
      window: {
        historySource: 'database' as const,
        limit,
        scanned: summary.total,
        sourceTotal: query.allTime && !query.templateRef ? summary.total : undefined,
        truncated: false,
        oldestAt: summaryRow.oldest_at
          ? isoDate(summaryRow.oldest_at)
          : undefined,
        generatedAt: new Date().toISOString(),
      },
    } };
  }
}
