import { AxiError } from "axi-sdk-js";
import { redact } from "./redact.js";
import type { RequestClass } from "./policy.js";

/**
 * What a command may do to Azure (PLAN.md Section 6.13.9). `config init` writes a
 * local file only, which is not an Azure effect, so it is still `read`.
 */
export type Effect = "read" | "write" | "destructive" | "dynamic";

/** Coverage describes an exact leaf, never a promise about an entire Azure service. */
export const CAPABILITIES = {
  native: "Implemented by an az-axi handler",
  "api-only": "Available only through a reviewed raw API operation, without a native leaf",
  blocked: "Intentionally refused by safety policy",
  unsupported: "No supported implementation or reviewed API coverage",
} as const;
export type Capability = keyof typeof CAPABILITIES;

export interface CommandLeaf {
  path: string;
  effect: Effect;
  capability: Capability;
}

/** Current executable leaves. API methods are arguments of the dynamic `api` leaf. */
export const COMMAND_LEAVES = [
  { path: "home", effect: "read", capability: "native" },
  { path: "doctor", effect: "read", capability: "native" },
  { path: "config init", effect: "read", capability: "native" },
  { path: "config list", effect: "read", capability: "native" },
  { path: "config path", effect: "read", capability: "native" },
  { path: "sub list", effect: "read", capability: "native" },
  { path: "rg query", effect: "read", capability: "native" },
  { path: "rbac list", effect: "read", capability: "native" },
  { path: "activity list", effect: "read", capability: "native" },
  { path: "defender alerts", effect: "read", capability: "native" },
  { path: "defender alerts get", effect: "read", capability: "native" },
  { path: "defender assessments", effect: "read", capability: "native" },
  { path: "defender score", effect: "read", capability: "native" },
  { path: "exposure", effect: "read", capability: "native" },
  { path: "logs query", effect: "read", capability: "native" },
  { path: "api", effect: "dynamic", capability: "native" },
  { path: "op status", effect: "read", capability: "native" },
] as const satisfies readonly CommandLeaf[];

type GroupOf<Path extends string> = Path extends `${infer Group} ${string}` ? Group : Path;
type CommandName = GroupOf<(typeof COMMAND_LEAVES)[number]["path"]>;

export function commandMeta(name: string): CommandMeta {
  const leaf = COMMAND_LEAVES.find((leaf) => leaf.path.split(" ")[0] === name);
  if (!leaf) throw new Error(`Missing command metadata for ${name}`);
  return { name, effect: leaf.effect };
}

export interface CommandMeta {
  name: string;
  effect: Effect;
}

export interface CommandModule {
  meta: CommandMeta;
  run: (args: string[]) => Promise<Record<string, unknown>>;
}

/** Lazy loaders, one per top-level command. Each module exports `meta` and `run`. */
const LOADERS = {
  home: () => import("../commands/home.js"),
  doctor: () => import("../commands/doctor.js"),
  config: () => import("../commands/config.js"),
  sub: () => import("../commands/sub.js"),
  rg: () => import("../commands/rg.js"),
  rbac: () => import("../commands/rbac.js"),
  activity: () => import("../commands/activity.js"),
  defender: () => import("../commands/defender.js"),
  exposure: () => import("../commands/exposure.js"),
  logs: () => import("../commands/logs.js"),
  api: () => import("../commands/api.js"),
  op: () => import("../commands/op.js"),
} satisfies Record<CommandName, () => Promise<CommandModule>>;

let activeEffect: Effect | undefined;

/** Runs a command with its declared effect enforced on every request, and redacts its output. */
export async function runCommand(name: string, args: string[]): Promise<Record<string, unknown>> {
  const load = COMMANDS[name];
  if (!load) throw new AxiError(`unknown command \`${name}\``, "VALIDATION_ERROR", ["Run `az-axi --help` for the full command surface"]);
  const { run } = await load();
  return redact(await runWithEffect(commandMeta(name).effect, () => run(args)));
}

/** Runs `fn` with `effect` enforced on every request it sends through the client. */
export async function runWithEffect<T>(effect: Effect, fn: () => Promise<T>): Promise<T> {
  activeEffect = effect;
  try {
    return await fn();
  } finally {
    activeEffect = undefined;
  }
}

