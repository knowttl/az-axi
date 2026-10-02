import { describe, expect, it } from "vitest";
import {
  CONTRIBUTOR_ROLE_ID,
  OWNER_ROLE_ID,
  RBAC_ADMIN_ROLE_ID,
  USER_ACCESS_ADMIN_ROLE_ID,
  isPrivilegedRole,
  roleGuidFromId,
} from "../src/lib/roles.js";

const SYN = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;

describe("roles", () => {
  it("extracts the GUID from a full role definition ID", () => {
    expect(roleGuidFromId(`/providers/Microsoft.Authorization/roleDefinitions/${OWNER_ROLE_ID}`)).toBe(
      OWNER_ROLE_ID.toLowerCase(),
    );
    expect(roleGuidFromId(SYN(31).toUpperCase())).toBe(SYN(31));
    expect(roleGuidFromId(undefined)).toBe("");
  });

  it("matches the four privileged built-ins by GUID", () => {
    for (const id of [OWNER_ROLE_ID, CONTRIBUTOR_ROLE_ID, USER_ACCESS_ADMIN_ROLE_ID, RBAC_ADMIN_ROLE_ID]) {
      expect(isPrivilegedRole(`/subscriptions/${SYN(20)}/providers/Microsoft.Authorization/roleDefinitions/${id}`)).toBe(
        true,
      );
    }
    expect(isPrivilegedRole(`/providers/Microsoft.Authorization/roleDefinitions/${SYN(31)}`)).toBe(false);
    expect(isPrivilegedRole(undefined)).toBe(false);
  });
});
