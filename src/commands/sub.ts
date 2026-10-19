import { AxiError } from "axi-sdk-js";
import { SUBSCRIPTIONS_LIST } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagList, flagNumber, parseArgs } from "../lib/args.js";
import { requestAll } from "../lib/client.js";
import { profileFromArgs, subcommandOf } from "../lib/context.js";
import { countLine, emptyState, pickFields } from "../lib/format.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { nativeListBudget, nativeListFetchFlags, NATIVE_LIST_INCOMPLETE } from "../lib/nativePaging.js";

export const meta = commandMeta("sub");

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
  assertKnownFlags(args, commandFlags("sub list"), "sub list");
  if (args.positionals.length > 1) {
    throw new AxiError(`unexpected argument \`${args.positionals[1]}\` for \`sub list\``, "VALIDATION_ERROR", [
      "Run `az-axi sub list --help` for usage",
    ]);
  }

  const budget = nativeListBudget(args);
  const profile = profileFromArgs(args);
  const limit = flagBool(args, "full") ? Number.POSITIVE_INFINITY : (flagNumber(args, "limit") ?? DEFAULT_LIMIT);
  if (!(limit > 0)) {
    throw new AxiError("flag --limit must be greater than 0", "VALIDATION_ERROR", ["Example: --limit 20"]);
  }

  const { items, nextLink, incomplete } = await requestAll<Subscription>(
    profile,
    {
      path: "/subscriptions",
      apiVersion: SUBSCRIPTIONS_LIST,
    },
    budget,
  );
  const partial = incomplete || !!nextLink;
  if (items.length === 0) {
    return {
      profile: profile.name,
      subscriptions: emptyState("subscriptions", partial ? "in fetched pages; listing incomplete" : "visible to this identity"),
      help: partial ? [NATIVE_LIST_INCOMPLETE] : ["Run `az login` (or `az login --tenant <tenant-id>`) and check the signed-in account with `az-axi doctor`"],
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
  if (!partial && shown.length < rows.length) help.push(`Run \`az-axi sub list${nativeListFetchFlags(args)} --full\` to list every subscription`);
  if (partial) help.push(NATIVE_LIST_INCOMPLETE);
  if (inScope.size === 0) help.push("Narrow the scope with `--subscription <id>` on any command");

  const count = partial
    ? shown.length < rows.length
      ? `${shown.length} of ${rows.length}+ subscriptions`
      : `${shown.length}+ subscriptions`
    : countLine(shown.length, rows.length, "subscriptions");

  return {
    profile: profile.name,
    count,
    subscriptions: pickFields(shown, flagList(args, "fields")),
    ...(help.length > 0 ? { help } : {}),
  };
}
