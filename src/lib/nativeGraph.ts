import { RESOURCE_GRAPH_RESOURCES } from "./apiVersions.js";
import { sendRequest } from "./client.js";
import type { ResolvedProfile } from "./config.js";
import type { NativeListBudget } from "./nativePaging.js";

/** Native inventories share fetch limits; arbitrary graph queries keep their own contract. */
export async function nativeGraphList<T>(
  profile: ResolvedProfile,
  query: string,
  subscriptions: string[] | undefined,
  managementGroups: string[] | undefined,
  budget: NativeListBudget,
  options: Record<string, string> = {},
): Promise<{ rows: T[]; totalRecords?: number; incomplete: boolean; quotaRemaining?: string; quotaReset?: string }> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let skipToken: string | undefined;
  let totalRecords: number | undefined;
  let quotaRemaining: string | undefined;
  let quotaReset: string | undefined;
  for (let page = 0; page < budget.maxPages; page++) {
    const remaining = budget.maxRows - rows.length;
    const response = await sendRequest<{
      data?: T[]; totalRecords?: number; $skipToken?: string; resultTruncated?: boolean | string;
    }>(profile, {
      method: "POST", path: "/providers/Microsoft.ResourceGraph/resources", apiVersion: RESOURCE_GRAPH_RESOURCES,
      body: {
        query,
        ...(subscriptions ? { subscriptions } : {}),
        ...(managementGroups ? { managementGroups } : {}),
        options: { ...options, $top: Math.min(1000, remaining), resultFormat: "objectArray", ...(skipToken ? { $skipToken: skipToken } : {}) },
      },
    });
    const body = response.body ?? {};
    totalRecords ??= body.totalRecords;
    quotaRemaining = response.headers?.["x-ms-user-quota-remaining"];
    quotaReset = response.headers?.["x-ms-user-quota-resets-after"];
    const data = body.data ?? [];
    rows.push(...data.slice(0, remaining));
    skipToken = body.$skipToken;
    const result = { rows, totalRecords, quotaRemaining, quotaReset };
    if (data.length > remaining) return { ...result, incomplete: true };
    if (!skipToken) return { ...result, incomplete: body.resultTruncated === true || body.resultTruncated === "true" || (totalRecords !== undefined && totalRecords > rows.length) };
    if (rows.length === budget.maxRows || seen.has(skipToken)) return { ...result, incomplete: true };
    seen.add(skipToken);
  }
  return { rows, totalRecords, incomplete: true, quotaRemaining, quotaReset };
}
