import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, parseArgs } from "../lib/args.js";
import { sendRequest } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { assertOperationUrl, describeOperation, opStatusCommand } from "../lib/lro.js";
import { commandMeta } from "../lib/registry.js";

/**
 * Long-running operation status (PLAN.md Section 6.13.5).
 * A single read-only GET of the operation URL: it reports the current state
 * but never polls, so it is safe to re-run while waiting out a timeout.
 */
export const meta = commandMeta("op");

const SUBCOMMANDS = ["status"] as const;

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  subcommandOf(args, SUBCOMMANDS, "op");
  assertKnownFlags(args, [], "op status");
  const operationUrl = args.positionals[1];
  if (!operationUrl) {
    throw new AxiError("missing operation URL for `op status`", "VALIDATION_ERROR", [
      "Example: `az-axi op status 'https://management.azure.com/<operation-path>?api-version=<v>'`",
    ]);
  }
  if (args.positionals.length > 2) {
    throw new AxiError(`unexpected argument \`${args.positionals[2]}\` for \`op status\``, "VALIDATION_ERROR", [
      "Pass exactly one operation URL",
    ]);
  }

  const url = assertOperationUrl(operationUrl);
  const profile = profileFromArgs(args);
  const response = await sendRequest<Record<string, unknown>>(profile, { path: url });
  const state = describeOperation(response);

  const help: string[] = [];
  if (state.running) help.push(`Re-run \`${opStatusCommand(url, profile)}\` to check again`);

  return {
    ...(typeof response.body?.status === "string" ? {} : {
      operation: url,
      state: state.state,
      status: response.status,
    }),
    ...response.body,
    ...(help.length > 0 ? { help } : {}),
  };
}
