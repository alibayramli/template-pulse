# Template Pulse Node utilities

Shared backend utilities for checking queries and permissions, calculating statistics, reading run history, and resolving team members.

The backend and database history module install this package automatically. Add it directly when your own backend code imports these utilities:

```sh
yarn workspace backend add @abayramli/backstage-plugin-template-pulse-node
```

Exports `aggregateExecutions`, `parseExecutionQuery`, `authorizeExecutionQuery`, `HistoryClient`, and `TeamMembersClient`. Requires Node.js 22 or 24.

[Installation guide](https://github.com/alibayramli/template-pulse#add-to-backstage)
