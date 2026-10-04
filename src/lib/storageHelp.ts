export function storageLeafHelp(path: string): string {
  const blob = path.includes(" blob ");
  const list = path.endsWith(" list");
  const target = `--account-name <account>${blob ? " --container-name <container>" : ""}${list ? "" : " --name <name>"}`;
  return [
    `Command: az-axi ${path}`,
    `az-axi ${path} ${target}`,
    "Required: --account-name; blob commands also require --container-name; show requires --name / -n.",
    "Entra bearer auth only, equivalent to --auth-mode login (the only accepted mode). No key, SAS, connection-string or anonymous fallback.",
    "Auth: profile az requests https://storage.azure.com/; token profiles use $AZ_AXI_STORAGE_TOKEN or tokenEnv.storage. Azure storage auth defaults and credentials are never used.",
    "Public Azure Blob endpoint only. Subscription selectors do not filter data-plane results; --account-name selects the account.",
    list ? "--limit defaults to 50 (1-1000); one service page, --marker continues, --prefix filters names. Total is unknown while nextMarker is present." : "show uses HEAD for service properties only, never downloads blob content.",
    "--fields selects safe properties only; --full keeps the same safe schema and page limit. User metadata, tags, content, keys and secret values are excluded.",
    "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --fields, --full, --limit, --help / -h.",
    `Examples: az-axi ${path} ${target}; az-axi ${path} ${target} --auth-mode login${list ? " --prefix <prefix> --limit 10" : " --full"}`,
  ].join("\n");
}

export const STORAGE_HELP = [
  "az-axi storage container list --account-name <account>",
  "az-axi storage container show --account-name <account> --name <container>",
  "az-axi storage blob list --account-name <account> --container-name <container>",
  "az-axi storage blob show --account-name <account> --container-name <container> --name <blob>",
  storageLeafHelp("storage blob list"),
].join("\n");
