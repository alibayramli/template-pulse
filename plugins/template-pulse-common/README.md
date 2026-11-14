# Template Pulse common

Shared types, status labels, and permissions.

Installed automatically with the plugins. Add it directly when your permission policy imports it:

```sh
yarn workspace backend add @abayramli/backstage-plugin-template-pulse-common
```

Your app's permission policy grants:

- `executionsReadPermission` (`template-pulse.read`) for a user's own runs.
- `executionsReadAllPermission` (`template-pulse.read-all`) for runs across the organization.

[Installation guide](https://github.com/alibayramli/template-pulse#add-to-backstage)
