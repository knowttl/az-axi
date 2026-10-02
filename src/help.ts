export const DESCRIPTION =
  "Read-only Azure inspection for agents: resource inventory, RBAC, activity log, Defender for Cloud and Log Analytics";

export const TOP_LEVEL_HELP = [
  "az-axi                                   # dashboard: profile, identity, subscriptions, write status",
  "az-axi doctor                            # check az, tokens, ARM reachability and write status per profile",
  "az-axi config init|list|path             # manage profiles in ~/.az-axi/config.json",
  "az-axi sub list                          # subscriptions visible to the identity",
  "az-axi rg query \"<kql>\"                  # Resource Graph query across subscriptions",
  "az-axi api GET /subscriptions            # escape hatch for any read or query request",
  "",
  "Selector flags on every command: --profile, --tenant, --subscription a,b, --management-group, --config.",
  "Output: TOON on stdout. --full disables truncation, --fields a,b limits list columns, --limit N caps rows.",
  "Read-only by default; $AZ_AXI_READ_ONLY=1 forces read-only for the whole process.",
].join("\n");

export const COMMAND_HELP: Record<string, string> = Object.assign(Object.create(null), {
  home: [
    "az-axi                                   # dashboard: profile, identity, subscriptions, write status",
    "az-axi home                              # same as above",
    "",
    "Selector flags are accepted. No positional arguments. --help prints this reference.",
    "Defender, score and exposure sections arrive in Phase 4.",
    "Examples: az-axi; az-axi home; az-axi home --help",
  ].join("\n"),
  doctor: [
    "az-axi doctor [--profile <name>] [--config <path>]",
    "",
    "One row per profile: name, auth, identity, type, subscriptions, writes, status.",
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
  api: [
    "az-axi api [GET|POST|PUT|PATCH|DELETE] <path> [--resource arm|logs|graph] [--api-version <v>]",
    "         [--query 'k=v&k2=v2'] [--body '<json>'] [--raw] [--all]",
    "az-axi api /subscriptions --api-version 2022-12-01",
    "",
    "Escape hatch for any read or query request. Paths are relative to the host root.",
    "--api-version is required for arm when the path has no api-version query parameter.",
    "Lists with a value[] array return count plus value; --all follows ARM nextLink (up to 10 pages).",
    "Strings truncate at 4,000 chars unless --full. Writes are blocked with WRITES_DISABLED in Phase 2.",
    "Examples: az-axi api /subscriptions --api-version 2022-12-01",
  ].join("\n"),
});
