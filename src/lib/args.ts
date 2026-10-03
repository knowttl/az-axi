import { AxiError } from "axi-sdk-js";

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export type FlagSchema = Readonly<Record<string, "value" | "boolean" | "list">>;
export const GLOBAL_FLAG_SCHEMA: FlagSchema = {
  profile: "value", tenant: "value", subscription: "list", "management-group": "value",
  config: "value", help: "boolean", full: "boolean", fields: "list", limit: "value",
};
const SHORT_FLAGS: Record<string, string> = {
  h: "help", s: "subscription", g: "resource-group", n: "name", w: "workspace", t: "timespan",
};

/** Validate the exact leaf before loading handlers, credentials or transport. */
export function parseLeafArgs(argv: readonly string[], schema: FlagSchema, command: string, help: string, aliases: Readonly<Record<string, string>> = {}, positionalInput = false): ParsedArgs {
  const flags: ParsedArgs["flags"] = Object.create(null);
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const [raw, ...inline] = arg.replace(/^--?/, "").split("=");
    if (!arg.startsWith("--") && !Object.hasOwn(SHORT_FLAGS, raw!)) {
      throw new AxiError(`unknown or ambiguous short flag ${arg} for \`${command}\``, "UNKNOWN_FLAG", [help]);
    }
    const expanded = arg.startsWith("--") ? raw! : Object.hasOwn(SHORT_FLAGS, raw!) ? SHORT_FLAGS[raw!]! : raw!;
    const name = Object.hasOwn(aliases, expanded) ? aliases[expanded]! : expanded;
    const kind = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (!kind) {
      assertKnownFlags({ flags: { [name]: true }, positionals: [] }, Object.keys(schema), command, help);
      throw new AxiError(`unknown flag ${arg} for \`${command}\``, "UNKNOWN_FLAG", [help]);
    }
    let value: string | boolean;
    if (kind === "boolean") {
      const next = argv[i + 1];
      const explicit = inline.length ? inline.join("=") : next === "true" || next === "false" ? argv[++i] : undefined;
      if (explicit !== undefined && explicit !== "true" && explicit !== "false") {
        throw new AxiError(`flag --${name} expects true or false`, "VALIDATION_ERROR", [help]);
      }
      value = explicit !== "false";
    } else {
      const values: string[] = inline.length ? [inline.join("=")] : [];
      if (!inline.length) {
        while (argv[i + 1] !== undefined && (!argv[i + 1]!.startsWith("-") || /^-\d/.test(argv[i + 1]!))) {
          values.push(argv[++i]!);
          if (kind === "value" || positionalInput) break;
        }
      }
      if (!values.length || values.some((v) => !v.trim())) {
        throw new AxiError(`flag --${name} needs a non-empty value`, "VALIDATION_ERROR", [help]);
      }
      value = kind === "list" ? values.join(",") : values[0]!;
      if (kind === "list" && !value.split(",").some((part) => part.trim())) {
        throw new AxiError(`flag --${name} needs a non-empty value`, "VALIDATION_ERROR", [help]);
      }
    }
    if (Object.hasOwn(flags, name)) {
      if (kind === "list") value = `${flags[name]},${value}`;
      else if (flags[name] !== value) {
        throw new AxiError(`conflicting values for --${name}`, "VALIDATION_ERROR", [help]);
      }
    }
    flags[name] = value;
  }
  return { flags, positionals };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    let key: string;
    let value: string | boolean;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    flags[key] = value;
  }
  return { flags, positionals };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

/**
 * A value flag. Absent is `undefined`. Present without a value, or blank, is a
 * VALIDATION_ERROR so an agent cannot silently drop a filter.
 */
export function flagText(args: ParsedArgs, name: string): string | undefined {
  if (!(name in args.flags)) return undefined;
  const value = args.flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AxiError(`flag --${name} needs a non-empty value`, "VALIDATION_ERROR", [
      `Example: --${name} <value>`,
    ]);
  }
  return value.trim();
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags[name];
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new AxiError(`flag --${name} expects a number, got '${v}'`, "VALIDATION_ERROR", [
      `Example: --${name} 20`,
    ]);
  }
  return n;
}

export function flagList(args: ParsedArgs, name: string): string[] | undefined {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Flags accepted by every command, never reported as unknown. */
export const GLOBAL_FLAGS = [
  "profile",
  "tenant",
  "subscription",
  "management-group",
  "config",
  "help",
  "full",
  "fields",
  "limit",
] as const;

const RENAMED: Record<string, string> = {
  sub: "subscription",
  subscriptions: "subscription",
  mg: "management-group",
  top: "limit",
  count: "limit",
  max: "limit",
  ws: "workspace",
};

export function assertKnownFlags(
  args: ParsedArgs,
  known: readonly string[],
  commandName: string,
  helpText?: string,
): void {
  const knownSet = new Set<string>([...known, ...GLOBAL_FLAGS]);
  for (const key of Object.keys(args.flags)) {
    if (knownSet.has(key)) continue;
    const replacement = RENAMED[key];
    const suggestions = replacement
      ? [`--${key} is not a flag here; use --${replacement} instead`]
      : [`Valid flags for \`${commandName}\`: ${[...knownSet].map((k) => `--${k}`).join(", ")}`];
    if (helpText) suggestions.push(helpText);
    throw new AxiError(`unknown flag --${key} for \`${commandName}\``, "UNKNOWN_FLAG", suggestions);
  }
}
