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
  const name = key.toLowerCase().replace(/[-_]/g, "");
  return name === "sas" || name === "authorization" || SECRET_KEY_PARTS.some((part) => name.includes(part)) || KEY_SUFFIX.test(name);
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
  const isSecretParameter =
    (parentKey !== undefined && isSecretKeyName(parentKey)) ||
    (typeof record.type === "string" && /^(secureString|secureObject)$/i.test(record.type));
  // Pair objects and values nested under secret-named parameters.
  const isSecretPair =
    "value" in record &&
    ("keyName" in record ||
      isSecretParameter ||
      ("name" in record && (parentKey === "passwords" || parentKey === "keys")));

  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => {
      const redactChild =
        (key === "value" && isSecretPair) ||
        ((key === "defaultValue" || key === "allowedValues") && isSecretParameter) ||
        (typeof child === "string" && isSecretKeyName(key));
      return [key, redactChild ? REDACTED : walk(child, key)];
    }),
  );
}
