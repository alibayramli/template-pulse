# Template Pulse backend

Provides template usage, success rates, and run times. Backstage permissions control who can view runs.

Requires Backstage's new backend system and Node.js 22 or 24.

```sh
yarn workspace backend add @abayramli/backstage-plugin-template-pulse-backend @abayramli/backstage-plugin-template-pulse-common
```

Add it alongside your Scaffolder and permission backends:

```ts
backend.add(import('@abayramli/backstage-plugin-template-pulse-backend'));
```

Follow the [installation guide](https://github.com/alibayramli/template-pulse#add-to-backstage) to set permissions. Team filters use each group's current direct members and require `template-pulse.read-all`.

Template Pulse uses database history automatically when the optional module is registered. Otherwise, it reads the latest 200 Scaffolder runs by default. Set `templatePulse.historySource` to `service` or `database` to choose a source explicitly. [Database history module](https://github.com/alibayramli/template-pulse/tree/main/plugins/scaffolder-backend-module-template-pulse)

Large task logs can leave run times blank in service mode. If a search is too large or the service is busy, narrow the filters and try again.

Update all Template Pulse packages together.
