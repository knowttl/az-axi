export function acrLeafHelp(path: string): string {
  const tags = path === "acr repository show-tags";
  const manifest = path === "acr manifest show-metadata";
  const target = manifest
    ? "--registry <registry> --name <repository:tag|repository@digest>"
    : `--name <registry>${tags ? " --repository <repository>" : ""}`;
  return [
    `Command: az-axi ${path}`,
    `az-axi ${path} ${target}`,
    manifest
      ? "Required: --registry and --name / -n (repository:tag or repository@digest, never a login-server-qualified ID)."
      : "Required: --name / -n (the registry name); show-tags also requires --repository.",
    "Entra bearer auth only, through token exchange for a pull-scoped access token. No admin-user password, docker login, credential export or key fallback.",
    "Auth: profile az requests https://containerregistry.azure.net/; token profiles use $AZ_AXI_REGISTRY_TOKEN or tokenEnv.registry. Azure container-registry passwords and ambient credentials are never used.",
    "Public Azure login server only (<registry>.azurecr.io, built from the validated registry name). Subscription selectors do not filter data-plane results; --name/--registry selects the registry.",
    manifest
      ? "show-metadata reads one manifest document and projects digest, mediaType, config and layer descriptors only. Blob content is never fetched and no local file is written."
      : "--limit defaults to 50 (1-1000); one service page, --marker continues from the service Link header. Total is unknown while nextMarker is present.",
    tags
      ? "--orderby accepts only time_asc or time_desc (az vocabulary). --fields selects name, digest, createdTime, lastUpdateTime; --full keeps the same safe schema and page limit."
      : manifest
        ? "--fields selects digest, mediaType, schemaVersion, config, layers, manifests; --full keeps the same safe projection. Signatures, history and download URLs are excluded."
        : "--fields selects name only; --full keeps the same safe schema and page limit.",
    "Globals: --profile, --tenant, --subscription / -s, --management-group, --config, --fields, --full, --limit, --help / -h.",
    `Examples: az-axi ${path} ${target}${tags ? " --orderby time_desc --limit 10" : manifest ? "" : " --limit 10"}`,
  ].join("\n");
}

export const ACR_HELP = [
  "az-axi acr repository list --name <registry>",
  "az-axi acr repository show-tags --name <registry> --repository <repository>",
  "az-axi acr manifest show-metadata --registry <registry> --name <repository:tag|repository@digest>",
  acrLeafHelp("acr repository show-tags"),
].join("\n");
