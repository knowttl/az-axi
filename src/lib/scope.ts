import { SUBSCRIPTIONS_LIST } from "./apiVersions.js";
import { requestAll } from "./client.js";
import type { ResolvedProfile } from "./config.js";

/**
 * ARM resource ID shortening for display (PLAN.md Section 6).
 * `/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Compute/virtualMachines/<name>`
 * becomes `<sub-name>/<rg>/vm/<name>`. The full ID is shown with `--full` or `--fields id`.
 * Subscription display names are looked up once per process and cached.
 */

const SUBSCRIPTION_SEGMENT = /^\/subscriptions\/([^/]+)/i;
const FULL_ID =
  /^\/subscriptions\/([^/]+)(?:\/resourceGroups\/([^/]+))?(?:\/providers\/([^/]+)\/([^/]+)\/([^/]+)(.*)?)?$/i;

const TYPE_ABBREV: Record<string, string> = {
  virtualmachines: "vm",
  storageaccounts: "st",
  vaults: "kv",
  virtualnetworks: "vnet",
  networksecuritygroups: "nsg",
  publicipaddresses: "pip",
  networkinterfaces: "nic",
  managedclusters: "aks",
  sites: "app",
  serverfarms: "plan",
  databases: "db",
  firewalls: "fw",
  loadbalancers: "lb",
};

function abbrev(resourceType: string): string {
  return TYPE_ABBREV[resourceType.toLowerCase()] ?? resourceType;
}

/** Extracts the subscription ID from an ARM resource ID, if present. */
export function parseSubscriptionId(resourceId: string): string | undefined {
  return SUBSCRIPTION_SEGMENT.exec(resourceId)?.[1];
}

/**
 * Shortens one ARM resource ID. Non-ARM strings pass through unchanged.
 * `names` maps lower-cased subscription IDs to display names; without it the
 * raw subscription ID is used so the result stays correct offline.
 */
export function shortenResourceId(resourceId: string, names?: Map<string, string>): string {
  const match = FULL_ID.exec(resourceId);
  if (!match) return resourceId;
  const subId = match[1] ?? "";
  const rg = match[2];
  const type = match[4];
  const name = match[5];
  const rest = match[6];
  const subLabel = names?.get(subId.toLowerCase()) ?? subId;
  if (!type || !name) return rg ? `${subLabel}/${rg}` : subLabel;
  let short = rg ? `${subLabel}/${rg}/${abbrev(type)}/${name}` : `${subLabel}/${abbrev(type)}/${name}`;
  const tail = (rest ?? "").split("/").filter(Boolean);
  for (let i = 0; i + 1 < tail.length; i += 2) {
    short += `/${tail[i]}/${tail[i + 1]}`;
  }
  return short;
}

let cachedProfile: string | undefined;
let cachedNames: Map<string, string> | undefined;

/** Clears the per-process subscription name cache (tests only). */
export function clearSubscriptionCache(): void {
  cachedProfile = undefined;
  cachedNames = undefined;
}

/**
 * Subscription ID (lower-cased) to display name, cached per process. Never throws:
 * when ARM is unreachable the map is empty and callers fall back to raw IDs.
 */
export async function subscriptionNameMap(profile: ResolvedProfile): Promise<Map<string, string>> {
  if (cachedNames && cachedProfile === profile.name) return cachedNames;
  try {
    const { items } = await requestAll<{ subscriptionId: string; displayName: string }>(
      profile,
      { path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST },
      100,
    );
    const names = new Map<string, string>();
    for (const sub of items) {
      if (sub.subscriptionId) names.set(sub.subscriptionId.toLowerCase(), sub.displayName ?? sub.subscriptionId);
    }
    cachedProfile = profile.name;
    cachedNames = names;
    return names;
  } catch {
    cachedProfile = profile.name;
    cachedNames = new Map();
    return cachedNames;
  }
}
