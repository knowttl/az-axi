import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import type { CommandMeta } from "../lib/registry.js";

export const meta: CommandMeta = { name: "op", effect: "read" };

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  subcommandOf(args, ["status"], "op");
  assertKnownFlags(args, [], "op status");
  if (args.positionals.length !== 2) {
    throw new AxiError("op status requires exactly one operation URL", "VALIDATION_ERROR", [
      "Run `az-axi op status <operation-url>` using the URL from the pending preview",
    ]);
  }

  const path = args.positionals[1]!;
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    throw new AxiError("invalid operation URL", "VALIDATION_ERROR", [
      "Pass the absolute https://management.azure.com operation URL from the pending preview",
    ]);
  }
  if (url.protocol !== "https:" || url.host !== "management.azure.com") {
    throw new AxiError("operation URL must target https://management.azure.com", "VALIDATION_ERROR", []);
  }

  return request<Record<string, unknown>>(profileFromArgs(args), { method: "GET", resource: "arm", path });
}
