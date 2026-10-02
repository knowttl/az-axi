import { AxiError } from "axi-sdk-js";
import { readOnlyForced, type ResolvedProfile } from "./config.js";
import { DESTRUCTIVE_ACTIONS, type RequestClass, type RequestShape } from "./policy.js";
import { quoteFlagValue } from "./shell.js";

export interface GateOptions {
  /** `--execute`: only the api command supplies this; the client backstop never does. */
  execute?: boolean;
  /** `--confirm <resource-name>` for destructive requests. */
  confirm?: string;
}

/** Hints for gates 1-3 never explain how writes are enabled (PLAN.md Section 6.13.2). */
const WRITES_DISABLED_HINTS = [
  "Writes are disabled for this profile",
  "A human can find the details in README.md#writes",
];

/** Strips a trailing query string or fragment so gates see the path only. */
function barePath(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? "";
}

/** Percent-decoded, non-empty path segments, preserving case for display. */
function rawSegments(path: string): string[] {
  return barePath(path)
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

const DESTRUCTIVE_SET = new Set(DESTRUCTIVE_ACTIONS.map((action) => action.toLowerCase()));

/**
 * The resource name a destructive `--confirm` must match (PLAN.md Section 6.13.2
 * gate 5): the final name segment of the path, except for destructive POST
 * actions (`.../vm1/restart`), where the action is the final segment and the
 * resource name is the one before it.
 */
export function targetResourceName(path: string, method: string): string {
  const segments = rawSegments(path);
  const last = segments[segments.length - 1] ?? "";
  if (method.toUpperCase() === "POST" && DESTRUCTIVE_SET.has(last.toLowerCase())) {
    return segments[segments.length - 2] ?? last;
  }
  return last;
}

/** The subscription ID from the first `/subscriptions/{id}` pair, if the path has one. */
export function subscriptionOfPath(path: string): string | undefined {
  return /^\/subscriptions\/([^/?#]+)/i.exec(barePath(path))?.[1];
}

/**
 * The only place write decisions are made (PLAN.md Section 6.13.2), applied to
 * `write` and `destructive` requests in order, stopping at the first failure:
 * READ_ONLY env, profile allowWrites, subscription scope, then (when the caller
 * passes `execute`) the destructive confirm and the execute step. Without
 * `execute` the caller runs the dry run (Section 6.13.3); the client backstop
 * calls without options and enforces gates 1-3 only.
 */
export function enforceGates(
  profile: ResolvedProfile,
  request: RequestShape,
  cls: RequestClass,
  options: GateOptions = {},
): void {
  if (cls !== "write" && cls !== "destructive") return;
  const method = request.method.toUpperCase();

  // Gate 1: $AZ_AXI_READ_ONLY=1 overrides every profile.
  if (readOnlyForced()) {
    throw new AxiError(
      `blocked: writes are disabled for profile '${profile.name}' (${method} request)`,
      "WRITES_DISABLED",
      WRITES_DISABLED_HINTS,
    );
  }

  // Gate 2: the profile must opt in.
  if (profile.allowWrites !== true) {
    throw new AxiError(
      `blocked: writes are disabled for profile '${profile.name}' (${method} request)`,
      "WRITES_DISABLED",
      WRITES_DISABLED_HINTS,
    );
  }

  // Gate 3: the write must target a subscription in the profile's own
  // `subscriptions` (copied to `writeSubscriptions` before any flag or env
  // override, so neither can widen it). Paths with no subscription segment
  // (management group or tenant scope) are always blocked in v1.
  const subscription = subscriptionOfPath(request.path);
  const allowed = new Set(profile.writeSubscriptions.map((id) => id.toLowerCase()));
  if (subscription === undefined || !allowed.has(subscription.toLowerCase())) {
    throw new AxiError(
      subscription === undefined
        ? `blocked: writes without a subscription scope are disabled for profile '${profile.name}' (${method} request)`
        : `blocked: writes to subscription '${subscription}' are disabled for profile '${profile.name}' (${method} request)`,
      "SUBSCRIPTION_NOT_WRITABLE",
      ["Writes are limited to this profile's subscriptions", "A human can find the details in README.md#writes"],
    );
  }

  // Gate 4: no --execute means the caller shows the dry run instead.
  if (!options.execute) return;

  // Gate 5: destructive requests need the target resource name back.
  if (cls === "destructive") {
    const target = targetResourceName(request.path, method);
    if (options.confirm === undefined) {
      throw new AxiError(
        `blocked: destructive ${method} needs --confirm '${target}' (profile '${profile.name}')`,
        "CONFIRM_REQUIRED",
        [`Re-run with --confirm ${quoteFlagValue(target)}`],
      );
    }
    if (options.confirm !== target) {
      throw new AxiError(
        `blocked: --confirm '${options.confirm}' does not match target resource '${target}' (profile '${profile.name}')`,
        "CONFIRM_MISMATCH",
        [`Re-run with --confirm ${quoteFlagValue(target)}`],
      );
    }
  }

  // Gate 6: execution itself arrives in a later piece; this build previews only
  // and never sends a write (stable code API_ERROR per Section 6.12).
  throw new AxiError(
    `blocked: execution is not available yet for ${method} ${barePath(request.path)} (profile '${profile.name}'): re-run without --execute for the dry run`,
    "API_ERROR",
    ["This build previews writes only and never sends them", "Re-run without --execute to see the dry run"],
  );
}
