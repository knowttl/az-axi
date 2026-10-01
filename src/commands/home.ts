import { AxiError } from "axi-sdk-js";
import { homeHeader } from "../lib/paths.js";
import { DESCRIPTION } from "../help.js";

export async function homeCommand(argv: string[]): Promise<Record<string, unknown>> {
  if (argv.length > 0) {
    throw new AxiError(`unexpected argument \`${argv[0]}\` for \`home\``, "VALIDATION_ERROR", [
      "Run `az-axi home` with no arguments for the dashboard",
      "Run `az-axi home --help` for usage",
    ]);
  }
  return {
    ...homeHeader(DESCRIPTION),
    status: "bootstrap build: no commands are implemented yet",
    help: ["Run `az-axi --help` for the command surface"],
  };
}
