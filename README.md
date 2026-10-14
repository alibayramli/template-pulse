# Template Pulse

**[Try the live demo](https://alibayramli.github.io/template-pulse-demo/)** · [Run the demo locally](https://github.com/alibayramli/template-pulse-demo#run-the-showcase)

![Template Pulse](plugins/template-pulse/assets/template-pulse-wordmark.svg)

See which Backstage templates people use, how often runs succeed, and how long they take. Filter execution history and open the original Scaffolder task to investigate.

- Template health, user activity, and daily execution counts.
- Date, template, and user filters, plus execution search and status filters.
- Personal and organization views with permission checks and shareable links.

## Add to Backstage

Requires Node.js 22 or 24, Yarn 4, React 18, and Backstage's new frontend and backend systems. Tested with Backstage 1.55.

Packages are not published yet. Copy all five folders in `plugins/` into your Backstage workspace, then add the dependencies (adjust workspace names if needed):

```sh
yarn workspace app add @template-pulse/plugin@workspace:^
yarn workspace backend add @template-pulse/plugin-backend@workspace:^ @template-pulse/plugin-scaffolder-backend-module-template-pulse@workspace:^ @template-pulse/plugin-common@workspace:^
```

Add the frontend plugin to your app's existing features and import the Backstage UI stylesheet once:

```tsx
import '@backstage/ui/css/styles.css';
import templatePulse from '@template-pulse/plugin';

createApp({ features: [/* existing features, */ templatePulse] });
```

Register the backend plugin and history module alongside your existing Scaffolder backend:

```ts
backend.add(import('@template-pulse/plugin-backend'));
backend.add(
  import('@template-pulse/plugin-scaffolder-backend-module-template-pulse'),
);
```

Configure `app-config.yaml`:

```yaml
permission:
  enabled: true
templatePulse:
  historySource: database
```

Merge the [permission example](examples/permission-policy.ts) into your existing policy. Grant `template-pulse.read` for personal analytics and reserve `template-pulse.read-all` for users allowed to view organization analytics. Scaffolder task permissions still apply.

Open **/template-pulse**. Task links open Scaffolder runs; template and user links open Catalog entities.

## How analytics work

Date, template, and user filters update all analytics. Search and status filters narrow only the **Executions** list. Shared links preserve the selected filters and view.

Success rate uses completed and failed runs. Average and P95 durations use successful runs with timing data, including queue time; P95 is the 95th percentile. Missing values appear as **—**. Dates use UTC.

- **Database history** covers all retained, accessible runs and supports loading older executions. **All history** includes every saved date; the activity chart shows the last 30 days.
- **Service history** (`historySource: service`, the default) uses the Scaffolder API and checks only the latest `maxTasks` runs (default: 200). Use it for custom task stores or permission rules; it has no **All history** option.

Analytics exclude inputs, secrets, outputs, and raw logs. Deleted history cannot be recovered.

Database history reads the standard Scaffolder SQL tables without changing them. SQLite is tested; PostgreSQL needs live validation. Check schema compatibility after Scaffolder upgrades and memory use with large histories.

## Development

```sh
yarn install
yarn build
yarn test
```

Keep all five packages on the same version. `yarn workspace @template-pulse/plugin start` opens the frontend development app; analytics require an authenticated backend.

[Apache-2.0](LICENSE) · [Brand assets](plugins/template-pulse/assets/README.md)
