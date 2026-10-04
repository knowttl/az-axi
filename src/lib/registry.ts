import { AxiError } from "axi-sdk-js";
import { redact } from "./redact.js";
import type { RequestClass } from "./policy.js";
import { GLOBAL_FLAG_SCHEMA, type FlagSchema } from "./args.js";
import { AZ_HELP } from "./azHelp.js";
import { STORAGE_HELP, storageLeafHelp } from "./storageHelp.js";

/**
 * What a command may do to Azure (PLAN.md Section 6.13.9). `config init` writes a
 * local file only, which is not an Azure effect, so it is still `read`.
 */
export type Effect = "read" | "write" | "destructive" | "dynamic";

/** Coverage describes an exact leaf, never a promise about an entire Azure service. */
export const CAPABILITIES = {
  native: "Implemented by an az-axi handler",
  passthrough: "Reviewed read through the pinned Azure CLI runtime",
  "api-only": "Available only through a reviewed raw API operation, without a native leaf",
  blocked: "Intentionally refused by safety policy",
  unsupported: "No supported implementation or reviewed API coverage",
} as const;
export type Capability = keyof typeof CAPABILITIES;

export interface CommandLeaf {
  path: string;
  handlerPath?: string;
  effect: Effect;
  capability: Capability;
  flags?: FlagSchema;
  aliases?: readonly string[];
  aliasFlags?: Readonly<Record<string, string>>;
  canonicalFlags?: FlagSchema;
  canonicalFlagAliases?: Readonly<Record<string, string>>;
  handlerFlags?: FlagSchema;
  positionalInput?: boolean;
}

/** Current executable leaves. API methods are arguments of the dynamic `api` leaf. */
export const COMMAND_LEAVES = [
  { path: "home", effect: "read", capability: "native" },
  { path: "doctor", effect: "read", capability: "native" },
  { path: "config init", effect: "read", capability: "native", flags: { name: "value", auth: "value", workspace: "list", "token-env": "list", default: "boolean" } },
  { path: "config list", effect: "read", capability: "native" },
  { path: "config path", effect: "read", capability: "native" },
  { path: "sub list", effect: "read", capability: "native" },
  { path: "account list", effect: "read", capability: "native" },
  { path: "account show", effect: "read", capability: "native" },
  { path: "monitor log-analytics workspace list", effect: "read", capability: "native", flags: { "resource-group": "value", name: "value" } },
  { path: "monitor log-analytics workspace show", effect: "read", capability: "native", flags: { ids: "value", "resource-group": "value", "workspace-name": "value", name: "value" } },
  { path: "group list", effect: "read", capability: "native" },
  { path: "group show", effect: "read", capability: "native", flags: { name: "value" } },
  { path: "resource list", effect: "read", capability: "native", flags: { "resource-group": "value", name: "value", "resource-type": "value" } },
  { path: "resource show", effect: "read", capability: "native", flags: { ids: "value", name: "value", "resource-group": "value", "resource-type": "value", "api-version": "value" } },
  { path: "graph query", handlerPath: "rg query", aliases: ["rg query"], effect: "read", capability: "native", positionalInput: true, flags: { "skip-token": "value", file: "value" }, canonicalFlags: { "graph-query": "value", subscriptions: "list", "management-groups": "list" }, canonicalFlagAliases: { first: "limit" }, handlerFlags: { "management-groups": "list" } },
  { path: "rbac list", effect: "read", capability: "native", aliases: ["role assignment list"], aliasFlags: { assignee: "principal" }, flags: { principal: "value", role: "value", scope: "value", privileged: "boolean", "show-query": "boolean" } },
  { path: "activity list", effect: "read", capability: "native", aliases: ["monitor activity-log list"], aliasFlags: { offset: "since" }, flags: { since: "value", caller: "value", "resource-group": "value", status: "value", operation: "value" } },
  { path: "defender alerts", effect: "read", capability: "native", aliases: ["security alert list"], flags: { severity: "list", status: "value", since: "value" } },
  { path: "defender alerts get", effect: "read", capability: "native", positionalInput: true },
  { path: "security alert update", effect: "write", capability: "native", aliases: ["defender alerts update"], flags: { location: "value", name: "value", "resource-group": "value", status: "value", execute: "boolean", "if-match": "value", timeout: "value", "no-wait": "boolean" } },
  { path: "defender assessments", effect: "read", capability: "native", flags: { severity: "list", status: "value", resource: "value", "show-query": "boolean" } },
  { path: "defender score", effect: "read", capability: "native", aliases: ["security secure-scores list"] },
  { path: "exposure", effect: "read", capability: "native", flags: { check: "value", "show-query": "boolean" } },
  { path: "monitor log-analytics query", handlerPath: "logs query", aliases: ["logs query"], effect: "read", capability: "native", positionalInput: true, flags: { workspace: "value", timespan: "value", file: "value" }, canonicalFlags: { "analytics-query": "value" } },
  { path: "api", effect: "dynamic", capability: "native", positionalInput: true, flags: { resource: "value", "api-version": "value", query: "value", body: "value", "body-file": "value", raw: "boolean", all: "boolean", execute: "boolean", confirm: "value", "if-match": "value", timeout: "value", "no-wait": "boolean" } },
  { path: "op status", effect: "read", capability: "native", positionalInput: true },
  { path: "az group show", effect: "read", capability: "passthrough", flags: { name: "value", "resource-group": "value" } },
  { path: "storage container list", effect: "read", capability: "native", flags: { "account-name": "value", "auth-mode": "value", prefix: "literal", marker: "literal" } },
  { path: "storage container show", effect: "read", capability: "native", flags: { "account-name": "value", "auth-mode": "value", name: "value" } },
  { path: "storage blob list", effect: "read", capability: "native", flags: { "account-name": "value", "auth-mode": "value", "container-name": "value", prefix: "literal", marker: "literal" } },
  { path: "storage blob show", effect: "read", capability: "native", flags: { "account-name": "value", "auth-mode": "value", "container-name": "value", name: "literal" } },
] as const satisfies readonly CommandLeaf[];

