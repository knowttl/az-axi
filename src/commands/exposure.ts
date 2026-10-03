import { AxiError } from "axi-sdk-js";
import { RESOURCE_GRAPH_RESOURCES } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagText, parseArgs } from "../lib/args.js";
import { sendRequest } from "../lib/client.js";
import { graphScope, profileFromArgs, scopeFlags } from "../lib/context.js";
import { countLine, emptyState, pickFields, truncate } from "../lib/format.js";
import {
  EXPOSURE_CHECKS,
  exposureQuery,
  type ExposureCheck,
} from "../lib/queries.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { shortenResourceId, subscriptionNameMap } from "../lib/scope.js";
import type { ResolvedProfile } from "../lib/config.js";

export const meta = commandMeta("exposure");

const KNOWN_FLAGS = commandFlags("exposure");
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const FETCH_TOP = 1000;
const ALL_CHECK_ROWS = 10;
const CELL_TRUNCATE = 200;

const CHECK_LABEL: Record<ExposureCheck, string> = {
  "public-ips": "public IP addresses",
  "mgmt-ports": "open management ports",
  "any-any": "any-any NSG rules",
};

interface ExposureRow {
  resource?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  detail?: string;
  id?: string;
}

interface ResourceGraphResponse {
  totalRecords?: number;
  count?: number;
  data?: ExposureRow[];
  $skipToken?: string;
  resultTruncated?: string | boolean;
}

const EMBEDDED_ARM_ID = /\/subscriptions\/[^\s,]+/gi;

function formatCell(value: unknown, full: boolean): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return full ? value : truncate(value, CELL_TRUNCATE).text;
  return value;
}

function shortenDetail(detail: string, full: boolean, names?: Map<string, string>): string {
  if (full) return detail;
  return detail.replace(EMBEDDED_ARM_ID, (id) => shortenResourceId(id, names));
}

