import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, flagText, parseArgs } from "../lib/args.js";
import { buildUrl, sendRequest } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { dryRun } from "../lib/dryRun.js";
import { executeWrite } from "../lib/execute.js";
import { parseTimeoutFlag } from "../lib/lro.js";
import { formatFlagValue, quoteFlagValue } from "../lib/shell.js";
import { countLine, pickFields, truncate } from "../lib/format.js";
import { enforceGates } from "../lib/gates.js";
import { assertReadOnlyBoundary, classifyRequest } from "../lib/policy.js";
import type { CommandMeta } from "../lib/registry.js";
import type { Resource } from "../lib/config.js";

/**
 * Escape hatch for any read or query request (PLAN.md Section 6.11). Reads and
 * queries are served directly; writes and destructive requests go through the
 * gate order (Section 6.13.2) and return the dry run (Section 6.13.3) or,
 * with --execute, the execute flow (Section 6.13.4).
 */
export const meta: CommandMeta = { name: "api", effect: "dynamic" };

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
const KNOWN_FLAGS = ["resource", "api-version", "query", "body", "raw", "all", "execute", "confirm", "if-match", "timeout", "no-wait"] as const;
const STRING_TRUNCATE = 4000;
const MAX_PAGES = 10;

function morePagesHint(options: {
  method: string;
  path: string;
  resource: Resource;
  apiVersion?: string;
  query?: string;
  body?: string;
}): string {
  const parts = ["az-axi api"];
  if (options.method !== "GET") parts.push(options.method);
  parts.push(quoteFlagValue(options.path));
  if (options.resource !== "arm") parts.push(formatFlagValue("resource", options.resource));
  if (options.apiVersion) parts.push(formatFlagValue("api-version", options.apiVersion));
  if (options.query) parts.push(formatFlagValue("query", options.query));
  if (options.body) parts.push(formatFlagValue("body", options.body));
  parts.push("--all");
  return `More pages exist: re-run with --all (up to ${MAX_PAGES} pages): \`${parts.join(" ")}\``;
}

function parseQueryString(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const text = raw.startsWith("?") ? raw.slice(1) : raw;
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  if (Object.keys(out).length === 0 && text.trim() !== "") {
    throw new AxiError(`invalid --query '${raw}'`, "VALIDATION_ERROR", ["Example: --query 'k=v&k2=v2'"]);
  }
  return out;
}

