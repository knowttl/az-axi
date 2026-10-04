import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagList, flagNumber, flagText, parseArgs } from "../lib/args.js";
import { requestStorageMetadata } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { emptyState, pickFields } from "../lib/format.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { storageLeafHelp } from "../lib/storageHelp.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("storage");

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const [kind, verb] = args.positionals;
  const path = `storage ${kind} ${verb}`;
  if ((kind !== "container" && kind !== "blob") || (verb !== "list" && verb !== "show") || args.positionals.length !== 2) {
    throw new AxiError("expected storage container|blob list|show", "VALIDATION_ERROR", ["Run `az-axi storage --help`"]);
  }
  assertKnownFlags(args, commandFlags(path), path, storageLeafHelp(path));
  const authMode = flagText(args, "auth-mode");
  if (authMode !== undefined && authMode !== "login") {
    throw new AxiError("storage supports only --auth-mode login", "VALIDATION_ERROR", ["Remove --auth-mode or use --auth-mode login"]);
  }
  const required = (flag: string): string => {
    const value = flagText(args, flag);
    if (!value) throw new AxiError(`--${flag} is required`, "VALIDATION_ERROR", [storageLeafHelp(path)]);
    return value;
  };
  const account = required("account-name");
  const container = kind === "blob" ? required("container-name") : undefined;
  const name = verb === "show" ? required("name") : undefined;
  const limit = flagNumber(args, "limit") ?? 50;
  if (args.flags.limit === true || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new AxiError("--limit must be an integer from 1 to 1000", "VALIDATION_ERROR", ["Example: --limit 50"]);
  }
  const fields = flagList(args, "fields");
  const safe = ["name", "lastModified", "etag", ...(kind === "blob" ? ["size", "blobType"] : ["publicAccess"])];
  if (fields?.some((field) => !safe.includes(field))) {
    throw new AxiError("--fields accepts only safe storage properties", "VALIDATION_ERROR", [`Valid fields: ${safe.join(",")}`]);
  }
  const page = await requestStorageMetadata(profileFromArgs(args), {
    kind, verb, account, container, name, limit, prefix: flagText(args, "prefix"), marker: flagText(args, "marker"),
  });
  if (verb === "show") return { account, [kind]: pickFields(page.rows, fields)[0] };
  const noun = `${kind}s`;
  const target = `${formatFlagValue("account-name", account)}${container ? ` ${formatFlagValue("container-name", container)}` : ""}`;
  const selectors = ["profile", "tenant", "config"].flatMap((flag) => {
    const value = flagText(args, flag);
    return value ? [` ${formatFlagValue(flag, value)}`] : [];
  }).join("");
  const prefix = flagText(args, "prefix");
  return {
    account, ...(container ? { container } : {}), count: `${page.rows.length}${page.nextMarker ? "+" : ""} ${noun}`,
    [noun]: page.rows.length ? pickFields(page.rows, fields) : emptyState(noun, `in ${container ?? account}${page.nextMarker ? " on this page" : ""}`),
    ...(page.nextMarker ? { nextMarker: page.nextMarker, help: [`Run \`az-axi ${path} ${target}${selectors}${prefix ? ` ${formatFlagValue("prefix", prefix)}` : ""} --limit ${limit} ${formatFlagValue("marker", page.nextMarker)}\` for the next page`] }
      : page.rows.length ? { help: [`Run \`az-axi storage ${kind} show ${target}${selectors} --name <name>\` for properties`] } : {}),
  };
}
