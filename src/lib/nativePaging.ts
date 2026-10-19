import { AxiError } from "axi-sdk-js";
import { flagBool, flagText, type FlagSchema, type ParsedArgs } from "./args.js";
import { formatFlagValue } from "./shell.js";

export const NATIVE_LIST_FLAGS = { all: "boolean", "max-rows": "value" } as const satisfies FlagSchema;
export const NATIVE_LIST_MAX_PAGES = 100;
const DEFAULT_MAX_ROWS = 1000;
const ALL_MAX_ROWS = 10000;
const MAX_ROWS = 100000;

export interface NativeListBudget {
  maxRows: number;
  maxPages: number;
}

export const DEFAULT_NATIVE_LIST_BUDGET: NativeListBudget = { maxRows: DEFAULT_MAX_ROWS, maxPages: NATIVE_LIST_MAX_PAGES };

export const NATIVE_LIST_HELP = `Fetch budget per subscription: ${DEFAULT_MAX_ROWS} rows by default; --all raises it to ${ALL_MAX_ROWS}. --max-rows <1..${MAX_ROWS}> overrides either row budget. Every walk stops at ${NATIVE_LIST_MAX_PAGES} pages. Budgets count rows before local filters. --limit controls display only (default 50); --full shows every fetched row and expands display only, never bypassing fetch budgets. Incomplete totals are lower bounds; narrow the scope or raise --max-rows to search further.`;
export const NATIVE_LIST_INCOMPLETE = "Fetch budget reached; counts are lower bounds. Narrow the scope or raise --max-rows (or use --all). --full changes display only.";

/** Walk opaque service markers without exposing a marker that skips omitted rows. */
export async function nativeMarkerList<T>(
  budget: NativeListBudget,
  marker: string | undefined,
  fetchPage: (limit: number, marker?: string) => Promise<{ rows: T[]; nextMarker?: string }>,
): Promise<{ rows: T[]; nextMarker?: string; incomplete: boolean }> {
  const rows: T[] = [];
  const seen = new Set<string>();
  if (marker) seen.add(marker);
  for (let page = 0; page < budget.maxPages; page++) {
    const remaining = budget.maxRows - rows.length;
    const result = await fetchPage(Math.min(1000, remaining), marker);
    rows.push(...result.rows.slice(0, remaining));
    if (result.rows.length > remaining) return { rows, incomplete: true };
    marker = result.nextMarker;
    if (!marker) return { rows, incomplete: false };
    if (seen.has(marker)) return { rows, incomplete: true };
    seen.add(marker);
    if (rows.length === budget.maxRows) return { rows, nextMarker: marker, incomplete: true };
  }
  return { rows, nextMarker: marker, incomplete: true };
}

/** Display-expansion hints must preserve the original fetch budget. */
export function nativeListFetchFlags(args: ParsedArgs): string {
  return ["all", "max-rows"].filter((key) => args.flags[key] !== undefined)
    .map((key) => ` ${formatFlagValue(key, String(args.flags[key]))}`).join("");
}

/** Validate before discovery or credentials, independently of display controls. */
export function nativeListBudget(args: ParsedArgs): NativeListBudget {
  const all = args.flags.all;
  if (all !== undefined && all !== true && all !== false && all !== "true" && all !== "false") {
    throw new AxiError("--all expects true or false", "VALIDATION_ERROR", [NATIVE_LIST_HELP]);
  }
  const raw = flagText(args, "max-rows");
  const maxRows = raw === undefined ? flagBool(args, "all") ? ALL_MAX_ROWS : DEFAULT_MAX_ROWS : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) {
    throw new AxiError(`--max-rows must be an integer from 1 to ${MAX_ROWS}`, "VALIDATION_ERROR", [NATIVE_LIST_HELP]);
  }
  return { maxRows, maxPages: NATIVE_LIST_MAX_PAGES };
}
