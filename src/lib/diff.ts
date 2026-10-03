/** Field-level diff for dry runs (PLAN.md Section 6.13.3). Pure module: no I/O. */
import { redact } from "./redact.js";

export const MAX_CHANGES = 20;

export interface FieldChange {
  /** Dot path, for example `tags.env`; arrays are compared as whole values. */
  path: string;
  from: unknown;
  /** `undefined` when the body removes the field. */
  to: unknown;
}

export interface ResourceDiff {
  /** First `MAX_CHANGES` rows, in body order then current-state order for removals. */
  changes: FieldChange[];
  /** Changes beyond the cap. */
  remaining: number;
  /** True when the body would change nothing. */
  noop: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

/** Structural equality for JSON values. Key order never matters. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => valuesEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => Object.hasOwn(b, key) && valuesEqual(a[key], b[key]));
  }
  return false;
}

/** Leaf changes for paths present in `body`. PATCH and the changed half of PUT. */
function changedPaths(
  current: unknown,
  body: unknown,
  shownCurrent: unknown,
  shownBody: unknown,
  base: string,
  out: FieldChange[],
): void {
  if (isRecord(body) && isRecord(current)) {
    for (const key of Object.keys(body)) {
      changedPaths(
        Object.hasOwn(current, key) ? current[key] : undefined,
        body[key],
        Object.hasOwn(current, key) ? (shownCurrent as Record<string, unknown>)[key] : undefined,
        (shownBody as Record<string, unknown>)[key],
        joinPath(base, key),
        out,
      );
    }
    return;
  }
  if (!valuesEqual(current, body)) out.push({ path: base, from: shownCurrent, to: shownBody });
}

/** Leaf paths in `current` that `body` drops. */
function removedPaths(current: unknown, body: unknown, shownCurrent: unknown, base: string, out: FieldChange[]): void {
  if (isRecord(current) && isRecord(body)) {
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(body, key)) {
        removedLeaves(current[key], (shownCurrent as Record<string, unknown>)[key], joinPath(base, key), out);
      } else {
        removedPaths(current[key], body[key], (shownCurrent as Record<string, unknown>)[key], joinPath(base, key), out);
      }
    }
  }
}

function removedLeaves(value: unknown, shownValue: unknown, base: string, out: FieldChange[]): void {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0) {
      for (const key of keys) removedLeaves(value[key], (shownValue as Record<string, unknown>)[key], joinPath(base, key), out);
      return;
    }
  }
  out.push({ path: base, from: shownValue, to: undefined });
}

/**
 * Compares a PUT or PATCH body against current resource state.
 * Inputs are never mutated; displayed values are redacted.
 */
export function diffResource(current: unknown, body: unknown, method: "PUT" | "PATCH"): ResourceDiff {
  const all: FieldChange[] = [];
  const shownCurrent = redact(current);
  changedPaths(current, body, shownCurrent, redact(body), "", all);
  if (method === "PUT") removedPaths(current, body, shownCurrent, "", all);
  else if (isRecord(current) && isRecord(body) && Object.hasOwn(body, "tags")) {
    removedPaths(current.tags, body.tags, (shownCurrent as Record<string, unknown>).tags, "tags", all);
  }
  const changes = all.slice(0, MAX_CHANGES);
  return { changes, remaining: all.length - changes.length, noop: all.length === 0 };
}
