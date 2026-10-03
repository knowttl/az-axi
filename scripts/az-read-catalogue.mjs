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
  registration: "fca267cc3e1ab90e1faee5876b28f886a46cf0105e58937360069e7527d76f8a",
  arguments: "4edcf7d929fa8c5a6a0f8562d610c4edd69d46655d52b3e59100f1b81f4aebc4",
  profile: "bc56550e29074493b6d1a2255dbbb64885c0804f06b1a3729718ff722392c46a",
  dependency: "27267bb4dfb90c6882c5571665f690ca96725ee7c1d2fbf6daae79b3056d2959",
  factory: "fbec12c7cd90ea8f5d0c8bb61dd629e5397d8069143d40cb911bc8cc67690f04",
  operation: "33cb04855779d33322944a70c1022c3085ec6ce7d518d4ef2318833551ccbd50",
};
const VERSION = "2.77.0";
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
        extensions: [], sdkPackage: "azure-mgmt-resource", sdkVersion: "23.3.0",
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
