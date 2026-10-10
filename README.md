# Template Pulse

![Template Pulse](plugins/template-pulse/assets/template-pulse-wordmark.svg)

See which Backstage templates people use, how often runs succeed, and how long they take. Find a problem, filter its runs, and open the original task to investigate.

- Template health, user activity, and daily execution counts.
- Date, template and user filters for analytics; search and status filters for executions.
- Shareable links that keep the selected filters and view.
- Personal analytics for developers; organization analytics for authorized users.

## Add to Backstage

The packages are not published yet. Copy the five folders in `plugins/` into your Backstage workspace. Add `@template-pulse/plugin` to the app package dependencies and `@template-pulse/plugin-backend` plus `@template-pulse/plugin-scaffolder-backend-module-template-pulse` to the backend package dependencies using `workspace:^`, then run `yarn install`.

Register the frontend plugin:

```tsx
import templatePulse from "@template-pulse/plugin";

createApp({ features: [/* existing features, */ templatePulse] });
```

Register the backend plugin:

```ts
backend.add(import("@template-pulse/plugin-backend"));
// Install alongside Scaffolder when using database history:
backend.add(
  import("@template-pulse/plugin-scaffolder-backend-module-template-pulse")
);
```

Import `@backstage/ui/css/styles.css` once in your app entry point. Add this configuration:

```yaml
permission:
  enabled: true
templatePulse:
  historySource: database
  maxTasks: 200
app:
  routes:
    bindings:
      template-pulse.task: scaffolder.ongoingTask
```

Use the [permission example](examples/permission-policy.ts) to grant `template-pulse.read` for personal analytics and `template-pulse.read-all` for organization analytics. An allow-all policy grants both. Existing task permissions still apply, including when a link is shared.

Open **/template-pulse**. Template and user links open their Catalog pages; task links open the Scaffolder run.

## Understand the numbers

Date, template and user filters affect every total, chart and table. Only templates and users with runs in that selection appear. Search and status filters in **Executions** narrow that list without changing template health, user adoption or daily activity. Search matches template names/references, user references and task IDs; use the status selector for outcomes.

Success rate counts completed and failed runs; active and cancelled runs are excluded. Average and P95 times use successful runs with timing data and include queue time. P95 is the time within which 95% of those runs finished. Missing timing data is shown as **—**. Dates use UTC.

**Database history** searches all saved, accessible runs. Execution details load in batches; their matching count includes every search/status match, while analytics cover all runs in the selected dates/templates/users. **All history** includes every saved date, while the chart shows the last 30 days.

**Service history** (the default when the setting is omitted) checks only the latest `maxTasks` runs and warns when older runs are missing. Use it for a custom task store or permission rules. It does not offer All history or loading older runs.

Inputs, secrets, outputs and raw logs are not included in analytics. Deleted history cannot be recovered.

## Compatibility and development

Requires the new Backstage frontend and backend systems, React 18, Backstage UI 0.18, frontend-plugin-api 0.18 and scaffolder-node 0.13.7 or compatible versions. Legacy frontend apps need to migrate before using this plugin.

Database history is hosted by a Scaffolder backend module, which receives the Scaffolder database through `coreServices.database`. Template Pulse calls that module over authenticated HTTP using the current user's credentials. The module reads the standard SQLite or PostgreSQL Scaffolder tables without changing them. SQLite is tested locally. PostgreSQL still needs live validation. Check compatibility after Scaffolder upgrades and performance with your history volume; runs in the analytics selection are currently summarized in backend memory. Custom task permission rules should use service history.

Use Node.js 22 or 24: `yarn install`, `yarn build`, `yarn test`. Keep all five packages on the same version. Run `yarn workspace @template-pulse/plugin start` for the standalone frontend development app; analytics require a running backend and authentication.

Apache-2.0 licensed. [Brand assets](plugins/template-pulse/assets/README.md).

See the [Backstage design audit](docs/backstage-design-audit.md) for the official references, package roles and remaining compatibility limits.
