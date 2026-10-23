# Template Pulse database history

Let the Template Pulse backend read all runs still stored in Scaffolder's database. Requires Backstage's new backend system and Node.js 22 or 24.

```sh
yarn workspace backend add @abayramli/backstage-plugin-scaffolder-backend-module-template-pulse
```

Register it alongside your Scaffolder backend:

```ts
backend.add(import('@abayramli/backstage-plugin-scaffolder-backend-module-template-pulse'));
```

Select database history in `app-config.yaml`:

```yaml
templatePulse:
  historySource: database
```

Install the Template Pulse frontend and backend and configure permissions using the [installation guide](https://github.com/alibayramli/template-pulse#add-to-backstage). This module uses the same personal and organization permissions as the backend.

- Uses Scaffolder's existing database connection to read its standard SQL tables without changing them. Tested with SQLite and PostgreSQL.
- Checks the database structure after Scaffolder starts and finishes its migrations.
- Supports the built-in `IS_TASK_OWNER` permission rule. For custom task stores or permission rules, set `templatePulse.historySource: service`.
- After upgrading Scaffolder, check that its database structure still works with this module.

