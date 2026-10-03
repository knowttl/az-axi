const VALUE_FLAGS = new Set([
  "profile",
  "tenant",
  "subscription",
  "management-group",
  "config",
  "fields",
  "limit",
]);

const BOOLEAN_FLAGS = new Set(["full"]);

/**
 * The SDK requires `<bin> <command> ...flags`. Agents naturally write
 * `az-axi --profile work rg query ...`, so leading selector flags are moved behind
 * the command instead of being rejected. With no command they stay put and the
 * home view receives them.
 */
export function normalizeArgv(argv: readonly string[]): string[] {
  const leading: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("-")) break;
    const name = arg.startsWith("--") ? arg.slice(2).split("=")[0] ?? "" : arg === "-s" ? "subscription" : "";
    const takesValue = VALUE_FLAGS.has(name);
    if (!takesValue && !BOOLEAN_FLAGS.has(name)) break;
    leading.push(arg);
    index++;
    if (takesValue && !arg.includes("=")) {
      const value = argv[index];
      if (value !== undefined && !value.startsWith("-")) {
        leading.push(value);
        index++;
      }
    } else if (!takesValue && !arg.includes("=") && /^(true|false)$/.test(argv[index] ?? "")) {
      leading.push(argv[index++]!);
    }
  }
  const rest = argv.slice(index);
  if (leading.length === 0) return [...argv];
  if (rest.length === 0) return ["home", ...leading];
  return [rest[0] as string, ...rest.slice(1), ...leading];
}
