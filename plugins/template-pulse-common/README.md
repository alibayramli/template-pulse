# Template Pulse common

Shared execution types, status labels, and permissions for the frontend and backend.

The plugins install this package automatically. Add it directly when your permission policy imports its permissions:

```sh
yarn workspace backend add @abayramli/backstage-plugin-template-pulse-common
```

Use `executionsReadPermission` (`template-pulse.read`) for personal analytics and `executionsReadAllPermission` (`template-pulse.read-all`) for organization analytics. The host app's permission policy decides who receives each permission.

[Installation guide](https://github.com/alibayramli/template-pulse#add-to-backstage)
