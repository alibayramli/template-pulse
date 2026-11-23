import type { Knex } from 'knex';
import type {
  DailyActivity,
  ExecutionMetrics,
  ExecutionQuery,
} from '@abayramli/backstage-plugin-template-pulse-common';
import type { RunHistoryQuery } from './historyWorkload';

export function isoDate(value: Date | string) {
  if (value instanceof Date) return value.toISOString();
  return new Date(
    value.includes('T') ? value : `${value.replace(' ', 'T')}Z`,
  ).toISOString();
}

/** Order public metadata before LIMIT/OFFSET, with missing values last in either direction. */
export function orderExecutionDetails<T extends Knex.QueryBuilder>(
  query: T,
  sort: Pick<ExecutionQuery, 'sortBy' | 'sortDirection'>,
) {
  const column = {
    templateName: 'template_name',
    userRef: 'user_ref',
    status: 'status',
    createdAt: 'created_at',
    durationMs: 'duration_ms',
  }[sort.sortBy ?? 'createdAt'];
  const direction = sort.sortDirection === 'ascending' ? 'asc' : 'desc';
  if (column === 'duration_ms' || column === 'user_ref')
    query.orderByRaw('?? IS NULL ASC', [column]);
  if (['template_name', 'user_ref', 'status'].includes(column))
    query.orderByRaw(`LOWER(??) ${direction}`, [column]);
  else query.orderBy(column, direction);
  query.orderBy('id', 'desc');
  return query;
}

/** Project only execution metadata and timing; task specs and event bodies stay in SQL. */
export function executionProjection(
  db: Knex,
  cohort: Knex.QueryBuilder,
  postgres: boolean,
) {
  const eventStatus = postgres
    ? "(e.body::jsonb #>> '{status}')"
    : "json_extract(e.body, '$.status')";
  const finishedAt = db('task_events as e')
    .max('e.created_at')
    .whereRaw('?? = ??', ['e.task_id', 't.id'])
    .whereIn('e.event_type', ['completion', 'cancelled'])
    .andWhere(builder =>
      builder
        .whereRaw(`${eventStatus} IS NULL`)
        .orWhereRaw(`${eventStatus} = t.status`),
    );
  const metadata = cohort.clone().select(finishedAt.as('finished_at'));
  const elapsed = postgres
    ? 'EXTRACT(EPOCH FROM (finished_at - created_at)) * 1000'
    : 'ROUND((julianday(finished_at) - julianday(created_at)) * 86400000)';
  return db
    .from(metadata.as('metadata'))
    .select(
      'id',
      'status',
      'created_at',
      'template_ref',
      'template_name',
      'user_ref',
    )
    .select(
      db.raw(`CASE WHEN status IN ('completed', 'failed', 'cancelled')
      AND finished_at >= created_at THEN ${elapsed} END AS duration_ms`),
    );
}

/** Search is literal, parameterized and limited to the same public metadata as service history. */
export function filterExecutionDetails(
  query: Knex.QueryBuilder,
  filters: { status?: string; query?: string },
) {
  if (filters.status) query.where('status', filters.status);
  for (const term of filters.query
    ?.toLowerCase()
    .split(/\s+/)
    .filter(Boolean) ?? []) {
    const pattern = `%${term.replace(/[!%_]/g, value => `!${value}`)}%`;
    query.andWhere(builder => {
      for (const column of [
        'id',
        'template_ref',
        'template_name',
        'user_ref',
      ]) {
        // CAST also supports Scaffolder's PostgreSQL UUID task IDs.
        builder.orWhereRaw(
          "LOWER(COALESCE(CAST(?? AS TEXT), '')) LIKE ? ESCAPE '!'",
          [column, pattern],
        );
      }
    });
  }
  return query;
}

/** Compute complete metrics and nearest-rank P95 in the database, independent of detail pagination. */
export function metricsQuery(
  db: Knex,
  executions: Knex.QueryBuilder,
  group?: 'template' | 'user',
) {
  const groupColumn =
    group === 'template' ? 'template_ref' : "COALESCE(user_ref, 'unknown')";
  const partition = group ? `PARTITION BY ${groupColumn}` : '';
  const successful = "status = 'completed' AND duration_ms IS NOT NULL";
  const ranked = db
    .from(executions.clone().as('executions'))
    .select('*')
    .select(
      db.raw(`ROW_NUMBER() OVER (${partition} ORDER BY
      CASE WHEN ${successful} THEN 0 ELSE 1 END, duration_ms, id) AS duration_rank`),
      db.raw(
        `SUM(CASE WHEN ${successful} THEN 1 ELSE 0 END) OVER (${partition}) AS timed_count`,
      ),
      db.raw(
        `ROW_NUMBER() OVER (${partition} ORDER BY created_at DESC, id DESC) AS latest_rank`,
      ),
    );
  const result = db.from(ranked.as('ranked')).select(
    db.raw('COUNT(*) AS total'),
    db.raw(
      "SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed",
    ),
    db.raw("SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed"),
    db.raw(
      "SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled",
    ),
    db.raw(
      "SUM(CASE WHEN status IN ('open', 'processing') THEN 1 ELSE 0 END) AS active",
    ),
    db.raw("COUNT(DISTINCT NULLIF(user_ref, '')) AS users"),
    db.raw("COUNT(DISTINCT NULLIF(template_ref, 'unknown')) AS templates"),
    db.raw(`SUM(CASE WHEN ${successful} THEN 1 ELSE 0 END) AS timed_completed`),
    db.raw(`AVG(CASE WHEN ${successful} THEN duration_ms END) AS average_ms`),
    db.raw(`MAX(CASE WHEN ${successful}
      AND duration_rank = CAST((timed_count * 95 + 99) / 100 AS INTEGER)
      THEN duration_ms END) AS p95_ms`),
  );
  if (group) {
    result
      .select(
        db.raw(`${groupColumn} AS id`),
        db.raw('MAX(created_at) AS last_run'),
      )
      .select(
        db.raw('MAX(CASE WHEN latest_rank = 1 THEN template_name END) AS name'),
      )
      .groupByRaw(groupColumn);
  }
  return result;
}

