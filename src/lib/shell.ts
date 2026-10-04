export function quoteFlagValue(value: string): string {
  if (/^[a-zA-Z0-9_./:=,+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function formatFlagValue(name: string, value: string): string {
  return `--${name}${value.startsWith("-") ? "=" : " "}${quoteFlagValue(value)}`;
}
