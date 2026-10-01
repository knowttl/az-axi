export const DESCRIPTION =
  "Read-only Azure inspection for agents: resource inventory, RBAC, activity log, Defender for Cloud and Log Analytics";

export const TOP_LEVEL_HELP = [
  "az-axi                                   # dashboard (placeholder until Phase 2)",
  "",
  "Bootstrap build: no commands are implemented yet.",
  "Output: TOON on stdout. --full disables truncation, --fields a,b limits list columns.",
].join("\n");

export const COMMAND_HELP: Record<string, string> = {
  home: [
    "az-axi home                              # placeholder dashboard",
    "",
    "No arguments or flags are accepted. --help prints this reference.",
    "Examples: az-axi; az-axi home; az-axi home --help",
  ].join("\n"),
};
