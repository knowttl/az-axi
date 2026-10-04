import { AxiError } from "axi-sdk-js";
import { RESOURCE_TAGS } from "../lib/apiVersions.js";
import {
  assertKnownFlags,
  flagBool,
  flagList,
  flagText,
  parseArgs,
} from "../lib/args.js";
import { buildUrl, sendRequest } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { diffResource } from "../lib/diff.js";
import { executeWrite } from "../lib/execute.js";
import { enforceGates } from "../lib/gates.js";
import { parseTimeoutFlag } from "../lib/lro.js";
import { assertReadOnlyBoundary, classifyRequest } from "../lib/policy.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { shortenResourceId } from "../lib/scope.js";
import { formatFlagValue, quoteFlagValue } from "../lib/shell.js";

export const meta = commandMeta("tag");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_SEGMENT = /^\/subscriptions\/([^/?#]+)/i;
const TAGS_WRAPPER = /\/providers\/microsoft\.resources\/tags(?:\/|$)/i;
const OPERATIONS = { merge: "Merge", delete: "Delete" } as const;
type Operation = (typeof OPERATIONS)[keyof typeof OPERATIONS];
const PROTECTION =
  "re-read before send with If-Match compare-and-swap when the service returns an ETag; " +
  "--if-match pins a reviewed value (the Tags API documents no ETag guarantee)";

interface TagsResource {
  id?: string;
  name?: string;
  type?: string;
  etag?: string;
  properties?: { tags?: Record<string, unknown> };
}

function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR", ["Run `az-axi tag update --help`"]);
}

/** Exactly one explicit subscription GUID: names and implicit env/profile scope are refused. */
function explicitSubscription(args: ReturnType<typeof parseArgs>): string {
  if (flagText(args, "management-group")) {
    throw new AxiError("tag updates require one subscription, not a management group", "VALIDATION_ERROR", [
      "Pass --subscription <id>",
    ]);
  }
  const subs = flagList(args, "subscription");
  if (subs?.length !== 1 || !GUID.test(subs[0]!)) {
    throw new AxiError("tag updates require exactly one explicit subscription ID", "VALIDATION_ERROR", [
      "Pass --subscription <id> from `az-axi sub list`; names and batches are not supported",
      "Run `az-axi tag update --help`",
    ]);
  }
  return subs[0]!;
}

/**
 * One exact ARM scope: a resource, a resource group or the subscription itself.
 * The subscription segment must agree with --subscription; the tags wrapper,
 * query strings and subscriptionless scopes are refused.
 */
function parseScope(raw: string | undefined, subscription: string): string {
  if (raw === undefined) invalid("tag update needs --resource-id <ARM-id>");
  const id = raw.trim();
  if (!id.startsWith("/")) invalid("--resource-id must be the full ARM ID from the leading slash");
  if (/[?#]/.test(id)) invalid("--resource-id takes a bare ARM ID without query or fragment");
  const scope = id.replace(/\/+$/, "");
  if (!scope) invalid("--resource-id must be the full ARM ID from the leading slash");
  if (TAGS_WRAPPER.test(scope)) {
    invalid("--resource-id takes the tagged scope, not its Microsoft.Resources/tags wrapper");
  }
  const match = SUBSCRIPTION_SEGMENT.exec(scope);
  if (!match || !GUID.test(match[1]!)) {
    invalid("--resource-id must start with /subscriptions/<id>; tenant and management-group scopes are not supported");
  }
  if (match[1]!.toLowerCase() !== subscription.toLowerCase()) {
    invalid("--resource-id conflicts with --subscription <id>");
  }
  return scope;
}

function parseOperation(raw: string | undefined): Operation {
  if (raw === undefined) invalid("tag update needs --operation merge|delete");
  const operation = OPERATIONS[raw.trim().toLowerCase() as keyof typeof OPERATIONS];
  if (!operation) {
    invalid("--operation must be merge or delete (replace rewrites the whole tag set and is not supported)");
  }
  return operation;
}

interface TagEntry {
  key: string;
  value: string;
}

/** One k=v pair per entry; duplicate keys with conflicting values are refused. */
function parseTags(raw: string[] | undefined): TagEntry[] {
  if (!raw?.length) invalid("tag update needs --tags <k=v> [k=v ...]");
  const seen = new Map<string, string>();
  for (const entry of raw) {
    const at = entry.indexOf("=");
    const key = (at < 0 ? entry : entry.slice(0, at)).trim();
    if (at < 0 || !key) invalid(`--tags entry '${entry}' must be k=v`);
    const value = entry.slice(at + 1);
    const prior = seen.get(key);
    if (prior !== undefined && prior !== value) invalid(`conflicting values for tag '${key}'`);
    seen.set(key, value);
  }
  return [...seen.entries()].map(([key, value]) => ({ key, value }));
}

function tagsOf(body: unknown): Record<string, string> {
  if (body === null || typeof body !== "object") return {};
  const tags = (body as TagsResource).properties?.tags;
  if (tags === null || typeof tags !== "object" || Array.isArray(tags)) return {};
  return Object.fromEntries(
    Object.entries(tags).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function gateSelectorFlags(args: ReturnType<typeof parseArgs>): string {
  return ["profile", "tenant", "config"]
    .map((key) => (flagText(args, key) === undefined ? "" : formatFlagValue(key, flagText(args, key)!)))
    .filter(Boolean)
    .join(" ");
}

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, commandFlags("tag update"), "tag update");
  if (args.positionals.join(" ") !== "update") {
    throw new AxiError("expected `tag update` with no other positional arguments", "VALIDATION_ERROR", [
      "Run `az-axi tag update --help`",
    ]);
  }
  const subscription = explicitSubscription(args);
  const scope = parseScope(flagText(args, "resource-id"), subscription);
  const operation = parseOperation(flagText(args, "operation"));
  const entries = parseTags(flagList(args, "tags"));
  const ifMatch = flagText(args, "if-match");
  const timeoutMs = parseTimeoutFlag(flagText(args, "timeout"));
  const noWait = flagBool(args, "no-wait");
  const timeoutRaw = flagText(args, "timeout");
  const profile = profileFromArgs(args);

  const tagsPath = `${scope}/providers/Microsoft.Resources/tags/default`;
  const shape = { resource: "arm" as const, method: "PATCH", path: tagsPath };
  const cls = classifyRequest(shape);
  assertReadOnlyBoundary(shape, cls);
  // Refuse before any transport: gates need only the subscription scope, so a
  // refused write never sends even the preview GET. The exact request is
  // re-gated by the client backstop at send time.
  const execute = enforceGates(profile, shape, cls, { execute: flagBool(args, "execute") });

  const started = Date.now();
  const selectors = gateSelectorFlags(args);
  const sentTags = Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
  const tagFlags = entries.map((entry) => formatFlagValue("tags", `${entry.key}=${entry.value}`));
  const command = (etag: string | undefined) =>
    [
      "az-axi tag update",
      selectors,
      formatFlagValue("subscription", subscription),
      formatFlagValue("resource-id", scope),
      formatFlagValue("operation", operation.toLowerCase()),
      ...tagFlags,
      ...(etag === undefined ? [] : [formatFlagValue("if-match", etag)]),
      ...(timeoutRaw === undefined ? [] : [formatFlagValue("timeout", timeoutRaw)]),
      ...(noWait ? ["--no-wait"] : []),
      "--execute",
    ]
      .filter(Boolean)
      .join(" ");
  const verifyUrl = new URL(buildUrl({ path: tagsPath, apiVersion: RESOURCE_TAGS }));
  const verify = `Verify with \`az-axi api GET ${quoteFlagValue(verifyUrl.pathname + verifyUrl.search)}${selectors ? ` ${selectors}` : ""}\``;

  // Current-state probe. A missing tags wrapper means no tags yet: merge
  // creates it, delete is already satisfied. Anything else surfaces.
  let probed: Awaited<ReturnType<typeof sendRequest<TagsResource>>> | undefined;
  try {
    probed = await sendRequest<TagsResource>(profile, {
      method: "GET",
      path: tagsPath,
      apiVersion: RESOURCE_TAGS,
    });
  } catch (error) {
    if (!(error instanceof AxiError) || error.code !== "NOT_FOUND") throw error;
    probed = undefined;
  }
  const currentTags = probed ? tagsOf(probed.body) : {};
  const etag =
    probed?.headers["etag"] ??
    (typeof probed?.body === "object" && probed?.body !== null && typeof (probed.body as TagsResource).etag === "string"
      ? (probed.body as TagsResource).etag
      : undefined);
  const effective =
    operation === "Merge"
      ? { ...currentTags, ...sentTags }
      : Object.fromEntries(Object.entries(currentTags).filter(([key]) => !(key in sentTags)));
  // The Tags PATCH carries an operation envelope, which a generic resource diff
  // would misread, so the preview diffs the tag map itself: exact per-tag
  // from/to rows with removals for delete, in dry-run output shape.
  const diff = diffResource({ tags: currentTags }, { tags: effective }, "PATCH");
  const creates = probed === undefined && operation === "Merge";
  const base = {
    dryRun: true,
    class: cls,
    method: "PATCH",
    target: shortenResourceId(scope),
    subscription,
    operation,
  };
  if (diff.noop) {
    const help = ["No field would change: executing would do nothing", `\`${command(ifMatch ?? etag)}\``];
    if (!execute) {
      return { ...base, changes: [], noop: true, ...(etag ? { etag } : {}), help };
    }
    return {
      target: shortenResourceId(scope),
      protection: PROTECTION,
      result: "already in desired state (no-op)",
      status: probed?.status ?? 404,
      requestId: probed?.requestId,
      correlationId: probed?.correlationId,
      durationSec: (Date.now() - started) / 1000,
      help: [verify],
    };
  }
  if (!execute) {
    return {
      ...base,
      changes: diff.changes,
      ...(diff.remaining > 0 ? { remaining: diff.remaining } : {}),
      ...(etag ? { etag } : {}),
      ...(creates ? { creates: true } : {}),
      protection: PROTECTION,
      help: [`\`${command(ifMatch ?? etag)}\``],
    };
  }
  return executeWrite({
    profile,
    method: "PATCH",
    path: buildUrl({ path: tagsPath, apiVersion: RESOURCE_TAGS }),
    cls: "write",
    body: { operation, properties: { tags: sentTags } },
    protection: PROTECTION,
    ifMatch,
    selectors,
    timeoutMs,
    noWait,
    // The tags wrapper 404s until the first merge creates it; a missing probe
    // then means empty current state, not a missing target.
    allowMissing: true,
  });
}
