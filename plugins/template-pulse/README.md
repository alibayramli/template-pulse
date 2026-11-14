# Template Pulse frontend

See template usage, success rates, and run times at `/template-pulse`. Filter runs by date, template, user, or team. Use **Copy link** to share a view.

Requires Backstage's new frontend system, React 18, Node.js 22 or 24, and the Template Pulse backend.

```sh
yarn workspace app add @abayramli/backstage-plugin-template-pulse
```

Add the plugin to your app and import the Backstage UI stylesheet once:

```tsx
import '@backstage/ui/css/styles.css';
import { createApp } from '@backstage/frontend-defaults';
import templatePulse from '@abayramli/backstage-plugin-template-pulse';

createApp({ features: [/* existing features, */ templatePulse] });
```

Follow the [installation guide](https://github.com/alibayramli/template-pulse#add-to-backstage) to add the backend and choose who can view runs.

Update all Template Pulse packages together. For older saved runs and searchable filters, add the [database history module](https://github.com/alibayramli/template-pulse/tree/main/plugins/scaffolder-backend-module-template-pulse).

[Live demo](https://alibayramli.github.io/template-pulse-demo/)