/** Guards against command bugs: a command declared narrower than its requests is refused. */
export function assertEffectAllows(cls: RequestClass): void {
  if (activeEffect === undefined || activeEffect === "dynamic" || activeEffect === "destructive") return;
  if (cls === "read" || cls === "query") return;
  if (activeEffect === "write" && cls === "write") return;
  throw new AxiError(
    `blocked: a command declared '${activeEffect}' issued a '${cls}' request`,
    "READ_ONLY",
    ["This is an az-axi bug: the command's declared effect does not match what it sent"],
  );
}

export const DESCRIPTION =
  "Read-only Azure inspection for agents: resource inventory, RBAC, activity log, Defender for Cloud and Log Analytics";

const HELP_OVERVIEWS = {
  home: "az-axi                                   # dashboard: profile, identity, subscriptions, alerts, score, exposure, writes",
  doctor: "az-axi doctor                            # check az, tokens, ARM reachability and write status per profile",
  config: "az-axi config init|list|path             # manage profiles in ~/.az-axi/config.json",
  sub: "az-axi sub list                          # subscriptions visible to the identity",
  rg: "az-axi rg query \"<kql>\"                  # Resource Graph query across subscriptions",
  rbac: "az-axi rbac list [--privileged]           # role assignments with principal names",
  activity: "az-axi activity list [--since 24h]        # activity log across subscriptions, newest first",
  defender: "az-axi defender alerts|assessments|score  # Defender for Cloud posture",
  exposure: "az-axi exposure [--check all]             # internet-exposed resources",
  logs: "az-axi logs query \"<kql>\" --workspace <alias|guid>  # Log Analytics KQL query",
  api: "az-axi api GET /subscriptions            # escape hatch for any read or query request",
  op: "az-axi op status <operation-url>         # check a long-running operation",
} satisfies Record<CommandName, string>;

const HELP_FOOTER = [
  "",
  "Selector flags on every command: --profile, --tenant, --subscription a,b, --management-group, --config.",
  "Output: TOON on stdout. --full disables truncation, --fields a,b limits list columns, --limit N caps rows.",
  "Read-only by default; $AZ_AXI_READ_ONLY=1 forces read-only for the whole process.",
];