type GroupOf<Path extends string> = Path extends `${infer Group} ${string}` ? Group : Path;
type HandlerPath<Leaf> = Leaf extends { handlerPath: infer Path extends string } ? Path : Leaf extends { path: infer Path extends string } ? Path : never;
type CommandName = GroupOf<HandlerPath<(typeof COMMAND_LEAVES)[number]>>;

export function commandFlags(path: string): string[] {
  const leaf: CommandLeaf | undefined = COMMAND_LEAVES.find((leaf: CommandLeaf) => (leaf.handlerPath ?? leaf.path) === path);
  if (!leaf) throw new Error(`Missing command metadata for ${path}`);
  return Object.keys({ ...leaf.flags, ...leaf.handlerFlags });
}

export function commandMeta(name: string): CommandMeta {
  const leaf = COMMAND_LEAVES.find((leaf: CommandLeaf) => (leaf.handlerPath ?? leaf.path).split(" ")[0] === name);
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
  account: () => import("../commands/account.js"),
  monitor: () => import("../commands/monitor.js"),
  group: () => import("../commands/group.js"),
  resource: () => import("../commands/resource.js"),
  rg: () => import("../commands/rg.js"),
  rbac: () => import("../commands/rbac.js"),
  activity: () => import("../commands/activity.js"),
  defender: () => import("../commands/defender.js"),
  security: () => import("../commands/security.js"),
  exposure: () => import("../commands/exposure.js"),
  logs: () => import("../commands/logs.js"),
  api: () => import("../commands/api.js"),
  op: () => import("../commands/op.js"),
  az: () => import("../commands/az.js"),
  storage: () => import("../commands/storage.js"),
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
  account: "az-axi account list|show                  # live ARM subscriptions in selected scope",
  monitor: "az-axi monitor log-analytics workspace list|show  # workspace metadata, no shared keys",
  group: "az-axi group list|show                    # resource groups in selected subscriptions",
  resource: "az-axi resource list|show                 # ARM resource inventory and detail",
  rg: "az-axi rg query \"<kql>\"                  # Resource Graph query across subscriptions",
  rbac: "az-axi rbac list [--privileged]           # role assignments with principal names",
  activity: "az-axi activity list [--since 24h]        # activity log across subscriptions, newest first",
  defender: "az-axi defender alerts|assessments|score  # Defender for Cloud posture",
  security: "az-axi security alert update             # gated status update for one Defender alert",
  exposure: "az-axi exposure [--check all]             # internet-exposed resources",
  logs: "az-axi logs query \"<kql>\" --workspace <alias|guid>  # Log Analytics KQL query",
  api: "az-axi api GET /subscriptions            # escape hatch for any read or query request",
  op: "az-axi op status <operation-url>         # check a long-running operation",
  az: "az-axi az group show -n <name> --subscription <uuid>  # reviewed Azure CLI read",
  storage: "az-axi storage container|blob list|show   # Entra-only Blob service properties",
} satisfies Record<CommandName, string>;

