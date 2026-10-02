export const DESCRIPTION =
  "Read-only Azure inspection for agents: resource inventory, RBAC, activity log, Defender for Cloud and Log Analytics";

export const TOP_LEVEL_HELP = [
  "az-axi                                   # dashboard (placeholder until Phase 2)",
  "az-axi doctor                            # check az, tokens, ARM reachability and write status per profile",
  "az-axi config init|list|path             # manage profiles in ~/.az-axi/config.json",
  "az-axi sub list                          # subscriptions visible to the identity",
  "",
  "Selector flags on every command: --profile, --tenant, --subscription a,b, --management-group, --config.",
  "Output: TOON on stdout. --full disables truncation, --fields a,b limits list columns, --limit N caps rows.",
  "Read-only by default; $AZ_AXI_READ_ONLY=1 forces read-only for the whole process.",
].join("\n");

export const COMMAND_HELP: Record<string, string> = Object.assign(Object.create(null), {
  home: [
    "az-axi home                              # placeholder dashboard",
    "",
    "No arguments or flags are accepted. --help prints this reference.",
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
});
