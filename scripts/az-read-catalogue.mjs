import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@toon-format/toon";

const HELP = {
  usage: "node scripts/az-read-catalogue.mjs [--check | --help]",
  description: "Generate the data-only az read catalogue from checked-in, pinned official source excerpts. No network, Python imports or child processes.",
  flags: ["--check: refuse a stale artifact without writing", "--help: print this reference"],
  examples: ["node scripts/az-read-catalogue.mjs", "node scripts/az-read-catalogue.mjs --check"],
};
const SOURCE_FILE = new URL("./az-read-catalogue.sources.json", import.meta.url);
const OUTPUT_FILE = new URL("../src/lib/azReadCatalogue.ts", import.meta.url);
// These digests lock the reviewed excerpts, source identities and line ranges together.
const PINS = {
  registration: "892b5e9eacc600bc62607794a1862a706a27e2cbb398fcc63e9a0d8e53eea2b3",
  arguments: "0eaf42a43cc09d2e44095791d92bbb84c9110c75a82ab11a7051ffdf4521a139",
  profile: "a8584140f119768159bf62ad2717b2a8f7b7272209f57529bdae109bf609e000",
  dependency: "690ce970a64adfbc6a160d7dabbf487ace5ffc8ea1b2d3793216f07f75cf165e",
  factory: "f7ad9ff9636b8cc0b359d022b2d3065fc6982179a52abcfe6407883706d0cdaa",
  operation: "1f92cfe360d23ffd247862f7bcbfd64b46ea9c3b7af8c5ce663c5d754d59732f",
};
const VERSION = "2.90.0";
const AZ_CLI_COMMIT = "dc50d475a00ded4a1a1980d4a10a9fbd9a750a81";
const SDK_PACKAGE = "azure-mgmt-resource";
const SDK_VERSION = "24.0.0";
const HANDLER = "azure.mgmt.resource.resources.operations#ResourceGroupsOperations.get";
const OPERATION = {
  method: "GET",
  path: "/subscriptions/{subscriptionId}/resourcegroups/{resourceGroupName}",
  apiVersion: "2024-11-01",
};

/** Maintenance classification only. This module never discovers or executes az handlers. */
export function classifyCandidate(candidate) {
  const refuse = (reason) => ({ effect: "write", reason });
  if (candidate.credentialReturning !== false ||
      /keys?|connection.?strings?|sas|credentials?|secrets?|tokens?|kubeconfig|publishing|appsettings|callback/i
        .test(`${candidate.command} ${candidate.handler} ${JSON.stringify(candidate.operations)}`)) {
    return refuse("credential or secret-returning command/operation is not an approved read");
  }
  if (candidate.version !== VERSION) return refuse("unsupported Azure CLI version");
  if (!Array.isArray(candidate.extensions) || candidate.extensions.length !== 0) {
    return refuse("extensions are not supported or imported");
  }
  if (candidate.command !== "group show") return refuse("unknown or unreviewed command");
  if (candidate.handlerClass !== "sdk" || candidate.handler !== HANDLER) {
    return refuse("unknown or custom handler");
  }
  if (JSON.stringify(candidate.operations) !== JSON.stringify([OPERATION])) {
    return refuse("unknown or unreviewed operation chain");
  }
  return { effect: "read" };
}

