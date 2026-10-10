// Merge these decisions into your existing permission policy.
// Replace the group reference with the administrator group in your catalog.
import { AuthorizeResult, isPermission } from '@backstage/plugin-permission-common';
import type { PolicyQuery, PolicyQueryUser } from '@backstage/plugin-permission-node';
import {
  executionsReadPermission,
  executionsReadAllPermission,
} from '@template-pulse/plugin-common';

export function executionHistoryDecision(request: PolicyQuery, user?: PolicyQueryUser) {
  if (isPermission(request.permission, executionsReadPermission)) {
    return { result: user ? AuthorizeResult.ALLOW : AuthorizeResult.DENY };
  }
  if (isPermission(request.permission, executionsReadAllPermission)) {
    const isAdmin = user?.info.ownershipEntityRefs.includes('group:default/platform-admins');
    return { result: isAdmin ? AuthorizeResult.ALLOW : AuthorizeResult.DENY };
  }
  return undefined; // Continue with the rest of the host policy.
}