function truncateDeep(value: unknown, full: boolean): unknown {
  if (typeof value === "string") return full ? value : truncate(value, STRING_TRUNCATE).text;
  if (Array.isArray(value)) return value.map((item) => truncateDeep(item, full));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = truncateDeep(child, full);
    return out;
  }
  return value;
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, KNOWN_FLAGS, "api");

  let method = "GET";
  let path: string | undefined;
  const upper0 = args.positionals[0]?.toUpperCase();
  if (upper0 && (METHODS as readonly string[]).includes(upper0)) {
    method = upper0;
    path = args.positionals[1];
    if (!path) {
      throw new AxiError(`missing path for \`api ${method}\``, "VALIDATION_ERROR", [
        "Example: `az-axi api GET /subscriptions --api-version 2022-12-01`",
        "Or: `az-axi api /subscriptions --api-version 2022-12-01`",
      ]);
    }
    if (args.positionals.length > 2) {
      throw new AxiError(`unexpected argument \`${args.positionals[2]}\` for \`api\``, "VALIDATION_ERROR", [
        "Pass one method and one path",
      ]);
    }
  } else {
    path = args.positionals[0];
    if (!path) {
      throw new AxiError("missing path for `api`", "VALIDATION_ERROR", [
        "Example: `az-axi api /subscriptions --api-version 2022-12-01`",
        "Example: `az-axi api POST /providers/Microsoft.ResourceGraph/resources --api-version 2024-04-01 --body '{\"query\":\"Resources | take 1\"}'`",
      ]);
    }
    if (args.positionals.length > 1) {
      throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`api\``, "VALIDATION_ERROR", [
        "Pass an optional method before the path: `az-axi api GET <path>`",
      ]);
    }
  }

  const resource = (flagString(args, "resource") ?? "arm") as Resource;
  if (resource !== "arm" && resource !== "logs" && resource !== "graph") {
    throw new AxiError(`--resource must be arm, logs or graph, got '${resource}'`, "VALIDATION_ERROR", [
      "Example: --resource arm",
    ]);
  }
  const apiVersion = flagString(args, "api-version");
  const query = parseQueryString(flagString(args, "query"));
  const rawFlag = flagBool(args, "raw");
  const all = flagBool(args, "all");
  const full = flagBool(args, "full");
  const fields = flagList(args, "fields");
  const limit = flagNumber(args, "limit");
  if (limit !== undefined && !(limit > 0)) {
    throw new AxiError("flag --limit must be greater than 0", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }

  let body: unknown;
  const bodyRaw = flagString(args, "body");
  if (bodyRaw !== undefined) {
    try {
      body = JSON.parse(bodyRaw);
    } catch {
      throw new AxiError("flag --body must be valid JSON", "VALIDATION_ERROR", [
        "Example: --body '{\"query\":\"Resources | take 1\"}'",
      ]);
    }
  }

  const profile = profileFromArgs(args);
  const execute = flagBool(args, "execute");
  const confirm = flagString(args, "confirm") || undefined;
  const ifMatch = flagText(args, "if-match");
  const timeoutMs = parseTimeoutFlag(flagText(args, "timeout"));
  const noWait = flagBool(args, "no-wait");
  const selectors = ["profile", "tenant", "subscription", "management-group", "config"]
    .map((name) => {
      const value = flagString(args, name);
      return value === undefined ? undefined : formatFlagValue(name, value);
    })
    .filter((part): part is string => part !== undefined)
    .join(" ");

  // Every request is classified and gated here; the command never decides itself.
  const url = new URL(buildUrl({ resource, path: path as string, query, apiVersion }));
  const shape = { resource, method, path: url.pathname };
  const cls = classifyRequest(shape);
  assertReadOnlyBoundary(shape, cls);
  if (cls === "write" || cls === "destructive") {
    if (enforceGates(profile, shape, cls, { execute, confirm })) {
      return executeWrite({ profile, method, path: url.toString(), cls, body, ifMatch, confirm,
        selectors, timeoutMs, noWait });
    }
    return dryRun({
      profile,
      resource,
      method,
      path: `${url.pathname}${url.search}`,
      cls,
      body,
      bodyRaw,
      apiVersion,
      query,
      queryRaw: flagString(args, "query"),
      selectors: selectors === "" ? undefined : selectors,
      full,
      ifMatch,
    });
  }

  const first = await sendRequest<unknown>(profile, {
    method,
    resource,
    path,
    query,
    body,
    apiVersion,
    raw: rawFlag,
  });

  if (rawFlag || typeof first.body === "string") {
    const text = typeof first.body === "string" ? first.body : JSON.stringify(first.body);
    return {
      status: first.status,
      body: full ? text : truncate(text ?? "", STRING_TRUNCATE).text,
    };
  }

  const asRecord =
    first.body !== null && typeof first.body === "object" && Object.getPrototypeOf(first.body) === Object.prototype
      ? (first.body as Record<string, unknown>)
      : undefined;
  const value = asRecord?.["value"];

  if (!Array.isArray(value)) {
    return {
      status: first.status,
      ...(asRecord ? (truncateDeep(asRecord, full) as Record<string, unknown>) : { body: first.body }),
    };
  }

  let rows: unknown[] = [...value];
  let nextLink: string | undefined =
    typeof asRecord?.["nextLink"] === "string" ? (asRecord?.["nextLink"] as string) : undefined;
  if (all && nextLink) {
    for (let page = 1; page < MAX_PAGES && nextLink; page++) {
      const link: string = nextLink;
      const pageBody = await sendRequest<{ value?: unknown[]; nextLink?: string }>(profile, {
        method: "GET",
        resource,
        path: link,
      });
      rows.push(...(pageBody.body?.value ?? []));
      nextLink = pageBody.body?.nextLink;
    }
  }

  const capped = limit !== undefined ? rows.slice(0, limit) : rows;
  const shaped = full ? capped : (truncateDeep(capped, false) as unknown[]);
  const picked = Array.isArray(shaped) && shaped.every((row) => row !== null && typeof row === "object")
    ? pickFields(shaped as Array<Record<string, unknown>>, fields)
    : shaped;

  const help: string[] = [];
  if (nextLink && !all) {
    help.push(
      morePagesHint({
        method,
        path: path as string,
        resource,
        apiVersion,
        query: flagString(args, "query"),
        body: bodyRaw,
      }),
    );
  } else if (nextLink) {
    help.push("More pages exist but paging stopped at the page cap");
  }

  const count = nextLink
    ? picked.length < rows.length
      ? `${picked.length} of ${rows.length}+ items`
      : `${picked.length}+ items`
    : countLine(picked.length, rows.length, "items");

  return {
    status: first.status,
    count,
    value: picked,
    ...(help.length > 0 ? { help } : {}),
  };
}
