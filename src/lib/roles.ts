/**
 * Built-in privileged role definition GUIDs (PLAN.md Section 6.6).
 *
 * These are public, Microsoft-wide constants from the Azure built-in roles
 * reference page, not tenant data. They live here (and only here) so the
 * public-repo identifier guard can allow them by import.
 *
 * Reference: Azure built-in roles
 * (https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles)
 */

export const OWNER_ROLE_ID = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
export const CONTRIBUTOR_ROLE_ID = "b24988ac-6180-42a0-ab88-20f7382dd24c";
export const USER_ACCESS_ADMIN_ROLE_ID = "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9";
export const RBAC_ADMIN_ROLE_ID = "f58310d9-a9f6-439a-9e8d-f62e7b41a168";

/** Lower-cased privileged role definition GUIDs. */
export const PRIVILEGED_ROLE_IDS: ReadonlySet<string> = new Set(
  [OWNER_ROLE_ID, CONTRIBUTOR_ROLE_ID, USER_ACCESS_ADMIN_ROLE_ID, RBAC_ADMIN_ROLE_ID].map((id) =>
    id.toLowerCase(),
  ),
);

/** Extracts the role definition GUID (lower-cased) from a full ARM role definition ID. */
export function roleGuidFromId(roleDefinitionId: string | undefined): string {
  if (!roleDefinitionId) return "";
  const segments = roleDefinitionId.split("/").filter(Boolean);
  return (segments[segments.length - 1] ?? "").toLowerCase();
}

/** True when the assignment's role definition is one of the privileged built-ins. */
export function isPrivilegedRole(roleDefinitionId: string | undefined): boolean {
  return PRIVILEGED_ROLE_IDS.has(roleGuidFromId(roleDefinitionId));
}