/** Exact leaf help retains the legacy reference and names the selected route. */
export function leafHelp(leaf: CommandLeaf, path = leaf.path): string {
  if (path.startsWith("storage ")) return storageLeafHelp(path);
  if (leaf.capability === "passthrough") return AZ_HELP;
  const group = (leaf.handlerPath ?? leaf.path).split(" ")[0] as CommandName;
  const canonical = path === leaf.path && leaf.handlerPath !== undefined;
  const flags = Object.keys({ ...GLOBAL_FLAG_SCHEMA, ...leaf.flags, ...(canonical ? leaf.canonicalFlags : {}) });
  return [
    `Command: az-axi ${path}`,
    `Native operation: az-axi ${leaf.handlerPath ?? leaf.path}; existing scope, defaults and TOON output apply.`,
    `Flags: ${[...flags, ...Object.keys(canonical ? leaf.canonicalFlagAliases ?? {} : {})].map((name) => `--${name}`).join(", ")}`,
    "Short flags where accepted: -h help, -s subscription, -g resource-group, -n name, -w workspace, -t timespan.",
    leaf.positionalInput && !canonical ? "Lists accept comma-separated and repeated values; each flag consumes one token to preserve positional input." : "Lists accept comma-separated, space-separated and repeated values after the leaf path.",
    "Booleans accept bare flags or true/false. Conflicting scalar values are refused.",
    ...(path === "role assignment list" ? ["--assignee aliases --principal; inherited assignments are always included."] : []),
    ...(path === "monitor activity-log list" ? ["--offset aliases --since (default 24h)."] : []),
    "",
    LEAF_HELP[leaf.handlerPath ? path : leaf.path] ?? HELP_TEXT[group],
  ].join("\n");
}

export const ALERT_UPDATE_HELP = [
  "az-axi security alert update --subscription <id> --location <location> --name <alert-name> --status dismiss|resolve|activate [--resource-group <name>]",
  "Legacy alias: az-axi defender alerts update (same flags). One alert and one subscription only; no positional IDs or batches.",
  "--subscription / -s requires a single explicit subscription ID; names and implicit env/profile scope are not accepted.",
  "--location / -l and --name / -n are required; --resource-group / -g is optional (default subscription scope).",
  "Writes require the existing profile permission and subscription allowlist. Default: dry run with current/desired status; --execute sends one bodyless ARM POST.",
  "Already in the desired status: no-op. --if-match is forwarded if supplied, but this API does not document ETag/If-Match protection; it is not a concurrency guarantee.",
  "--timeout defaults to 600 seconds; --no-wait defaults to false. The shared write log, LRO handling and approval hook apply.",
  "Examples: az-axi security alert update -s <id> -l westeurope -n example-alert --status dismiss",
  "az-axi security alert update -s <id> -g example-rg -l westeurope -n example-alert --status resolve --execute",
].join("\n");

