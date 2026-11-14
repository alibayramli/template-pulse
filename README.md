# Template Pulse

**[Try the live demo](https://alibayramli.github.io/template-pulse-demo/)** · [Run the demo locally](https://github.com/alibayramli/template-pulse-demo#run-the-showcase)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="plugins/template-pulse/assets/template-pulse-wordmark-inverse.svg">
  <img src="plugins/template-pulse/assets/template-pulse-wordmark.svg" alt="Template Pulse" width="380" height="80">
</picture>

See which Backstage templates people use, how often runs succeed, and how long they take. Filter runs by date, template, user, or team, and open the Scaffolder task for details.

## Preview

Template Pulse in Backstage with sample data.

![Template Pulse showing template usage, success rates, and run times](docs/assets/screenshots/template-health.png)

<details>
<summary>Teams and run history</summary>

![Runs for a selected team](docs/assets/screenshots/team-adoption.png)

![Failed runs for a selected template](docs/assets/screenshots/executions-by-template.png)

![Runs for a selected team and user](docs/assets/screenshots/executions-by-user.png)

</details>

## Add to Backstage

Requires Backstage's new frontend and backend, React 18, and Node.js 22 or 24.

Update all Template Pulse packages together, including the optional history module.

Install the packages:

```sh
yarn workspace app add @abayramli/backstage-plugin-template-pulse
yarn workspace backend add @abayramli/backstage-plugin-template-pulse-backend @abayramli/backstage-plugin-template-pulse-common
```

Add the plugin to your app and import the Backstage UI styles once:

```tsx
import '@backstage/ui/css/styles.css';
import { createApp } from '@backstage/frontend-defaults';
import templatePulse from '@abayramli/backstage-plugin-template-pulse';

createApp({ features: [/* existing features, */ templatePulse] });
```

Add the backend alongside your Scaffolder and permission backends:

```ts
backend.add(import('@abayramli/backstage-plugin-template-pulse-backend'));
```

Enable permissions in `app-config.yaml`:

```yaml
permission:
  enabled: true
```

Follow the [permission example](examples/permission-policy.ts):

- `template-pulse.read` lets users see their own runs.
- `template-pulse.read-all` lets users see runs across the organization.

Scaffolder task permissions also apply. An allow-all policy lets every signed-in user see runs across the organization.

Open **/template-pulse**. Team filters require `template-pulse.read-all` and use the group's current direct members.

Search, status, and sorting change only the run list. Use **Copy link** to share your filters. Inputs, secrets, outputs, and raw logs are not shown.

By default, the dashboard covers the latest 200 Scaffolder runs. Add the [database history module](plugins/scaffolder-backend-module-template-pulse/README.md) for older runs and searchable filters. Its guide covers limits and setup for multiple backend servers.

[Apache-2.0](LICENSE)
