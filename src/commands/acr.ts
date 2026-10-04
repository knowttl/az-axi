import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagList, flagNumber, flagText, parseArgs } from "../lib/args.js";
import { requestAcrMetadata } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { emptyState, pickFields } from "../lib/format.js";
import { commandFlags, commandMeta } from "../lib/registry.js";
import { acrLeafHelp } from "../lib/acrHelp.js";
import { formatFlagValue } from "../lib/shell.js";

export const meta = commandMeta("acr");

const REPOSITORY_FIELDS = ["name"];
const TAG_FIELDS = ["name", "digest", "createdTime", "lastUpdateTime"];
const MANIFEST_FIELDS = ["digest", "mediaType", "schemaVersion", "config", "layers", "manifests"];

export async function run(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const [group, verb] = args.positionals;
  const path = `acr ${group} ${verb}`;
  if (args.positionals.length !== 2 ||
      (group === "repository" && verb !== "list" && verb !== "show-tags") ||
      (group === "manifest" && verb !== "show-metadata") ||
      (group !== "repository" && group !== "manifest")) {
    throw new AxiError("expected acr repository list|show-tags or acr manifest show-metadata", "VALIDATION_ERROR", ["Run `az-axi acr --help`"]);
  }
  assertKnownFlags(args, commandFlags(path), path, acrLeafHelp(path));
  const literal = (flag: string): string | undefined => {
    if (!(flag in args.flags)) return undefined;
    const value = args.flags[flag];
    if (typeof value !== "string" || !value.length) {
      throw new AxiError(`flag --${flag} needs a non-empty value`, "VALIDATION_ERROR", [acrLeafHelp(path)]);
    }
    return value;
  };
  const manifest = group === "manifest";
  const registry = manifest ? flagText(args, "registry") : flagText(args, "name");
  if (!registry) throw new AxiError(manifest ? "--registry is required" : "--name is required", "VALIDATION_ERROR", [acrLeafHelp(path)]);
  const showTags = group === "repository" && verb === "show-tags";
  const repository = !manifest && showTags ? flagText(args, "repository") : undefined;
  if (showTags && !repository) {
    throw new AxiError("--repository is required", "VALIDATION_ERROR", [acrLeafHelp(path)]);
  }
  // The artifact carries both selectors: repository:tag or repository@digest.
  // Login-server-qualified IDs are refused: --registry already pins the host.
  let artifactRepo: string | undefined;
  let reference: string | undefined;
  if (manifest) {
    const artifact = literal("name");
    if (!artifact) throw new AxiError("--name is required", "VALIDATION_ERROR", [acrLeafHelp(path)]);
    const at = artifact.indexOf("@");
    const cut = at >= 0 ? at : artifact.lastIndexOf(":");
    artifactRepo = cut < 0 ? undefined : artifact.slice(0, cut);
    reference = cut < 0 ? undefined : artifact.slice(cut + 1);
    if (!artifactRepo || !reference) {
      throw new AxiError("--name must be repository:tag or repository@digest", "VALIDATION_ERROR", [acrLeafHelp(path)]);
    }
    if (artifactRepo.includes("://") || /^[^/]+\.azurecr\.io\//i.test(artifactRepo)) {
      throw new AxiError("--name takes repository:tag or repository@digest, not a login-server-qualified ID", "VALIDATION_ERROR", [acrLeafHelp(path)]);
    }
  }
  const orderby = showTags ? flagText(args, "orderby") : undefined;
  if (args.flags.orderby !== undefined && orderby !== "time_asc" && orderby !== "time_desc") {
    throw new AxiError("--orderby must be time_asc or time_desc", "VALIDATION_ERROR", [acrLeafHelp(path)]);
  }
  const order = orderby === "time_asc" || orderby === "time_desc" ? orderby : undefined;
  const limit = manifest ? 50 : flagNumber(args, "limit") ?? 50;
  if (!manifest && (args.flags.limit === true || !Number.isInteger(limit) || limit < 1 || limit > 1000)) {
    throw new AxiError("--limit must be an integer from 1 to 1000", "VALIDATION_ERROR", ["Example: --limit 50"]);
  }
  if (manifest && args.flags.limit !== undefined) {
    throw new AxiError("--limit does not apply to acr manifest show-metadata", "VALIDATION_ERROR", [acrLeafHelp(path)]);
  }
  const fields = flagList(args, "fields");
  const safe = manifest ? MANIFEST_FIELDS : verb === "list" ? REPOSITORY_FIELDS : TAG_FIELDS;
  if (fields?.some((field) => !safe.includes(field))) {
    throw new AxiError("--fields accepts only safe acr properties", "VALIDATION_ERROR", [`Valid fields: ${safe.join(",")}`]);
  }
  const page = await requestAcrMetadata(profileFromArgs(args), {
    op: manifest ? "manifest-show" : verb === "list" ? "repository-list" : "tag-list",
    registry, repository: manifest ? artifactRepo : repository ?? undefined, reference,
    limit, last: manifest ? undefined : literal("marker"),
    ...(order ? { orderby: order } : {}),
  });
  if (manifest) {
    return {
      registry, repository: artifactRepo, reference,
      manifest: pickFields([page.rows[0] ?? {}], fields)[0],
    };
  }
  const noun = verb === "list" ? "repositories" : "tags";
  const target = `${formatFlagValue("name", registry)}${repository ? ` ${formatFlagValue("repository", repository)}` : ""}`;
  const selectors = ["profile", "tenant", "config"].flatMap((flag) => {
    const value = args.flags[flag];
    return typeof value === "string" ? [` ${formatFlagValue(flag, value)}`] : [];
  }).join("");
  const next = showTags && orderby ? ` ${formatFlagValue("orderby", orderby)}` : "";
  const rows = pickFields(page.rows, fields);
  return {
    registry, ...(repository ? { repository } : {}),
    count: `${page.rows.length}${page.nextMarker ? "+" : ""} ${noun}`,
    [noun]: page.rows.length ? rows : emptyState(noun, `in ${repository ?? registry}${page.nextMarker ? " on this page" : ""}`),
    ...(page.nextMarker
      ? { nextMarker: page.nextMarker, help: [`Run \`az-axi ${path} ${target}${selectors}${next} --limit ${limit} ${formatFlagValue("marker", page.nextMarker)}\` for the next page`] }
      : page.rows.length
        ? { help: [verb === "list"
          ? `Run \`az-axi acr repository show-tags ${target}${selectors} --repository <repository>\` for tags`
          : `Run \`az-axi acr manifest show-metadata ${formatFlagValue("registry", registry)} ${formatFlagValue("name", `${repository}:<tag>`)}${selectors}\` for manifest metadata`] }
        : {}),
  };
}
