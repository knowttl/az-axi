import { AxiError } from "axi-sdk-js";
import { DEFENDER_ALERTS, SUBSCRIPTIONS_LIST } from "../lib/apiVersions.js";
import { assertKnownFlags, flagBool, flagText, parseArgs } from "../lib/args.js";
import { buildUrl, requestAll } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { dryRun } from "../lib/dryRun.js";
import { executeWrite } from "../lib/execute.js";
import { enforceGates } from "../lib/gates.js";
import { parseTimeoutFlag } from "../lib/lro.js";
import { assertReadOnlyBoundary, classifyRequest } from "../lib/policy.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("security");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: Record<string, string> = { dismiss: "Dismissed", resolve: "Resolved", activate: "Active" };
const PROTECTION = "Defender alert actions do not document ETag/If-Match protection; no concurrency guarantee";

function segment(value: string | undefined, flag: string): string {
  if (!value || /[/\\%?#,]/.test(value) || value === "." || value === "..") {
    throw new AxiError(`--${flag} must name one resource path segment`, "VALIDATION_ERROR", [
      `Pass --${flag} <name> from the alert resource ID`,
    ]);
  }
  return encodeURIComponent(value);
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, commandFlags("security alert update"), "security alert update");
  if (args.positionals.join(" ") !== "alert update") {
    throw new AxiError("expected `security alert update` with no positional arguments", "VALIDATION_ERROR", [
      "Run `az-axi security alert update --help`",
    ]);
  }
  const location = segment(flagText(args, "location"), "location");
  const name = segment(flagText(args, "name"), "name");
  const group = flagText(args, "resource-group");
  const rgPath = group === undefined ? "" : `/resourceGroups/${segment(group, "resource-group")}`;
  const action = flagText(args, "status")?.toLowerCase();
  if (!action || !Object.hasOwn(STATUSES, action)) {
    throw new AxiError("--status must be dismiss, resolve or activate", "VALIDATION_ERROR", [
      "Run `az-axi security alert update --help`",
    ]);
  }
  if (flagText(args, "management-group")) {
    throw new AxiError("alert updates require one subscription, not a management group", "VALIDATION_ERROR", [
      "Pass --subscription <id>",
    ]);
  }
  const ifMatch = flagText(args, "if-match");
  const timeoutMs = parseTimeoutFlag(flagText(args, "timeout"));
  const profile = profileFromArgs(args);
  if (profile.subscriptions?.length !== 1) {
    throw new AxiError("alert updates require exactly one subscription", "VALIDATION_ERROR", [
      "Pass --subscription <id-or-name>; batches are not supported",
    ]);
  }
  let subscription = profile.subscriptions[0]!;
  if (!GUID.test(subscription)) {
    const { items } = await requestAll<{ subscriptionId: string; displayName: string }>(profile, {
      path: "/subscriptions", apiVersion: SUBSCRIPTIONS_LIST,
    });
    const matches = items.filter((item) => item.displayName.toLowerCase() === subscription.toLowerCase());
    if (matches.length !== 1 || !GUID.test(matches[0]!.subscriptionId)) {
      throw new AxiError("subscription name must match exactly one accessible subscription", "VALIDATION_ERROR", [
        "Pass a subscription ID from `az-axi sub list`",
      ]);
    }
    subscription = matches[0]!.subscriptionId;
  }
  const path = `/subscriptions/${subscription}${rgPath}/providers/Microsoft.Security/locations/${location}/alerts/${name}/${action}`;
  const shape = { resource: "arm" as const, method: "POST", path };
  const cls = classifyRequest(shape);
  assertReadOnlyBoundary(shape, cls);
  const execute = enforceGates(profile, shape, cls, { execute: flagBool(args, "execute") });
  const selectors = ["profile", "tenant", "config"]
    .map((key) => flagText(args, key) === undefined ? "" : formatFlagValue(key, flagText(args, key)!))
    .filter(Boolean).join(" ");
  const desiredState = { properties: { status: STATUSES[action] } };
  if (execute) {
    return executeWrite({ profile, method: "POST", path: buildUrl({ path, apiVersion: DEFENDER_ALERTS }),
      cls: "write", body: undefined, desiredState, protection: PROTECTION, ifMatch,
      selectors, timeoutMs, noWait: flagBool(args, "no-wait") });
  }
  const preview = await dryRun({ profile, resource: "arm", method: "POST", path, cls,
    body: undefined, desiredState, apiVersion: DEFENDER_ALERTS, ifMatch, selectors });
  const command = ["az-axi security alert update", selectors, formatFlagValue("subscription", subscription),
    formatFlagValue("location", flagText(args, "location")!), formatFlagValue("name", flagText(args, "name")!),
    formatFlagValue("status", action), ...(group === undefined ? [] : [formatFlagValue("resource-group", group)]),
    ...(ifMatch === undefined ? [] : [formatFlagValue("if-match", ifMatch)]),
    ...(flagText(args, "timeout") === undefined ? [] : [formatFlagValue("timeout", flagText(args, "timeout")!)]),
    ...(flagBool(args, "no-wait") ? ["--no-wait"] : []), "--execute"].filter(Boolean).join(" ");
  return { ...preview, protection: PROTECTION, help: [`\`${command}\``] };
}
