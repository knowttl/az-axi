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