async function runCheck(
  profile: ResolvedProfile,
  check: ExposureCheck,
  subscriptions: string[] | undefined,
  managementGroups: string[] | undefined,
): Promise<{ rows: ExposureRow[]; total?: number; incomplete: boolean }> {
  const response = await sendRequest<ResourceGraphResponse>(profile, {
    method: "POST",
    path: "/providers/Microsoft.ResourceGraph/resources",
    apiVersion: RESOURCE_GRAPH_RESOURCES,
    body: {
      query: exposureQuery(check),
      ...(subscriptions ? { subscriptions } : {}),
      ...(managementGroups ? { managementGroups } : {}),
      options: { $top: FETCH_TOP, resultFormat: "objectArray" },
    },
  });
  const body = response.body ?? {};
  const rows = body.data ?? [];
  const total = typeof body.totalRecords === "number" ? body.totalRecords : (body.count ?? rows.length);
  const incomplete = Boolean(body.$skipToken) || body.resultTruncated === true || body.resultTruncated === "true";
  return { rows, total, incomplete };
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, KNOWN_FLAGS, "exposure");
  if (args.positionals.length > 0) {
    throw new AxiError(`unexpected argument \`${args.positionals[0]}\` for \`exposure\``, "VALIDATION_ERROR", [
      "Run `az-axi exposure --check public-ips|mgmt-ports|any-any|all`",
    ]);
  }

  const profile = profileFromArgs(args);
  if (args.flags["limit"] === true || args.flags["limit"] === "") {
    throw new AxiError("flag --limit needs a number", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  const full = flagBool(args, "full");
  const limit = full ? Number.POSITIVE_INFINITY : (flagNumber(args, "limit") ?? DEFAULT_LIMIT);
  if (!(limit > 0)) {
    throw new AxiError("flag --limit must be greater than 0", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  if (limit !== Number.POSITIVE_INFINITY && limit > MAX_LIMIT) {
    throw new AxiError(`flag --limit must be at most ${MAX_LIMIT}`, "VALIDATION_ERROR", [
      `Example: --limit ${MAX_LIMIT}`,
    ]);
  }
  const fields = flagList(args, "fields");
  const checkRaw = flagText(args, "check") ?? "all";
  if (checkRaw !== "all" && !(EXPOSURE_CHECKS as readonly string[]).includes(checkRaw)) {
    throw new AxiError(`--check must be ${[...EXPOSURE_CHECKS, "all"].join("|")}, got '${checkRaw}'`, "VALIDATION_ERROR", [
      "Example: --check mgmt-ports",
    ]);
  }

  const scope = graphScope(profile, args);
  const suffix = scopeFlags(args);
  const subscriptions = scope.subscriptions;
  const managementGroups = scope.managementGroups;
  const scopeLabel = scope.label;

  if (flagBool(args, "show-query")) {
    const checks = checkRaw === "all" ? [...EXPOSURE_CHECKS] : [checkRaw as ExposureCheck];
    return {
      profile: profile.name,
      checks: Object.fromEntries(checks.map((check) => [check, exposureQuery(check)])),
      help: [`Run \`az-axi exposure --check ${checkRaw === "all" ? "mgmt-ports" : checkRaw}${suffix}\` to execute one check`],
    };
  }

  const names = full ? undefined : await subscriptionNameMap(profile).catch(() => undefined);
  const formatRows = (rows: ExposureRow[]) =>
    rows.map((row) => ({
      resource: formatCell(row.resource ?? "", full),
      resourceGroup: formatCell(row.resourceGroup ?? "", full),
      subscription: formatCell(
        full ? (row.subscriptionId ?? "") : (names?.get((row.subscriptionId ?? "").toLowerCase()) ?? row.subscriptionId ?? ""),
        full,
      ),
      detail: formatCell(shortenDetail(row.detail ?? "", full, names), full),
    }));

  if (checkRaw !== "all") {
    const check = checkRaw as ExposureCheck;
    const fetched = await runCheck(profile, check, subscriptions, managementGroups);
    if (fetched.rows.length === 0) {
      return {
        profile: profile.name,
        check,
        total: 0,
        count: countLine(0, 0, CHECK_LABEL[check]),
        rows: emptyState(CHECK_LABEL[check], scopeLabel),
        help: [`Run \`az-axi exposure --check all${suffix}\` for every check ${scopeLabel}`],
      };
    }
    const shown = full ? fetched.rows : fetched.rows.slice(0, limit);
    const picked = fields ? pickFields(formatRows(shown), fields) : formatRows(shown);
    const help: string[] = [];
    if (fetched.incomplete) help.push("Resource Graph truncated this check; narrow the scope with --subscription");
    else if (!full && (fetched.rows.length > shown.length || (fetched.total ?? 0) > shown.length)) {
      const nextLimit = Math.min(MAX_LIMIT, Math.max(fetched.rows.length, fetched.total ?? 0));
      help.push(`More rows exist: re-run with --limit ${nextLimit}${suffix}`);
    }
    return {
      profile: profile.name,
      check,
      total: fetched.total,
      count: countLine(shown.length, fetched.total, CHECK_LABEL[check]),
      rows: picked,
      ...(help.length > 0 ? { help } : {}),
    };
  }

  const perCheck = full ? Number.POSITIVE_INFINITY : (flagNumber(args, "limit") ?? ALL_CHECK_ROWS);
  const sections: Record<string, unknown> = {};
  let grandTotal = 0;
  let failedChecks = 0;
  const help: string[] = [];
  for (const check of EXPOSURE_CHECKS) {
    try {
      const fetched = await runCheck(profile, check, subscriptions, managementGroups);
      grandTotal += fetched.total ?? 0;
      const shown = fetched.rows.slice(0, perCheck);
      const formatted = fields ? pickFields(formatRows(shown), fields) : formatRows(shown);
      sections[check] = {
        total: fetched.total,
        count: countLine(shown.length, fetched.total, CHECK_LABEL[check]),
        rows: shown.length === 0 ? emptyState(CHECK_LABEL[check], scopeLabel) : formatted,
      };
      if (fetched.incomplete) help.push(`[${check}] Resource Graph truncated this check; narrow the scope with --subscription`);
    } catch (err) {
      failedChecks++;
      const message = err instanceof Error ? err.message : String(err);
      sections[check] = { total: "-", rows: `could not run this check: ${message}` };
      help.push(`[${check}] ${message}`);
    }
  }
  help.push(`Run \`az-axi exposure --check mgmt-ports${suffix}\` for the full rows of one check`);
  const failedNote = failedChecks > 0 ? ` (${failedChecks} check${failedChecks === 1 ? "" : "s"} failed)` : "";

  return {
    profile: profile.name,
    total: grandTotal,
    count: `${grandTotal} exposures ${scopeLabel}${failedNote}`,
    checks: sections,
    ...(help.length > 0 ? { help: help.slice(0, 4) } : {}),
  };
}
