import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { RESOURCE_GRAPH_RESOURCES } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { sendRequest } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { countLine, emptyState, pickFields, truncate } from "../lib/format.js";
import { shortenResourceId, subscriptionNameMap } from "../lib/scope.js";
import { readStdinIfPiped } from "../lib/stdin.js";
import { commandFlags, commandMeta } from "../lib/registry.js";

export const meta = commandMeta("rg");

const SUBCOMMANDS = ["query"] as const;
const KNOWN_FLAGS = commandFlags("rg query");
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const CELL_TRUNCATE = 200;

interface ResourceGraphResponse {
  totalRecords?: number;
  count?: number;
  data?: Array<Record<string, unknown>>;
  $skipToken?: string;
  resultTruncated?: string;
}

function shellDoubleQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

function nextPageCommand(options: {
  query: string;
  file?: string;
  subscriptions?: string[];
  managementGroup?: string;
  managementGroups?: string[];
  limit?: number;
  fields?: string[];
  full: boolean;
  skipToken: string;
}): string {
  const parts = ["az-axi rg query"];
  if (options.file) {
    parts.push(`--file ${options.file.includes(" ") ? shellDoubleQuoted(options.file) : options.file}`);
  } else {
    parts.push(shellDoubleQuoted(options.query));
  }
  if (options.subscriptions?.length) parts.push(`--subscription ${options.subscriptions.join(",")}`);
  if (options.managementGroup) parts.push(`--management-group ${options.managementGroup}`);
  if (options.managementGroups) {
    parts[0] = "az-axi graph query";
    if (!options.file) parts[1] = `--graph-query ${shellDoubleQuoted(options.query)}`;
  }
  if (options.managementGroups) parts.push(`--management-groups ${options.managementGroups.join(",")}`);
  if (options.limit !== undefined && options.limit !== DEFAULT_LIMIT) parts.push(`--limit ${options.limit}`);
  if (options.fields?.length) parts.push(`--fields ${options.fields.join(",")}`);
  if (options.full) parts.push("--full");
  const token = options.skipToken.includes(" ") || /["$`\\]/.test(options.skipToken)
    ? shellDoubleQuoted(options.skipToken)
    : options.skipToken;
  parts.push(`--skip-token ${token}`);
  return `Run \`${parts.join(" ")}\` for the next page`;
}

function formatCell(value: unknown, full: boolean): unknown {
  if (value === null || value === undefined) return value ?? "";
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return full ? text : truncate(text, CELL_TRUNCATE).text;
  }
  if (typeof value === "string") {
    return full ? value : truncate(value, CELL_TRUNCATE).text;
  }
  return value;
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  subcommandOf(args, SUBCOMMANDS, "rg");
  assertKnownFlags(args, KNOWN_FLAGS, "rg query");
  if (args.positionals.length > 2) {
    throw new AxiError(`unexpected argument \`${args.positionals[2]}\` for \`rg query\``, "VALIDATION_ERROR", [
      "Quote multi-word KQL: `az-axi rg query \"Resources | take 5\"`",
      "Or put multi-line KQL in a file: `az-axi rg query --file query.kql`",
    ]);
  }

  const profile = profileFromArgs(args);
  const full = flagBool(args, "full");
  const limit = full ? Number.POSITIVE_INFINITY : (flagNumber(args, "limit") ?? DEFAULT_LIMIT);
  if (!(limit > 0)) {
    throw new AxiError("flag --limit must be greater than 0", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  if (limit !== Number.POSITIVE_INFINITY && limit > MAX_LIMIT) {
    throw new AxiError(`flag --limit must be at most ${MAX_LIMIT}`, "VALIDATION_ERROR", [
      `Example: --limit ${MAX_LIMIT}`,
      "Page through larger sets with --skip-token",
    ]);
  }
  const fields = flagList(args, "fields");
  const skipToken = flagString(args, "skip-token");
  const file = flagString(args, "file");

  const positionalQuery = args.positionals.slice(1).join(" ").trim();
  let query: string;
  if (file) {
    if (positionalQuery) {
      throw new AxiError("pass either a query or --file, not both", "VALIDATION_ERROR", [
        "Example: `az-axi rg query --file query.kql`",
      ]);
    }
    try {
      query = readFileSync(file, "utf8").trim();
    } catch (err) {
      throw new AxiError(`cannot read query file '${file}': ${(err as Error).message}`, "VALIDATION_ERROR", [
        "Check the file path",
        "Or pipe the query: `cat query.kql | az-axi rg query`",
      ]);
    }
    if (!query) {
      throw new AxiError(`query file '${file}' is empty`, "VALIDATION_ERROR", [
        "Put KQL in the file, for example `Resources | take 5`",
      ]);
    }
  } else if (positionalQuery) {
    query = positionalQuery;
  } else {
    const piped = await readStdinIfPiped();
    const text = piped?.toString("utf8").trim();
    if (!text) {
      throw new AxiError("missing query for `rg query`", "VALIDATION_ERROR", [
        'Example: `az-axi rg query "Resources | take 5"`',
        "Or: `az-axi rg query --file query.kql`",
        "Or: `cat query.kql | az-axi rg query`",
      ]);
    }
    query = text;
  }

  const flagSubs = flagList(args, "subscription");
  const flagMg = flagString(args, "management-group");
  let subscriptions: string[] | undefined;
  let managementGroups: string[] | undefined;
  const pluralMg = flagList(args, "management-groups");
  if (pluralMg?.length) managementGroups = pluralMg;
  else if (flagMg) managementGroups = [flagMg];
  else if (flagSubs?.length) subscriptions = flagSubs;
  else if (profile.managementGroup) managementGroups = [profile.managementGroup];
  else if (profile.subscriptions?.length) subscriptions = profile.subscriptions;

  const top = limit === Number.POSITIVE_INFINITY ? MAX_LIMIT : limit;
  const response = await sendRequest<ResourceGraphResponse>(profile, {
    method: "POST",
    path: "/providers/Microsoft.ResourceGraph/resources",
    apiVersion: RESOURCE_GRAPH_RESOURCES,
    body: {
      query,
      ...(subscriptions ? { subscriptions } : {}),
      ...(managementGroups ? { managementGroups } : {}),
      options: {
        $top: top,
        ...(skipToken ? { $skipToken: skipToken } : {}),
        resultFormat: "objectArray",
      },
    },
  });

  const body = response.body ?? {};
  const rows = body.data ?? [];
  const total = body.totalRecords ?? body.count ?? rows.length;
  const scopeHint = managementGroups?.length
    ? `in management group${managementGroups.length > 1 ? "s" : ""} ${managementGroups.join(",")}`
    : subscriptions?.length
      ? `for ${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"}`
      : "across accessible subscriptions";

  if (rows.length === 0) {
    return {
      profile: profile.name,
      total,
      count: countLine(0, total, "resources"),
      rows: emptyState("resources", scopeHint),
      help: [
        "Run `az-axi sub list` to verify the subscriptions in scope",
        'Try a broader query: `az-axi rg query "Resources | take 5"`',
      ],
    };
  }

  const showFullId = full || fields?.includes("id");
  let names: Map<string, string> | undefined;
  if (!showFullId && rows.some((row) => typeof row["id"] === "string" && (row["id"] as string).startsWith("/"))) {
    names = await subscriptionNameMap(profile);
  }

  const formatted = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "id" && typeof value === "string" && !showFullId) {
        out[key] = formatCell(shortenResourceId(value, names), full);
      } else {
        out[key] = formatCell(value, full);
      }
    }
    return out;
  });
  const shown = (full ? formatted : formatted.slice(0, limit)).slice(0, MAX_LIMIT);
  const picked = pickFields(shown, fields);

  const help: string[] = [];
  const quotaRemaining = response.headers["x-ms-user-quota-remaining"];
  const quotaReset = response.headers["x-ms-user-quota-resets-after"];
  if (quotaRemaining === "0") {
    help.push(
      quotaReset
        ? `Resource Graph quota exhausted; resets after ${quotaReset}`
        : "Resource Graph quota exhausted; retry after a few seconds",
    );
  }
  if (body.resultTruncated === "true" && !body.$skipToken) {
    help.push("Resource Graph truncated this result; narrow the query or project fewer columns");
  }
  if (body.$skipToken) {
    help.push(
      nextPageCommand({
        query,
        file,
        subscriptions: flagSubs ?? subscriptions,
        managementGroup: pluralMg ? undefined : flagMg ?? managementGroups?.[0],
        managementGroups: pluralMg,
        limit: full ? undefined : (flagNumber(args, "limit") ?? (skipToken ? undefined : DEFAULT_LIMIT)),
        fields,
        full,
        skipToken: body.$skipToken,
      }),
    );
  } else if (quotaRemaining !== "0" && total > shown.length) {
    help.push("More rows exist: raise --limit (up to 1000) or narrow the query with filters");
  }

  return {
    profile: profile.name,
    total,
    count: countLine(shown.length, total, "resources"),
    rows: picked,
    ...(help.length > 0 ? { help } : {}),
  };
}
