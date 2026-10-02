/** Secret redaction applied to all command output (PLAN.md Section 6.13.8). */
export const REDACTED = "***redacted***";

const SECRET_KEY_PARTS = ["password", "secret", "token", "connectionstring", "credential", "sasuri", "sasurl"];
/** `primaryKey`, `accountKey` ...: a name ending in "key"/"keys" with a prefix (a bare `key` is not secret). */
const KEY_SUFFIX = /[a-z0-9](key|keys)$/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /AccountKey=/i,
  /SharedAccessKey=/i,
  /SharedAccessSignature/i,
  /[?&]sig=/i,
  /-----BEGIN/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/,
];

function isSecretKeyName(key: string): boolean {
  const name = key.toLowerCase();
  return name === "sas" || SECRET_KEY_PARTS.some((part) => name.includes(part)) || KEY_SUFFIX.test(key);
}

function isSecretString(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Returns a deep copy with secrets replaced by `***redacted***`. Input is not mutated. */
export function redact<T>(value: T): T {
  return walk(value, undefined) as T;
}

function walk(value: unknown, parentKey: string | undefined): unknown {
  if (typeof value === "string") return isSecretString(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, parentKey));
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const record = value as Record<string, unknown>;
  // Pair objects: {keyName, value} anywhere, {name, value} inside a `passwords` or `keys` array.
  const isSecretPair =
    "value" in record &&
    ("keyName" in record || ("name" in record && (parentKey === "passwords" || parentKey === "keys")));

  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => {
      const redactChild =
        (key === "value" && isSecretPair) || (typeof child === "string" && isSecretKeyName(key));
      return [key, redactChild ? REDACTED : walk(child, key)];
    }),
  );
}
