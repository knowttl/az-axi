const KINDS: Record<string, { collection: string; endpoint: string }> = {
  secret: { collection: "secrets", endpoint: "/secrets" },
  key: { collection: "keys", endpoint: "/keys" },
  certificate: { collection: "certificates", endpoint: "/certificates" },
};

export function keyvaultLeafHelp(path: string): string {
  const kind = path.split(" ")[1] ?? "secret";
  const list = path.endsWith(" list");
  const { collection, endpoint } = KINDS[kind] ?? KINDS.secret!;
  return [
    `Command: az-axi ${path}`,
    `az-axi ${path} --vault-name <vault>${list ? " [--expiring-within 30d]" : " --name <name>"}`,
    "Required: --vault-name; show requires --name / -n.",
    "Entra bearer auth only for https://vault.azure.net/. Token profiles use $AZ_AXI_VAULT_TOKEN or tokenEnv.vault. No key, SAS or ambient credential fallback.",
    "Public Azure Key Vault data plane only. Subscription selectors do not filter data-plane results; --vault-name selects the vault.",
    `Property listing only (GET ${endpoint}): names, enabled, expiry, timestamps, content type or thumbprint. Secret values, key material and certificate bytes are never requested or returned.`,
    list
      ? "List pages through the service continuation to --limit (default 50, 1-1000); --expiring-within Nd filters to items expiring soon. A trailing + on the count means more pages remain."
      : "Show filters the property list by --name and never calls a value endpoint, even though the verb reads like one.",
    "Lists default to name, enabled and expiresOn; --fields or --full expands to the safe schema. Show returns every safe property. Tags and all values are excluded.",
    "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --fields, --full, --limit, --help / -h.",
    `Examples: az-axi keyvault ${kind} list --vault-name kvexample${list ? " --expiring-within 30d" : " --name example-secret"}`,
  ].join("\n");
}

export const KEYVAULT_HELP = [
  "az-axi keyvault secret list --vault-name <vault>",
  "az-axi keyvault secret show --vault-name <vault> --name <secret>",
  "az-axi keyvault key list --vault-name <vault>",
  "az-axi keyvault key show --vault-name <vault> --name <key>",
  "az-axi keyvault certificate list --vault-name <vault>",
  "az-axi keyvault certificate show --vault-name <vault> --name <certificate>",
  keyvaultLeafHelp("keyvault secret list"),
  `Safe collections: ${Object.values(KINDS).map(({ collection }) => collection).join(", ")}.`,
].join("\n");
