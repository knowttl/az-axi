import { AxiError } from "axi-sdk-js";
import { flagBool, GLOBAL_FLAG_SCHEMA, parseLeafArgs } from "./args.js";
import { COMMAND_LEAVES, COMMAND_HELP, leafHelp, type CommandLeaf } from "./registry.js";

/** Resolve only registered full paths. Prefixes never select an operation. */
export function routeArgv(argv: readonly string[]): { argv: string[]; help?: string } {
  // Passthrough owns exact catalogue argument validation; do not normalize or
  // coalesce aliases before its duplicate and unsupported-global checks.
  if (argv[0] === "az") {
    if (argv.length === 2 && /^(--help|-h)$/.test(argv[1]!) || argv.slice(1, 3).join(" ") === "group show" && argv.some((arg) => /^(--help|-h)$/.test(arg))) {
      return { argv: [...argv], help: COMMAND_HELP.az };
    }
    return { argv: [...argv] };
  }
  if (!argv.length || argv.length === 1 && /^(--help|-h|-v|-V|--version)$/.test(argv[0]!)) {
    return { argv: argv[0] === "-h" ? ["--help"] : [...argv] };
  }
  const routes = COMMAND_LEAVES.flatMap((leaf: CommandLeaf) =>
    [leaf.path, ...leaf.aliases ?? []].map((path) => ({ path, leaf, words: path.split(" ") })),
  );
  const matches = routes.filter(({ words }) => words.every((word, index) => argv[index] === word))
    .sort((a, b) => b.words.length - a.words.length);
  const selected = matches[0];
  if (!selected) {
    const group = argv[0]!;
    const children = routes.filter(({ words }) => words[0] === group);
    if (!children.length) return { argv: [...argv] };
    if (argv.length === 2 && /^(--help|-h)$/.test(argv[1]!)) {
      return { argv: [...argv], help: Object.hasOwn(COMMAND_HELP, group) ? COMMAND_HELP[group] : children.map(({ leaf, path }) => leafHelp(leaf, path)).join("\n\n") };
    }
    throw new AxiError(`missing or unknown command path \`${argv.join(" ")}\``, "VALIDATION_ERROR", [
      `Expected an exact leaf: ${children.map(({ path }) => path).join(" | ")}`,
    ]);
  }
  const { leaf, path, words } = selected;
  const help = leafHelp(leaf, path);
  const canonical = path === leaf.path && leaf.handlerPath !== undefined;
  const flagAliases = path === leaf.path ? { ...leaf.canonicalFlagAliases, ...(path === "graph query" ? { subscription: "subscriptions" } : {}) } : leaf.aliasFlags;
  const schema = { ...GLOBAL_FLAG_SCHEMA, ...leaf.flags, ...(canonical ? leaf.canonicalFlags : {}) };
  const args = parseLeafArgs(argv.slice(words.length), schema, path, help, flagAliases, leaf.positionalInput && !canonical);
  if (flagBool(args, "help")) return { argv: [...argv], help };
  if (canonical) {
    const queryFlag = path === "graph query" ? "graph-query" : "analytics-query";
    if (args.positionals.length || args.flags[queryFlag] && args.flags.file) {
      throw new AxiError(`use exactly one query source: --${queryFlag}, --file or stdin`, "VALIDATION_ERROR", [help]);
    }
    if (args.flags[queryFlag]) {
      args.positionals.push(String(args.flags[queryFlag]));
      delete args.flags[queryFlag];
    }
    if (args.flags.subscriptions) {
      args.flags.subscription = args.flags.subscriptions;
      delete args.flags.subscriptions;
    }
    if ((args.flags["management-groups"] || args.flags["management-group"]) && args.flags.subscription || args.flags["management-groups"] && args.flags["management-group"]) {
      throw new AxiError("explicit subscription and management-group scope flags are mutually exclusive", "VALIDATION_ERROR", [help]);
    }
  }
  const legacy = (leaf.handlerPath ?? leaf.path).split(" ");
  // Re-encode normalized flags for the unchanged native handler. `--` protects
  // literal positional input, including KQL or paths that start with a dash.
  return { argv: [
    ...legacy,
    ...Object.entries(args.flags).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map((entry) => `--${name}=${entry}`)),
    "--", ...args.positionals,
  ] };
}
