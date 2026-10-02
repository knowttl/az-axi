import { AxiError } from "axi-sdk-js";
import { SUBSCRIPTIONS_LIST } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, parseArgs } from "../lib/args.js";
import { requestAll } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { countLine, emptyState, pickFields } from "../lib/format.js";
import type { CommandMeta } from "../lib/registry.js";

export const meta: CommandMeta = { name: "sub", effect: "read" };

const DEFAULT_LIMIT = 50;
const SUBCOMMANDS = ["list"] as const;

interface Subscription {
  subscriptionId: string;
  displayName: string;
  state: string;
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  subcommandOf(args, SUBCOMMANDS, "sub");
  assertKnownFlags(args, [], "sub list");
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`sub list\``, "VALIDATION_ERROR", [
      "Run `az-axi sub list --help` for usage",
    ]);
  }

  const profile = profileFromArgs(args);
  const limit = flagBool(args, "full") ? Number.POSITIVE_INFINITY : (flagNumber(args, "limit") ?? DEFAULT_LIMIT);
  if (!(limit > 0)) {
    throw new AxiError("flag --limit must be greater than 0", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }

  const { items, nextLink } = await requestAll<Subscription>(profile, {
    path: "/subscriptions",
    apiVersion: SUBSCRIPTIONS_LIST,
  });
  if (items.length === 0) {
    return {
      profile: profile.name,
      subscriptions: emptyState("subscriptions", "visible to this identity"),
      help: ["Run `az login` (or `az login --tenant <tenant-id>`) and check the signed-in account with `az-axi doctor`"],
    };
  }

  const inScope = new Set((profile.subscriptions ?? []).map((id) => id.toLowerCase()));
  const rows = items
    .map((s) => ({
      name: s.displayName,
      id: s.subscriptionId,
      state: s.state,
      inScope: inScope.size === 0 || inScope.has(s.subscriptionId.toLowerCase()) ? "yes" : "no",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shown = rows.slice(0, limit);

  const help: string[] = [];
  if (shown.length < rows.length) help.push("Run `az-axi sub list --full` to list every subscription");
  if (nextLink) help.push("More pages exist but paging stopped at the page cap; narrow with --subscription");
  if (inScope.size === 0) help.push("Narrow the scope with `--subscription <id>` on any command");

  return {
    profile: profile.name,
    count: countLine(shown.length, nextLink ? undefined : rows.length, "subscriptions"),
    subscriptions: pickFields(shown, flagList(args, "fields")),
    ...(help.length > 0 ? { help } : {}),
  };
}
