import { AxiError } from "axi-sdk-js";

/**
 * Time parsing for `--since` and `--timespan` (PLAN.md Section 6).
 * Accepts `30m`, `24h`, `7d`, ISO 8601 durations (`P1D`, `PT24H`) and ISO dates.
 */

const RELATIVE = /^(\d+)\s*([mhd])$/i;

const ISO_DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

function invalid(value: string): never {
  throw new AxiError(`invalid time value '${value}'`, "VALIDATION_ERROR", [
    "Use a relative time like 30m, 24h or 7d",
    "Or an ISO 8601 duration like P1D, or an ISO date like 2026-09-01T00:00:00Z",
    "Example: --since 24h",
  ]);
}

/** Milliseconds for an ISO 8601 duration (years as 365d, months as 30d). */
function durationMs(value: string): number {
  const match = ISO_DURATION.exec(value.trim());
  if (!match || match[0] === "P") invalid(value);
  const [, y, mo, w, d, h, mi, s] = match as RegExpExecArray;
  const ms =
    Number(y ?? 0) * 365 * 86_400_000 +
    Number(mo ?? 0) * 30 * 86_400_000 +
    Number(w ?? 0) * 7 * 86_400_000 +
    Number(d ?? 0) * 86_400_000 +
    Number(h ?? 0) * 3_600_000 +
    Number(mi ?? 0) * 60_000 +
    Number(s ?? 0) * 1000;
  if (!(ms > 0)) invalid(value);
  return ms;
}

/**
 * Parses a `--since` value into a start `Date` relative to `now`.
 * A relative value or duration means that far back from `now`;
 * an ISO date means that exact instant.
 */
export function parseSince(value: string, now: Date = new Date()): Date {
  const text = value.trim();
  if (text === "") invalid(value);

  const relative = RELATIVE.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? "").toLowerCase();
    const ms = unit === "m" ? amount * 60_000 : unit === "h" ? amount * 3_600_000 : amount * 86_400_000;
    return new Date(now.getTime() - ms);
  }

  if (/^P/i.test(text)) return new Date(now.getTime() - durationMs(text));

  const at = Date.parse(text);
  if (!Number.isNaN(at)) return new Date(at);

  return invalid(value);
}

/** Whole days between `start` and `now`, for the 90-day retention check. */
export function ageDays(start: Date, now: Date = new Date()): number {
  return (now.getTime() - start.getTime()) / 86_400_000;
}

/** Date-only or full ISO instant. `Date.parse` also accepts prose dates; those are not timespans. */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

function timespanInvalid(value: string): never {
  throw new AxiError(`invalid --timespan '${value}'`, "VALIDATION_ERROR", [
    "Use a duration like 30m, 24h, 7d or P1D",
    "An ISO date means from that instant until now",
    "Or a start/end interval like 2026-09-01T00:00:00Z/2026-09-02T00:00:00Z",
    "Example: --timespan P1D",
  ]);
}

/** True for a positive ISO 8601 duration (`P1D`, `PT24H`). Does not throw. */
export function isIsoDuration(value: string): boolean {
  const text = value.trim();
  if (!/^P/i.test(text)) return false;
  try {
    durationMs(text);
    return true;
  } catch {
    return false;
  }
}

function isoInstant(value: string): string | undefined {
  const text = value.trim();
  if (!ISO_INSTANT.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return new Date(at).toISOString();
}

/**
 * `--timespan` to the ISO 8601 value Log Analytics accepts.
 * Relative times become durations (`24h` -> `PT24H`). An ISO date means from that
 * instant until `now`. `start/end` and `start/duration` are normalized, not rewritten
 * into a query filter.
 */
export function normalizeTimespan(value: string, now: Date = new Date()): string {
  const text = value.trim();
  if (text === "") timespanInvalid(value);

  const relative = RELATIVE.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? "").toLowerCase();
    if (!(amount > 0)) timespanInvalid(text);
    if (unit === "m") return `PT${amount}M`;
    if (unit === "h") return `PT${amount}H`;
    return `P${amount}D`;
  }

  if (isIsoDuration(text)) return text.toUpperCase();

  const slash = text.indexOf("/");
  if (slash > 0) {
    const start = isoInstant(text.slice(0, slash));
    const endRaw = text.slice(slash + 1).trim();
    if (!start) timespanInvalid(text);
    if (isIsoDuration(endRaw)) return `${start}/${endRaw.toUpperCase()}`;
    const end = isoInstant(endRaw);
    if (!end) timespanInvalid(text);
    if (Date.parse(end) <= Date.parse(start)) {
      throw new AxiError(`--timespan '${text}' ends before it starts`, "VALIDATION_ERROR", [
        "Use start/end in chronological order",
        "Example: --timespan 2026-09-01/2026-09-02",
      ]);
    }
    return `${start}/${end}`;
  }

  const instant = isoInstant(text);
  if (!instant) timespanInvalid(text);
  if (Date.parse(instant) >= now.getTime()) {
    throw new AxiError(`--timespan '${text}' is not in the past`, "VALIDATION_ERROR", [
      "An ISO date means from that instant until now",
      "Use a start/end interval to query a closed window",
      "Example: --timespan 2026-09-01T00:00:00Z/2026-09-02T00:00:00Z",
    ]);
  }
  return `${instant}/${now.toISOString()}`;
}