export function mapMetrics(row: Record<string, unknown>): ExecutionMetrics {
  const count = (key: string) => Number(row[key] ?? 0);
  const completed = count('completed');
  const failed = count('failed');
  return {
    total: count('total'),
    completed,
    failed,
    cancelled: count('cancelled'),
    active: count('active'),
    users: count('users'),
    templates: count('templates'),
    timedCompleted: count('timed_completed'),
    successRate:
      completed + failed ? (100 * completed) / (completed + failed) : undefined,
    averageMs:
      row.average_ms === null || row.average_ms === undefined
        ? undefined
        : Number(row.average_ms),
    p95Ms:
      row.p95_ms === null || row.p95_ms === undefined
        ? undefined
        : Number(row.p95_ms),
  };
}

export async function readSummaryAndRollups(
  db: Knex,
  executions: Knex.QueryBuilder,
  maxHistoryRows: number,
  run: RunHistoryQuery,
) {
  // Materialize completion timings once for the three ranking dimensions.
  const metricSource = db.select('*').from('execution_cohort');
  const summaryQuery = metricsQuery(db, metricSource)
    .select(db.raw('MIN(created_at) AS oldest_at'))
    .select(db.raw("'summary' AS kind, NULL AS id, NULL AS name, MAX(created_at) AS last_run"));
  const groupedMetrics = (kind: 'template' | 'user') => metricsQuery(db, metricSource, kind)
    .select(db.raw('MIN(created_at) AS oldest_at'))
    .select(db.raw('? AS kind', [kind]))
    .orderBy('total', 'desc').orderBy('id').limit(maxHistoryRows + 1);
  const metricColumns = [
    'total', 'completed', 'failed', 'cancelled', 'active', 'users', 'templates',
    'timed_completed', 'average_ms', 'p95_ms', 'oldest_at', 'kind', 'id', 'name', 'last_run',
  ];
  const metricRows = await run(db.withMaterialized('execution_cohort', executions)
    .from(summaryQuery.as('summary')).select(metricColumns)
    .unionAll([
      db.from(groupedMetrics('template').as('templates')).select(metricColumns),
      db.from(groupedMetrics('user').as('users')).select(metricColumns),
    ]));
  const summaryRow = metricRows.find(row => row.kind === 'summary')!;
  const templateRows = metricRows.filter(row => row.kind === 'template');
  const userRows = metricRows.filter(row => row.kind === 'user');
  const rollups = (results: typeof templateRows, kind: 'template' | 'user') =>
    results.slice(0, maxHistoryRows)
      .map(row => {
        const userName = row.id === 'unknown' ? 'Unknown user' : (row.id as string);
        return {
          id: row.id as string,
          name: kind === 'template' ? (row.name as string) : userName,
          lastRun: isoDate(row.last_run),
          ...mapMetrics(row),
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return {
    summary: mapMetrics(summaryRow),
    templates: rollups(templateRows, 'template'),
    users: rollups(userRows, 'user'),
    rollupsTruncated: {
      templates: templateRows.length > maxHistoryRows,
      users: userRows.length > maxHistoryRows,
    },
    oldestAt: summaryRow.oldest_at ? isoDate(summaryRow.oldest_at) : undefined,
  };
}

export async function readDailyActivity(
  db: Knex,
  postgres: boolean,
  cohort: Knex.QueryBuilder,
  range: Pick<ExecutionQuery, 'from' | 'to'>,
  run: RunHistoryQuery,
): Promise<DailyActivity[]> {
  const date = postgres
    ? "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')"
    : 'substr(created_at, 1, 10)';
  const dailyRows = await run(db.from(cohort.as('cohort'))
    .where('created_at', '>=', postgres ? range.from : range.from.slice(0, 19).replace('T', ' '))
    .where('created_at', '<', postgres ? range.to : range.to.slice(0, 19).replace('T', ' '))
    .select(db.raw(`${date} AS date`))
    .select(db.raw('COUNT(*) AS total'))
    .select(db.raw("SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed"))
    .select(db.raw("SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed"))
    .groupBy('date'));
  const daily = new Map(dailyRows.map(row => [row.date, row]));
  const activity: DailyActivity[] = [];
  const end = Date.parse(range.to);
  for (let day = Date.parse(range.from); day < end; day += 86_400_000) {
    const dayKey = new Date(day).toISOString().slice(0, 10);
    const row = daily.get(dayKey);
    const total = Number(row?.total ?? 0);
    const completed = Number(row?.completed ?? 0);
    const failed = Number(row?.failed ?? 0);
    activity.push({ date: dayKey, total, completed, failed, other: total - completed - failed });
  }
  return activity;
}
