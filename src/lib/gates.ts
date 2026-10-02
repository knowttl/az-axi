import { AxiError } from "axi-sdk-js";
import type { ResolvedProfile } from "./config.js";
import type { RequestClass, RequestShape } from "./policy.js";

/**
 * The only place write decisions are made (PLAN.md Section 6.13.2).
 * Until Phase 6 this is a stub: every `write` and `destructive` request is
 * blocked unconditionally, whatever the profile or environment says.
 */
export function enforceGates(profile: ResolvedProfile, request: RequestShape, cls: RequestClass): void {
  if (cls !== "write" && cls !== "destructive") return;
  throw new AxiError(
    `blocked: writes are disabled for profile '${profile.name}' (${request.method.toUpperCase()} request)`,
    "WRITES_DISABLED",
    ["Writes are disabled for this profile", "A human can find the details in README.md#writes"],
  );
}