const HELP_TEXT = {
  home: [
    "az-axi                                   # dashboard: profile, identity, subscriptions, alerts, score, exposure, writes",
    "az-axi home                              # same as above",
    "",
    "Selector flags are accepted. No positional arguments. --help prints this reference.",
    "defender is active alerts by severity. score is the average ascScore and the lowest subscription.",
    "exposure is a count per canned check. A failed section degrades to a hint; the rest still render.",
    "Writes report effective status, configured write subscriptions, AZ_AXI_READ_ONLY and the write log path.",
    "Examples: az-axi; az-axi home; az-axi home --help",
  ].join("\n"),
  doctor: [
    "az-axi doctor [--profile <name>] [--config <path>]",
    "",
    "One row per profile: name, auth, identity, type, subscriptions, writes, status, writeSubscriptions.",
    "Write details include configured write subscriptions, AZ_AXI_READ_ONLY and the write log path.",
    "Checks: az installed, signed in, arm/logs/graph tokens (graph is optional), ARM reachability, TLS.",
    "help[] lists every failure with the fix, prefixed by the profile name.",
    "Examples: az-axi doctor; az-axi doctor --profile work",
  ].join("\n"),
  config: [
    "az-axi config init [--name <n>] [--auth az|token] [--tenant <t>] [--management-group <mg>]",
    "                   [--subscription a,b] [--workspace alias=<guid>,...] [--token-env arm=VAR,logs=VAR,graph=VAR] [--default]",
    "az-axi config list                       # profiles with scope, write status and description",
    "az-axi config path                       # the config file in use",
    "",
    "Config file order: --config, $AZ_AXI_CONFIG, ./az-axi.config.json, ~/.az-axi/config.json.",
    "Profile selection: --profile, $AZ_AXI_PROFILE, defaultProfile, the only profile, else an implicit az profile.",
    "Examples: az-axi config init --name work --auth az --tenant <tenant-id>; az-axi config list",
  ].join("\n"),
  sub: [
    "az-axi sub list [--limit 50] [--fields name,id,state,inScope] [--full]",
    "",
    "Subscriptions visible to the identity, with inScope marking the active profile's scope.",
    "Examples: az-axi sub list; az-axi sub list --subscription <id>",
  ].join("\n"),
  rg: [
    'az-axi rg query "<kql>" [--subscription a,b] [--management-group mg] [--limit 50] [--skip-token <t>]',
    "az-axi rg query --file query.kql          # multi-line KQL from a file",
    "cat query.kql | az-axi rg query            # multi-line KQL from stdin",
    "",
    "POST /providers/Microsoft.ResourceGraph/resources (api-version 2024-04-01). The query is sent unchanged.",
    "Scope: --subscription/--management-group flags, then profile managementGroup, then profile subscriptions.",
    "Output: total, count, rows; nested objects are compact JSON truncated at 200 chars unless --full.",
    "When a skip token is returned, help[] has the exact command for the next page.",
    'Examples: az-axi rg query "Resources | take 5"; az-axi rg query "Resources | summarize count() by type"',
  ].join("\n"),
  rbac: [
    "az-axi rbac list [--principal <upn|objectId>] [--role <name>] [--scope <armId>] [--privileged] [--limit 50]",
    "az-axi rbac list --show-query              # print the Resource Graph KQL without running it",
    "",
    "One Resource Graph query over authorizationresources, joined to role definitions (api-version 2024-04-01).",
    "Includes assignments inherited from parent management groups and the tenant root.",
    "--privileged keeps Owner, Contributor, User Access Administrator and RBAC Administrator (by GUID).",
    "--principal, --role, --scope and --privileged are applied in the query, then checked on the rows.",
    "Principal names come from Graph getByIds; if names cannot be resolved, raw object IDs are shown with a hint.",
    "Output: total, count, byRole, rows (principal, type, role, scope, created).",
    "Examples: az-axi rbac list --privileged; az-axi rbac list --principal <upn>",
  ].join("\n"),
  activity: [
    "az-axi activity list [--subscription <id>] [--since 24h] [--caller <upn|appId>]",
    "                     [--resource-group <rg>] [--status Failed] [--operation <text>] [--limit 50]",
    "",
    "Activity log per subscription (api-version 2015-04-01), merged newest first; --since older than 90d is rejected.",
    "Scope: --subscription, else --management-group or the profile scope. Management groups expand to subscriptions.",
    "Server filter: time range plus resourceGroupName. caller is not a legal $filter field, so caller, status and operation filter client-side while paging.",
    "Output: total, count, topCallers, rows (time, caller, operation, status, resource).",
    "Examples: az-axi activity list --since 24h --status Failed",
  ].join("\n"),
  defender: [
    "az-axi defender alerts [--severity High,Medium] [--status Active] [--since 7d] [--limit 50]",
    "az-axi defender alerts get <alert-resource-id>",
    "az-axi defender assessments [--severity High] [--status Unhealthy] [--limit 25]",
    "az-axi defender assessments --resource <name>   # per-resource rows; name matches a path segment, not the recommendation",
    "az-axi defender score",
    "",
    "Alerts come from ARM per subscription (api-version 2022-01-01), newest first.",
    "Default --status is Active. --status all lists every status. Omitting --since lists every retained alert.",
    "Flags that do not apply to the subcommand are rejected. `get` takes the full alert resource ID only.",
    "Assessments and score come from Resource Graph securityresources (api-version 2024-04-01).",
    "Assessments: one row per recommendation (recommendation, severity, unhealthyCount, total), worst severity first.",
    "Score is the ascScore for each subscription (current, max, percent), lowest percent first.",
    "--show-query on assessments prints the exact KQL without running it.",
    "Examples: az-axi defender alerts --severity High; az-axi defender assessments --severity High; az-axi defender score",
  ].join("\n"),
  exposure: [
    "az-axi exposure [--check public-ips|mgmt-ports|any-any|all] [--limit 50]",
    "az-axi exposure --show-query              # print the canned Resource Graph KQL without running it",
    "",
    "Canned Resource Graph queries (api-version 2024-04-01). public-ips is attached addresses only.",
    "mgmt-ports matches ports 22, 3389, 5985 and 5986 exactly, including ranges. any-any is any source to any port.",
    "Default --check all returns per-check counts plus the first 10 rows of each. --limit changes that cap.",
    "A failed check degrades to a hint; the others still render.",
    "Output: total, count, checks{<check>: count plus rows (resource, resourceGroup, subscription, detail)}.",
    "Examples: az-axi exposure; az-axi exposure --check mgmt-ports",
  ].join("\n"),
  logs: [
    "az-axi logs query \"<kql>\" --workspace <alias|guid> [--timespan P1D] [--limit 50]",
    "az-axi logs query --file hunt.kql --workspace sentinel",
    "cat hunt.kql | az-axi logs query --workspace sentinel   # multi-line KQL from stdin",
    "",
    "POST /v1/workspaces/{id}/query on api.loganalytics.io. Surrounding query whitespace is trimmed; no row limits or time filters are added to the KQL.",
    "--workspace takes an alias from the profile or the workspace ID GUID; ARM resource IDs are rejected with the rg query that finds the GUID.",
    "--timespan defaults to P1D and intersects any time filter in the query. It accepts 30m, 24h, 7d, an ISO 8601 duration, an ISO date (from that instant until now), or a start/end interval.",
    "Output: total, count, rows from the first table; otherTables lists only names and row counts for extra tables.",
    "--limit caps displayed rows client-side (default 50), including with --full; capped results hint at '| take' or '| summarize'.",
    "Strings and compact JSON cells truncate at 200 chars unless --full. Datetimes and resource IDs are not shortened.",
    "Partial errors (HTTP 200 with an error object) return a warning instead of failing.",
    "Examples: az-axi logs query \"SigninLogs | take 5\" --workspace sentinel",
  ].join("\n"),
  api: [
    "az-axi api [GET|POST|PUT|PATCH|DELETE] <path> [--resource arm|logs|graph] [--api-version <v>]",
    "         [--query 'k=v&k2=v2'] [--body '<json>'] [--raw] [--all] [--execute] [--confirm <name>] [--if-match <etag>] [--timeout <seconds>] [--no-wait]",
    "az-axi api /subscriptions --api-version 2022-12-01",
    "",
    "Escape hatch for any read or query request. Paths are relative to the host root.",
    "--api-version is required for arm when the path has no api-version query parameter.",
    "Lists with a value[] array return count plus value; --all follows ARM nextLink (up to 10 pages).",
    "Strings truncate at 4,000 chars unless --full.",
    "Writes and destructive requests return a dry-run preview using reads or a deployment what-if query.",
    "See README.md#writes for access, preview output and execution behavior.",
    "Destructive execution needs --confirm <resource-name>.",
    "--execute re-checks current state before sending; --if-match protects the reviewed ETag.",
    "Async writes poll for up to --timeout seconds (default 600); --no-wait returns an op status command.",
    "Examples: az-axi api /subscriptions --api-version 2022-12-01",
  ].join("\n"),
  op: [
    "az-axi op status <operation-url>",
    "",
    "One read-only GET of a long-running operation URL on management.azure.com; anything else is rejected.",
    "Reports the operation state (InProgress, Succeeded, Failed, Canceled) with the error when it failed.",
    "A still-running operation hints the exact command to re-run. Get the URL from a 201/202 write response.",
    "Examples: az-axi op status 'https://management.azure.com/<operation-path>?api-version=<v>'",
  ].join("\n"),
} satisfies Record<CommandName, string>;

const commandNames = [...new Set(COMMAND_LEAVES.map((leaf) => leaf.path.split(" ")[0] as CommandName))];

/** Keep legacy group dispatch and group help, deriving their surface from exact leaves. */
export const COMMANDS: Record<string, () => Promise<CommandModule>> = Object.assign(
  Object.create(null),
  Object.fromEntries(commandNames.map((name) => [name, LOADERS[name]])),
);

export const COMMAND_HELP: Record<string, string> = Object.assign(
  Object.create(null),
  Object.fromEntries(commandNames.map((name) => [name, HELP_TEXT[name]])),
);

export const TOP_LEVEL_HELP = [...commandNames.map((name) => HELP_OVERVIEWS[name]), ...HELP_FOOTER].join("\n");

/** Static agent command list, checked against the committed skill by the offline suite. */
export function commandListMarkdown(): string {
  return [
    "| Command | Capability | Azure effect |",
    "|---|---|---|",
    ...COMMAND_LEAVES.map((leaf) => `| \`az-axi ${leaf.path}\` | ${leaf.capability} | ${leaf.effect} |`),
  ].join("\n");
}