const LEAF_HELP: Record<string, string> = {
  "account list": "Lists live ARM subscriptions in selected scope (flags, environment, profile, else all accessible), resolving unambiguous names to IDs. This is not Azure CLI's cached account list. Legacy sub list still lists all visible subscriptions with inScope markers.\nDefault: name, id (subscription GUID), state, tenantId. --full adds ARM metadata and shows all fetched rows; --fields selects metadata. --limit defaults to 50. Paging stops at 100 pages with lower-bound counts. Management-group scope is unsupported.\nExamples: az-axi account list; az-axi account list -s <subscription> --full",
  "account show": "Shows one live ARM subscription selected by flags, environment or profile, resolving unambiguous names to IDs. Exactly one selected subscription is required; no implicit ambient az default is chosen.\nDefault: name, id (subscription GUID), state, tenantId. --full adds ARM metadata; --fields selects metadata. This does not change profile defaults or Azure CLI's account. Management-group scope is unsupported.\nExamples: az-axi account show -s <subscription>; az-axi account show --full",
  "monitor log-analytics workspace list": "Lists ARM workspace metadata in selected subscriptions (flags, environment, profile, else all accessible). --resource-group / -g scopes the list; --name / -n filters exact names.\nDefault: name, id (ARM ID), location, customerId (query workspace GUID). --limit defaults to 50; --full shows all fetched rows and safe metadata; --fields selects only documented metadata. Paging stops at 100 pages per subscription with lower-bound counts. Management-group scope is unsupported.\nExamples: az-axi monitor log-analytics workspace list; az-axi monitor log-analytics workspace list -g <group> --full",
  "monitor log-analytics workspace show": "Requires --workspace-name (or --name / -n) and --resource-group / -g in exactly one selected subscription, or one --ids <workspace-ARM-id> alone. Subscription names resolve to IDs. IDs must identify a workspace itself, never a child or action.\nDefault: name, id, location, customerId. --full and --fields expose only name, id, type, location, tags, customerId, state, retentionInDays, sku, publicNetworkAccessForIngestion, publicNetworkAccessForQuery. Shared keys, listKeys and unknown provider properties are never retrieved or printed. Management-group scope is unsupported.\nExamples: az-axi monitor log-analytics workspace show -g <group> --workspace-name <workspace> -s <subscription>; az-axi monitor log-analytics workspace show --ids <workspace-ARM-id> --full",
  "group list": "Lists live ARM resource groups in selected subscriptions (flags, environment, profile, else all accessible). Subscription names resolve to IDs. Management-group scope is unsupported.\n--limit defaults to 50; --full shows complete metadata and all fetched rows; --fields selects metadata fields. Lists follow up to 100 pages per subscription and disclose incomplete counts.\nExamples: az-axi group list; az-axi group list -s <subscription> --full",
  "group show": "Requires --name / -n and exactly one selected subscription (ID or unambiguous name).\nDefault: name, id, location, state; --full returns the complete ARM resource group.\nExamples: az-axi group show -n <group> -s <subscription>; az-axi group show -n <group> --full",
  "resource list": "Lists live ARM resources in selected subscriptions (flags, environment, profile, else all accessible). Subscription names resolve to IDs. Management-group scope is unsupported.\n--resource-group / -g scopes the list; --name / -n and --resource-type filter exact matches.\n--limit defaults to 50; --full shows complete metadata and all fetched rows; --fields selects metadata fields. Lists follow up to 100 pages per subscription and disclose incomplete counts.\nExamples: az-axi resource list -g <group>; az-axi resource list --resource-type Microsoft.Compute/virtualMachines",
  "resource show": "Requires exactly one --ids <ARM-id>, or --name / -n plus --resource-group / -g and --resource-type <namespace/type> in exactly one selected subscription.\n--api-version overrides provider metadata version discovery (newest stable version). --ids cannot be combined with name/group/type selectors.\nDefault: name, id, type, location. --full expands only the ARM envelope: id, name, type, kind, location, tags, sku, identity type, provisioningState. --fields selects only these envelope fields; properties and nested field paths are rejected. Provider properties are never returned.\nUse typed commands or az-axi api for provider details; api retains its existing redaction. Credential-bearing configuration, secret/key child resources and actions are refused before fetching.\nExamples: az-axi resource show --ids <ARM-id>; az-axi resource show -n <name> -g <group> --resource-type Microsoft.Compute/virtualMachines --full",
  "graph query": 'az-axi graph query --graph-query <kql> | -q <kql> | --file <path> | piped stdin\n--subscriptions a b (or -s a b) selects subscriptions; --management-groups a b selects management groups. Explicit scope families are mutually exclusive.\n--first aliases --limit (default 50, maximum 1000); --full requests a 1000-row page, as on rg query. --skip-token continues a page.\nScope: explicit flags, then profile managementGroup, then profile subscriptions, else all accessible subscriptions. Azure CLI defaults to all accessible subscriptions.\n--skip and --allow-partial-scopes are unsupported and rejected; use --skip-token for paging. --query (JMESPath) is unsupported.\nOutput: unchanged rg query TOON, including legacy pagination hints.\nExamples: az-axi graph query -q Resources --first 5; az-axi graph query --file query.kql --subscriptions <id>',
  "monitor log-analytics query": 'az-axi monitor log-analytics query --analytics-query <kql> | --file <path> | piped stdin\n--workspace / -w <alias|guid> is required; aliases come from the profile. ARM workspace resource IDs are rejected.\n--timespan / -t defaults to P1D and intersects KQL time filters; Azure CLI defaults to all available data.\n--limit defaults to 50 displayed rows; --full expands cells and still honors --limit. Additional workspaces are unsupported.\nOutput: unchanged logs query TOON, including workspace, workspaceId, timespan, total, count, rows.\nExamples: az-axi monitor log-analytics query --analytics-query Heartbeat -w <guid>; az-axi monitor log-analytics query --file hunt.kql -w sentinel -t P7D',
  "config init": "az-axi config init --name <name> --auth az|token [--default]\n--workspace alias=<guid>,... and --token-env arm=VAR,logs=VAR,graph=VAR configure auth.\nWrites a local profile only. No Azure writes.\nExamples: az-axi config init --name work --auth az; az-axi config init --name ci --auth token --default",
  "config list": "Lists profiles, scope and write status.\nExamples: az-axi config list; az-axi config list --config <path>",
  "config path": "Reports the selected config path and whether it exists.\nExamples: az-axi config path; az-axi config path --config <path>",
  "defender alerts": "Lists ARM alerts per subscription, newest first. Default --status Active; --status all includes every status.\n--severity High,Medium filters severity; --since 7d filters age (default all retained alerts); --limit defaults to 50.\nOutput: total, count, bySeverity, rows.\nExamples: az-axi security alert list --severity High; az-axi defender alerts --status all",
  "defender alerts get": "az-axi defender alerts get <alert-resource-id>\nTakes exactly one full alert ARM ID and returns alert details.\nExamples: az-axi defender alerts get <alert-resource-id>; az-axi defender alerts get <alert-resource-id> --full",
  "security alert update": ALERT_UPDATE_HELP,
  "defender assessments": "Recommendation summaries from Resource Graph, worst severity first. --limit defaults to 25.\n--severity High and --status Unhealthy filter recommendations; --resource <name> selects per-resource rows.\n--show-query prints KQL without running it.\nExamples: az-axi defender assessments --severity High; az-axi defender assessments --resource <name>",
  "defender score": "Secure scores from Resource Graph, lowest percentage first. --limit defaults to 50.\nOutput: total, count, rows (subscription,current,max,percent).\nExamples: az-axi security secure-scores list; az-axi defender score --full",
};

