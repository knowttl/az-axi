/** Field-level diff for dry runs (PLAN.md Section 6.13.3). Pure module: no I/O. */

export const MAX_CHANGES = 20;

export interface FieldChange {
  /** Dot path with `[i]` array indices, for example `tags.env` or `properties.list[0]`. */
  path: string;
  from: unknown;
  /** `undefined` when a PUT body removes the field. */
  to: unknown;
}

export interface ResourceDiff {
  /** First `MAX_CHANGES` rows, in body order then current-state order for PUT removals. */
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
function changedPaths(current: unknown, body: unknown, base: string, out: FieldChange[]): void {
  if (isRecord(body) && isRecord(current)) {
    for (const key of Object.keys(body)) {
      changedPaths(Object.hasOwn(current, key) ? current[key] : undefined, body[key], joinPath(base, key), out);
    }
    return;
  }
  if (!valuesEqual(current, body)) out.push({ path: base, from: current, to: body });
}

/** Leaf paths in `current` that `body` drops. PUT only; PATCH leaves them alone. */
function removedPaths(current: unknown, body: unknown, base: string, out: FieldChange[]): void {
  if (isRecord(current) && isRecord(body)) {
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(body, key)) {
        removedLeaves(current[key], joinPath(base, key), out);
      } else {
        removedPaths(current[key], body[key], joinPath(base, key), out);
      }
    }
  }
}

function removedLeaves(value: unknown, base: string, out: FieldChange[]): void {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0) {
      for (const key of keys) removedLeaves(value[key], joinPath(base, key), out);
      return;
    }
  }
  out.push({ path: base, from: value, to: undefined });
}

/**
 * Compares a PUT or PATCH body against current resource state.
 * PATCH compares only paths present in the body; PUT also lists fields the
 * body would remove. Inputs are never mutated; `from`/`to` alias input values.
 */
export function diffResource(current: unknown, body: unknown, method: "PUT" | "PATCH"): ResourceDiff {
  const all: FieldChange[] = [];
  changedPaths(current, body, "", all);
  if (method === "PUT") removedPaths(current, body, "", all);
  const changes = all.slice(0, MAX_CHANGES);
  return { changes, remaining: all.length - changes.length, noop: all.length === 0 };
}
