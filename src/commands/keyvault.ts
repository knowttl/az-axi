import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, flagText, parseArgs } from "../lib/args.js";
import { requestKeyVaultMetadata, type KeyVaultKind } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { emptyState, pickFields } from "../lib/format.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { keyvaultLeafHelp } from "../lib/keyvaultHelp.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("keyvault");

const NOUNS: Record<KeyVaultKind, string> = { secret: "secrets", key: "keys", certificate: "certificates" };
const SAFE_FIELDS: Record<KeyVaultKind, string[]> = {
  secret: ["name", "enabled", "expiresOn", "notBefore", "created", "updated", "contentType", "managed"],
  key: ["name", "enabled", "expiresOn", "notBefore", "created", "updated", "managed"],
  certificate: ["name", "enabled", "expiresOn", "notBefore", "created", "updated", "thumbprint", "managed"],
};

const EXPIRY_WINDOW = /^(\d+)\s*([mhd])$/i;

function expiryWindowMs(value: string, help: string): number {
  const match = EXPIRY_WINDOW.exec(value.trim());
  if (!match) {
    throw new AxiError("--expiring-within must be a positive duration like 30d", "VALIDATION_ERROR", [help]);
  }
  const amount = Number(match[1]);
  const ms = match[2]!.toLowerCase() === "m" ? amount * 60_000 : match[2]!.toLowerCase() === "h" ? amount * 3_600_000 : amount * 86_400_000;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new AxiError("--expiring-within must be a positive duration like 30d", "VALIDATION_ERROR", [help]);
  }
  return ms;
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const [kind, verb] = args.positionals;
  const path = `keyvault ${kind} ${verb}`;
  if ((kind !== "secret" && kind !== "key" && kind !== "certificate") ||
      verb !== "list" || args.positionals.length !== 2) {
    throw new AxiError("expected keyvault secret|key|certificate list", "VALIDATION_ERROR", ["Run `az-axi keyvault --help`"]);
  }
  assertKnownFlags(args, commandFlags(path), path, keyvaultLeafHelp(path));
  const help = keyvaultLeafHelp(path);
  const vault = flagText(args, "vault-name");
  if (!vault) throw new AxiError("--vault-name is required", "VALIDATION_ERROR", [help]);
  const limit = flagNumber(args, "limit") ?? 50;
  if (args.flags.limit === true || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new AxiError("--limit must be an integer from 1 to 1000", "VALIDATION_ERROR", ["Example: --limit 50"]);
  }
  const fields = flagList(args, "fields");
  const safe = SAFE_FIELDS[kind as KeyVaultKind];
  if (fields?.some((field) => !safe.includes(field))) {
    throw new AxiError("--fields accepts only safe key vault properties", "VALIDATION_ERROR", [`Valid fields: ${safe.join(",")}`]);
  }
  const expiring = flagText(args, "expiring-within");
  const expiringWithinMs = expiring === undefined ? undefined : expiryWindowMs(expiring, help);
  const page = await requestKeyVaultMetadata(profileFromArgs(args), {
    kind: kind as KeyVaultKind, vault, limit, expiringWithinMs,
  });
  const noun = NOUNS[kind as KeyVaultKind];
  const scope = expiring ? ` expiring within ${expiring.trim()}` : "";
  // Minimal default list schema (AXI): full safe properties via --fields or --full.
  const columns = fields ?? (flagBool(args, "full") ? undefined : ["name", "enabled", "expiresOn"]);
  const selectors = ["profile", "tenant", "config"].flatMap((flag) => {
    const value = flagString(args, flag);
    return value ? [` ${formatFlagValue(flag, value)}`] : [];
  }).join("");
  const target = formatFlagValue("vault-name", vault);
  return {
    vault, count: `${page.rows.length}${page.truncated ? "+" : ""} ${noun}${scope}`,
    [noun]: page.rows.length ? pickFields(page.rows, columns) : page.truncated
      ? `No matching ${noun} in scanned pages of ${vault}${scope}; listing incomplete`
      : emptyState(noun, `in ${vault}${scope}`),
    ...(page.truncated
      ? { help: [page.truncationReason === "scan"
        ? "Listing stopped at the 40-page scan cap; increasing --limit cannot extend the scan"
        : limit === 1000 ? "Listing incomplete at the maximum --limit of 1000"
        : `Run \`az-axi ${path} ${target}${selectors}${expiring ? ` ${formatFlagValue("expiring-within", expiring.trim())}` : ""} --limit ${Math.min(limit * 2, 1000)}\` for more rows`] }
      : page.rows.length && !flagBool(args, "full") && !fields
        ? { help: [`Run \`az-axi ${path} ${target}${selectors}${expiring ? ` ${formatFlagValue("expiring-within", expiring.trim())}` : ""} --limit ${limit} --full\` for all safe properties`] } : {}),
  };
}