const HELP_FOOTER = [
  "",
  "Selector flags on every command: --profile, --tenant, --subscription a,b, --management-group, --config.",
  "Output: TOON on stdout. --full disables truncation, --fields a,b limits list columns, --limit N caps rows.",
  "Read-only by default; $AZ_AXI_READ_ONLY=1 forces read-only for the whole process.",
];

const HELP_TEXT = {
  storage: STORAGE_HELP,
  account: ["az-axi account list|show", LEAF_HELP["account list"], LEAF_HELP["account show"]].join("\n"),
  monitor: ["az-axi monitor log-analytics workspace list|show", LEAF_HELP["monitor log-analytics workspace list"], LEAF_HELP["monitor log-analytics workspace show"]].join("\n"),
  az: AZ_HELP,
  group: ["az-axi group list", "az-axi group show --name <group> --subscription <id>", LEAF_HELP["group list"], LEAF_HELP["group show"]].join("\n"),
  resource: ["az-axi resource list", "az-axi resource show --ids <ARM-id>", LEAF_HELP["resource list"], LEAF_HELP["resource show"]].join("\n"),
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
  security: ALERT_UPDATE_HELP,
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
    "         [--query 'k=v&k2=v2'] [--body '<json>' | --body-file <path>] [--raw] [--all] [--execute] [--confirm <name>] [--if-match <etag>] [--timeout <seconds>] [--no-wait]",
    "az-axi api /subscriptions --api-version 2022-12-01",
    "",
    "Escape hatch for any read or query request. Paths are relative to the host root.",
    "--api-version is required for arm when the path has no api-version query parameter.",
    "JSON body: use --body, --body-file, or piped stdin (exactly one source). Empty stdin means no body; invalid JSON is refused before requests.",
    "Lists with a value[] array return count plus value; --all follows ARM nextLink (up to 10 pages).",
    "Strings truncate at 4,000 chars unless --full.",
    "Writes and destructive requests return a dry-run preview using reads or a deployment what-if query.",
    "See README.md#writes for access, preview output and execution behavior.",
    "Destructive execution needs --confirm <resource-name>.",
    "--execute re-checks current state before sending; --if-match protects the reviewed ETag.",
    "Async writes poll for up to --timeout seconds (default 600); --no-wait returns an op status command.",
    "Examples: az-axi api /subscriptions --api-version 2022-12-01",
    "az-axi api POST /providers/Microsoft.ResourceGraph/resources --api-version 2024-04-01 --body-file query.json",
    "az-axi api PATCH <resource-path> --api-version <v> < body.json",
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

const commandNames = [...new Set(COMMAND_LEAVES.map((leaf: CommandLeaf) => (leaf.handlerPath ?? leaf.path).split(" ")[0] as CommandName))];

/** Keep legacy group dispatch and group help, deriving their surface from exact leaves. */
export const COMMANDS: Record<string, () => Promise<CommandModule>> = Object.assign(
  Object.create(null),
  Object.fromEntries(commandNames.map((name) => [name, LOADERS[name]])),
);

export const COMMAND_HELP: Record<string, string> = Object.assign(
  Object.create(null),
  Object.fromEntries(commandNames.map((name) => [name, HELP_TEXT[name]])),
);

export const TOP_LEVEL_HELP = [
  ...commandNames.map((name) => HELP_OVERVIEWS[name]),
  ...COMMAND_LEAVES.filter((leaf: CommandLeaf) => leaf.handlerPath).map((leaf) => `az-axi ${leaf.path}  # canonical query path`),
  ...COMMAND_LEAVES.flatMap((leaf: CommandLeaf) => (leaf.aliases ?? []).map((alias) => `az-axi ${alias}  # alias of ${leaf.path}`)),
  ...HELP_FOOTER,
].join("\n");

/** Static agent command list, checked against the committed skill by the offline suite. */
export function commandListMarkdown(): string {
  return [
    "| Command | Capability | Azure effect |",
    "|---|---|---|",
    ...COMMAND_LEAVES.flatMap((leaf: CommandLeaf) => [leaf.path, ...leaf.aliases ?? []]
      .map((path) => `| \`az-axi ${path}\` | ${leaf.capability} | ${leaf.effect} |`)),
  ].join("\n");
}
