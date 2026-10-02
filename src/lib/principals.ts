import { AxiError } from "axi-sdk-js";
import { GRAPH_GET_BY_IDS } from "./apiVersions.js";
import { sendRequest } from "./client.js";
import type { ResolvedProfile } from "./config.js";

/**
 * Principal name resolution through Microsoft Graph (PLAN.md Section 6.6).
 * Best effort: Graph failures degrade to raw object IDs with a hint,
 * and must never fail the calling command.
 */

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BATCH_SIZE = 1000;

interface GetByIdsResponse {
  value?: Array<{
    id?: string;
    displayName?: string;
    userPrincipalName?: string;
  }>;
}

/** True for a raw Azure object ID (a GUID). */
export function isObjectId(value: string): boolean {
  return GUID.test(value.trim());
}

/**
 * Resolves one `--principal` value to an object ID. GUIDs pass through;
 * anything else is treated as a UPN and looked up via Graph.
 * Throws VALIDATION_ERROR asking for the object ID when Graph cannot resolve it.
 */
function unresolved(principal: string, detail: string): AxiError {
  return new AxiError(`could not resolve principal '${principal}': pass the object ID instead`, "VALIDATION_ERROR", [
    detail,
    "Find the object ID with `az ad user show --id <upn> --query id`",
    "Or pass --principal <objectId> directly",
  ]);
}

export async function resolvePrincipalId(profile: ResolvedProfile, principal: string): Promise<string> {
  const text = principal.trim();
  if (!text) {
    throw new AxiError("flag --principal needs a non-empty value", "VALIDATION_ERROR", [
      "Pass --principal <upn> or --principal <objectId>",
    ]);
  }
  if (isObjectId(text)) return text;
  try {
    const body = await sendRequest<{ id?: string }>(profile, {
      resource: "graph",
      method: "GET",
      path: `/${GRAPH_GET_BY_IDS}/users/${encodeURIComponent(text)}`,
    }).then((response) => response.body);
    if (body?.id && isObjectId(body.id)) return body.id;
  } catch (err) {
    const detail = err instanceof Error && err.message ? err.message : "Graph request failed";
    throw unresolved(text, detail);
  }
  throw unresolved(text, "Graph did not return an object ID");
}

/**
 * Batch-resolves object IDs to display names with `getByIds`.
 * Never throws: on any Graph failure the map is partial or empty and
 * `resolved` is false, so callers show raw IDs with one hint.
 */
export async function resolvePrincipalNames(
  profile: ResolvedProfile,
  ids: readonly string[],
): Promise<{ names: Map<string, string>; resolved: boolean }> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const names = new Map<string, string>();
  if (unique.length === 0) return { names, resolved: true };

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    let body: GetByIdsResponse | undefined;
    try {
      const response = await sendRequest<GetByIdsResponse>(profile, {
        resource: "graph",
        method: "POST",
        // `types` is omitted on purpose: the default searches every directory
        // object, including service principals and managed identities.
        path: `/${GRAPH_GET_BY_IDS}/directoryObjects/getByIds`,
        body: { ids: batch },
      });
      body = response.body;
    } catch {
      return { names, resolved: false };
    }
    for (const entry of body?.value ?? []) {
      if (entry.id && (entry.displayName || entry.userPrincipalName)) {
        names.set(entry.id.toLowerCase(), entry.displayName ?? entry.userPrincipalName ?? entry.id);
      }
    }
  }
  // A 200 with no names is not success: the caller must say names are unresolved.
  return { names, resolved: names.size > 0 };
}
