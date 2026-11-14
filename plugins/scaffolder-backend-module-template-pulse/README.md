# Template Pulse database history

Read runs still saved in Scaffolder's database. Requires Backstage's new backend system and Node.js 22 or 24.

```sh
yarn workspace backend add @abayramli/backstage-plugin-scaffolder-backend-module-template-pulse
```

Add it alongside your Scaffolder backend:

```ts
backend.add(import('@abayramli/backstage-plugin-scaffolder-backend-module-template-pulse'));
```

Enable it in `app-config.yaml`:

```yaml
templatePulse:
  historySource: database
```

Follow the [installation guide](https://github.com/alibayramli/template-pulse#add-to-backstage) for the frontend, backend, and permissions. Update all Template Pulse packages together.

Works with SQLite and PostgreSQL without changing Scaffolder's tables. Supports the built-in `IS_TASK_OWNER` rule. For custom task storage or permission rules, use `templatePulse.historySource: service`. Check this module after upgrading Scaffolder.

## Using history

- Filters show 100 template or user choices at a time. Type to find more.
- Totals cover all matching runs. Template and user lists show up to 10,000 entries each by default (`templatePulse.maxHistoryRows`).
- **Load more** pages expire after two minutes. Reload if asked. Narrow searches above 50,000 runs to load more pages.
- SQLite also limits searches to 50,000 runs. For large or busy searches, narrow the dates or filters and try again.
- If you run multiple backend servers, give Scaffolder a shared Backstage cache so **Load more** works across servers.
