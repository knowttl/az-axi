import { AZ_READ_CATALOGUE } from "./azReadCatalogue.js";

export const AZ_HELP = [
  "az-axi az group show --name <name> --subscription <uuid> [--profile <name>] [--config <path>] [--full] [--fields a,b]",
  "Approved reads: " + AZ_READ_CATALOGUE.entries.map((entry) => entry.command).join(", "),
  "Requires a configured az-auth profile with an explicit tenant and exactly one matching subscription.",
  `Runtime: Azure CLI ${AZ_READ_CATALOGUE.generatedFrom.azureCliVersion}, AzureCloud/latest; every child has fresh empty user/system extension directories and cleared dev sources.`,
  "Trusted official distributions only; the signed-in AZURE_CONFIG_DIR is preserved. Temporary extension directories are cleaned up.",
  "Fixed version, cloud show and account show JSON probes run before the requested read; mismatches never execute that read.",
  "Unknown commands, mutations, credentials, duplicate flags and unsupported globals fail before any probe.",
  "Name aliases: -n, --resource-group, -g. Wrapper flags: --profile, --config, --full, --fields, --help.",
  "Default output: resourceGroup (id, name, location, state); --full adds tags. Raw properties are never returned.",
  "--fields selects default resourceGroup columns. No --query, --output, --ids, --execute, local files or data-plane commands.",
  "Each process: 30-second deadline, 1 MiB output ceiling, closed stdin, JSON transport; prompts, dynamic extension install, upgrades and file logging disabled.",
  "Examples: az-axi az group show -n rg-demo --subscription <uuid> --profile work",
  "az-axi az group show --resource-group rg-demo --subscription <uuid> --full",
].join("\n");
