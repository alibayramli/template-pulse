# Template Pulse backend

Analytics for Scaffolder runs, controlled by Backstage permissions.

Requires Backstage's new backend system and Node.js 22 or 24.

```sh
yarn workspace backend add @abayramli/backstage-plugin-template-pulse-backend @abayramli/backstage-plugin-template-pulse-common
```

Register it alongside your Scaffolder and permission backends:

```ts
backend.add(import('@abayramli/backstage-plugin-template-pulse-backend'));
```

Follow the [installation guide](https://github.com/alibayramli/template-pulse#add-to-backstage) to enable permissions and choose who can view their own runs or runs across the organization. Team filters require organization access and use the catalog group's current direct members.

By default, the backend reads the latest 200 Scaffolder runs through its public API (`templatePulse.historySource: service`). Add the optional [database history module](https://github.com/alibayramli/template-pulse/tree/main/plugins/scaffolder-backend-module-template-pulse) and set `templatePulse.historySource: database` to include all runs still stored in Scaffolder's database.
