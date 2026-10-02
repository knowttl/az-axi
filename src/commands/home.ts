import { AxiError } from "axi-sdk-js";
import { homeHeader } from "../lib/paths.js";
import { DESCRIPTION } from "../help.js";
import type { CommandMeta } from "../lib/registry.js";

export const meta: CommandMeta = { name: "home", effect: "read" };

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  if (argv.length > 0) {
    throw new AxiError(`unexpected argument \`${argv[0]}\` for \`home\``, "VALIDATION_ERROR", [
      "Run `az-axi home` with no arguments for the dashboard",
      "Run `az-axi home --help` for usage",
    ]);
  }
  return {
    ...homeHeader(DESCRIPTION),
    status: "doctor, config, and sub list are available; the dashboard arrives in Phase 2",
    help: ["Run `az-axi --help` for the command surface"],
  };
}
