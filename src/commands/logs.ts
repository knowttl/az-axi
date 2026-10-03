import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { LOG_ANALYTICS_QUERY } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, flagText, parseArgs } from "../lib/args.js";
import { sendRequest } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { countLine, emptyState, pickFields, truncate } from "../lib/format.js";
import { convertKustoTables, partialErrorText, type KustoResponse } from "../lib/kusto.js";
import { workspaceCustomerIdCommand } from "../lib/queries.js";
import { readStdinIfPiped } from "../lib/stdin.js";
import { normalizeTimespan } from "../lib/time.js";
import { commandMeta } from "../lib/registry.js";

export const meta = commandMeta("logs");

const SUBCOMMANDS = ["query"] as const;
const KNOWN_FLAGS = ["workspace", "timespan", "file"] as const;
const DEFAULT_LIMIT = 50;
const CELL_TRUNCATE = 200;
const DEFAULT_TIMESPAN = "P1D";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARM_ID = /(^\/subscriptions\/)|(\/providers\/)/i;

function isArmId(value: string): boolean {
  const text = value.trim();
  return text.startsWith("/") || ARM_ID.test(text);
}

function canonicalGuid(value: string): string | undefined {
  const text = value.trim().replace(/^\{(.+)\}$/, "$1");
  return GUID.test(text) ? text : undefined;
}

function workspaceHelp(): string[] {
  return [
    "Pass --workspace <alias> or --workspace <workspace-id-guid> (the customer ID, not the ARM resource ID)",
    `Find the GUID with \`${workspaceCustomerIdCommand()}\``,
  ];
}

