import { homeHeader } from "../lib/paths.js";
import { DESCRIPTION } from "../help.js";

export async function homeCommand(_argv: string[]): Promise<Record<string, unknown>> {
  return {
    ...homeHeader(DESCRIPTION),
    status: "bootstrap build: no commands are implemented yet",
    help: ["Run `az-axi --help` for the command surface"],
  };
}
