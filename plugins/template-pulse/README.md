# Template Pulse frontend

See template usage, success rates, run times, and past runs at `/template-pulse`. Filter by date, template, user, or team, and share filtered views with **Copy link**.

Requires Backstage's new frontend system, React 18, Node.js 22 or 24, and the Template Pulse backend.

```sh
yarn workspace app add @abayramli/backstage-plugin-template-pulse
```

Add the plugin to your app's features and import the Backstage UI stylesheet once:

```tsx
import '@backstage/ui/css/styles.css';
import { createApp } from '@backstage/frontend-defaults';
import templatePulse from '@abayramli/backstage-plugin-template-pulse';

createApp({ features: [/* existing features, */ templatePulse] });
```

Follow the installation guide to register the backend and configure permissions for personal and organization analytics.

[Installation](https://github.com/alibayramli/template-pulse#add-to-backstage) · [Live demo](https://alibayramli.github.io/template-pulse-demo/)
