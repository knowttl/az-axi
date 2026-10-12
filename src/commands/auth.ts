import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagString, parseArgs } from "../lib/args.js";
import { identityOf } from "../lib/auth.js";
import { CREDENTIAL_RESOURCES, loadConfig, resolveSecret, secretRefFor } from "../lib/config.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { commandMeta } from "../lib/registry.js";

export const meta = commandMeta("auth");

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  subcommandOf(args, ["status"], "auth");
  assertKnownFlags(args, [], "auth status");
  if (args.positionals.length !== 1) throw new AxiError("auth status accepts no extra arguments", "VALIDATION_ERROR");
  loadConfig(flagString(args, "config"), true);
  const profile = profileFromArgs(args);
  if (profile.auth === "az") {
    return { profile: profile.name, auth: "az", endpoint: "https://management.azure.com/", source: "Azure CLI ambient session", identity: await identityOf(profile) };
  }
  const sources = CREDENTIAL_RESOURCES.map((resource) => {
    const ref = secretRefFor(profile, resource);
    const available = "env" in ref ? !!process.env[ref.env] : "file" in ref;
    if (available || resource === "arm" || "stored" in ref) resolveSecret(ref, true);
    return { resource, kind: "env" in ref ? "env" : "file" in ref ? "file" : "stored", location: "env" in ref ? ref.env : "file" in ref ? ref.file : "unsupported", available };
  });
  return { profile: profile.name, auth: "token", endpoint: "https://management.azure.com/", sources };
}