function workspaceEntries(profile: { workspaces?: unknown }): Record<string, unknown> | undefined {
  const raw = profile.workspaces;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/**
 * Alias wins; otherwise the value must be a workspace GUID. The resolved id is
 * checked again so a hand-edited alias cannot put an ARM ID on the request path.
 */
function resolveWorkspaceId(profile: { workspaces?: unknown }, raw: string): { id: string; alias?: string } {
  const text = raw.trim();
  const entries = workspaceEntries(profile);
  if (entries && Object.prototype.hasOwnProperty.call(entries, text)) {
    const mapped = entries[text];
    const id = typeof mapped === "string" ? canonicalGuid(mapped) : undefined;
    if (!id) {
      if (typeof mapped === "string" && isArmId(mapped)) {
        throw new AxiError(
          `workspace alias '${text}' is an ARM resource ID, not the workspace ID GUID`,
          "VALIDATION_ERROR",
          workspaceHelp(),
        );
      }
      throw new AxiError(`workspace alias '${text}' is not a workspace ID GUID`, "VALIDATION_ERROR", [
        "Set the alias to the customer ID GUID, not the ARM resource ID",
        ...workspaceHelp(),
      ]);
    }
    return { id, alias: text };
  }
  const direct = canonicalGuid(text);
  if (direct) return { id: direct };
  if (isArmId(text)) {
    throw new AxiError(
      `--workspace needs the workspace ID GUID (customer ID), not the ARM resource ID '${text}'`,
      "VALIDATION_ERROR",
      workspaceHelp(),
    );
  }
  const aliases = Object.keys(entries ?? {});
  throw new AxiError(`unknown workspace '${text}'`, "VALIDATION_ERROR", [
    ...(aliases.length > 0 ? [`Known aliases: ${aliases.join(", ")}`] : []),
    ...workspaceHelp(),
  ]);
}

function formatCell(value: unknown, full: boolean): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return full ? text : truncate(text, CELL_TRUNCATE).text;
  }
  if (typeof value === "string") return full ? value : truncate(value, CELL_TRUNCATE).text;
  return value;
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  subcommandOf(args, SUBCOMMANDS, "logs");
  assertKnownFlags(args, KNOWN_FLAGS, "logs query");
  if (args.positionals.length > 2) {
    throw new AxiError(`unexpected argument \`${args.positionals[2]}\` for \`logs query\``, "VALIDATION_ERROR", [
      'Quote multi-word KQL: `az-axi logs query "SigninLogs | take 5" --workspace <alias>`',
      "Or put multi-line KQL in a file: `az-axi logs query --file hunt.kql --workspace <alias>`",
    ]);
  }

  const profile = profileFromArgs(args);
  const full = flagBool(args, "full");
  if (args.flags["limit"] === true || args.flags["limit"] === "") {
    throw new AxiError("flag --limit needs a number", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  const limit = flagNumber(args, "limit") ?? DEFAULT_LIMIT;
  if (!(limit > 0)) {
    throw new AxiError("flag --limit must be greater than 0", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }
  const fields = flagList(args, "fields");
  if ("file" in args.flags && (args.flags["file"] === true || args.flags["file"] === "")) {
    throw new AxiError("flag --file needs a path", "VALIDATION_ERROR", [
      "Example: --file hunt.kql",
    ]);
  }
  const file = flagString(args, "file");

  const rawWorkspace = flagText(args, "workspace") ?? "";
  if (!rawWorkspace) {
    throw new AxiError("missing --workspace for `logs query`", "VALIDATION_ERROR", workspaceHelp());
  }
  const { id: workspaceId, alias } = resolveWorkspaceId(profile, rawWorkspace);
  const timespan = normalizeTimespan(
    "timespan" in args.flags ? (flagText(args, "timespan") ?? DEFAULT_TIMESPAN) : DEFAULT_TIMESPAN,
  );

  const positionalQuery = args.positionals.slice(1).join(" ").trim();
  let query: string;
  if (file) {
    if (positionalQuery) {
      throw new AxiError("pass either a query or --file, not both", "VALIDATION_ERROR", [
        "Example: `az-axi logs query --file hunt.kql --workspace <alias>`",
      ]);
    }
    try {
      query = readFileSync(file, "utf8").trim();
    } catch (err) {
      throw new AxiError(`cannot read query file '${file}': ${(err as Error).message}`, "VALIDATION_ERROR", [
        "Check the file path",
        "Or pipe the query: `cat hunt.kql | az-axi logs query --workspace <alias>`",
      ]);
    }
    if (!query) {
      throw new AxiError(`query file '${file}' is empty`, "VALIDATION_ERROR", [
        "Put KQL in the file, for example `SigninLogs | take 5`",
      ]);
    }
  } else if (positionalQuery) {
    query = positionalQuery;
  } else {
    const piped = await readStdinIfPiped();
    const text = piped?.toString("utf8").trim();
    if (!text) {
      throw new AxiError("missing query for `logs query`", "VALIDATION_ERROR", [
        'Example: `az-axi logs query "SigninLogs | take 5" --workspace <alias>`',
        "Or: `az-axi logs query --file hunt.kql --workspace <alias>`",
        "Or: `cat hunt.kql | az-axi logs query --workspace <alias>`",
      ]);
    }
    query = text;
  }

  const response = await sendRequest<KustoResponse>(profile, {
    method: "POST",
    resource: "logs",
    path: `/${LOG_ANALYTICS_QUERY}/workspaces/${encodeURIComponent(workspaceId)}/query`,
    body: { query, timespan },
  });

  const body = response.body ?? {};
  const warning = partialErrorText(body.error);
  const converted = convertKustoTables(body.tables, limit);
  const total = converted.total;
  const scopeHint = `in workspace ${alias ?? workspaceId} for ${timespan}`;

  if (total === 0) {
    return {
      profile: profile.name,
      workspace: alias ?? workspaceId,
      workspaceId,
      timespan,
      total: 0,
      count: countLine(0, 0, "rows"),
      rows: emptyState("rows", scopeHint),
      ...(converted.otherTables ? { otherTables: converted.otherTables } : {}),
      ...(warning ? { warning } : {}),
      help: warning
        ? ["Partial results: shorten --timespan or narrow the KQL and retry"]
        : [
            "Widen --timespan (the default P1D intersects any time filter in the query). Example: --timespan P7D",
            `Find workspace IDs with \`${workspaceCustomerIdCommand()}\``,
          ],
    };
  }

  const shown = converted.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = formatCell(value, full);
    return out;
  });
  const picked = pickFields(shown, fields);

  const help: string[] = [];
  if (warning) help.push("Partial results: shorten --timespan or narrow the KQL and retry");
  if (total > shown.length) {
    help.push(
      `Showing ${shown.length} of ${total} rows; add '| take ${shown.length}' or '| summarize ...' to the query to narrow results`,
    );
  }

  return {
    profile: profile.name,
    workspace: alias ?? workspaceId,
    workspaceId,
    timespan,
    total,
    count: countLine(shown.length, total, "rows"),
    rows: picked,
    ...(converted.otherTables ? { otherTables: converted.otherTables } : {}),
    ...(warning ? { warning } : {}),
    ...(help.length > 0 ? { help } : {}),
  };
}