export function buildCatalogue(sources) {
  if (Object.keys(sources).sort().join() !== Object.keys(PINS).sort().join()) {
    throw new Error("Unknown or missing metadata source; classification is write/refusal");
  }
  for (const [name, digest] of Object.entries(PINS)) {
    const actual = createHash("sha256").update(JSON.stringify(sources[name])).digest("hex");
    if (actual !== digest) throw new Error(`Unreviewed ${name} metadata; classification is write/refusal`);
  }
  const registration = sources.registration.text;
  const template = registration.match(/operations_tmpl='([^']+)'/)[1];
  const verb = registration.match(/g\.show_command\('show', '([^']+)'\)/)[1];
  const operation = sources.operation.text;
  const candidate = {
    command: "group show", version: VERSION, extensions: [], handlerClass: "sdk",
    handler: template.replace("{}", verb), credentialReturning: false,
    operations: [{
      method: operation.match(/HttpRequest\(method="([^"]+)"/)[1],
      path: operation.match(/template_url", "([^"]+)"/)[1],
      apiVersion: operation.match(/api-version", "([^"]+)"/)[1],
    }],
  };
  const classification = classifyCandidate(candidate);
  if (classification.effect !== "read") throw new Error(classification.reason);
  const flags = sources.arguments.text.match(/resource_group_name.*options_list=\[([^\]]+)\]/)[1]
    .match(/'([^']+)'/g).map((flag) => flag.slice(1, -1));
  return {
    schemaVersion: 1,
    status: "catalogue-only; no passthrough execution",
    generatedFrom: {
      azureCliVersion: VERSION,
      azureCliCommit: AZ_CLI_COMMIT,
      sdkPackage: SDK_PACKAGE,
      sdkVersion: SDK_VERSION,
    },
    defaultEffect: "write",
    defaultAction: "refuse",
    entries: [{
      command: candidate.command,
      effect: "read",
      handlerClass: candidate.handlerClass,
      handler: candidate.handler,
      runtime: {
        package: "azure-cli", version: VERSION, distribution: "official trusted Azure CLI",
        profile: "latest", cloud: "AzureCloud", platforms: ["linux", "macos", "windows"],
        extensions: [], sdkPackage: SDK_PACKAGE, sdkVersion: SDK_VERSION,
      },
      operations: candidate.operations,
      credentials: {
        authentication: "matching az-auth profile, tenant and subscription; ARM token required",
        permission: "Microsoft.Resources/subscriptions/resourceGroups/read",
        returns: "none", keyFallback: false,
      },
      arguments: [
        {
          flags, required: true, type: "string", occurrences: 1,
          minLength: 1, maxLength: 90, pattern: "^[A-Za-z0-9_.()-]+$",
          constraint: "one literal resource-group name; conservative ASCII subset of SDK name validation",
        },
        {
          flags: ["--subscription"], required: true, type: "uuid", occurrences: 1,
          constraint: "one explicit effective subscription ID; no names, lists or fan-out",
        },
      ],
      argumentPolicy: {
        unknown: "refuse", positionals: "refuse", duplicateAliases: "refuse",
        globals: "refuse caller-supplied globals, including --ids, --query, --output, --debug and local destinations",
        transport: "consumer must force JSON, disable prompts and dynamic extension installation",
      },
      output: { transport: "json", schema: "ResourceGroup", credentialValues: false },
      provenance: Object.entries(sources).map(([name, source]) => ({
        kind: name, source: source.source, commit: source.commit, lines: source.lines,
        excerptSha256: createHash("sha256").update(source.text).digest("hex"),
      })),
    }],
  };
}

export function renderCatalogue(catalogue) {
  return "// Generated by scripts/az-read-catalogue.mjs. Do not edit manually.\n" +
    `export const AZ_READ_CATALOGUE = ${JSON.stringify(catalogue, null, 2)} as const;\n`;
}

export function main(args) {
  if (args.length > 1 || args.some((arg) => !["--help", "--check"].includes(arg))) {
    console.log(encode({ error: "Unknown flags or arguments", help: [HELP.usage] }));
    return 2;
  }
  if (args[0] === "--help") {
    console.log(encode(HELP));
    return 0;
  }
  try {
    const catalogue = buildCatalogue(JSON.parse(readFileSync(SOURCE_FILE, "utf8")));
    const output = renderCatalogue(catalogue);
    if (args[0] === "--check") {
      if (readFileSync(OUTPUT_FILE, "utf8").replace(/\r\n/g, "\n") !== output) {
        throw new Error("Stale read catalogue; regenerate and review the diff");
      }
    } else {
      writeFileSync(OUTPUT_FILE, output);
    }
    console.log(encode({ catalogue: args[0] === "--check" ? "current" : "generated", reads: catalogue.entries.length, runtime: VERSION, execution: "unavailable" }));
    return 0;
  } catch (error) {
    console.log(encode({ error: error.message, help: ["Review pinned sources and generator before regenerating the catalogue"] }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
