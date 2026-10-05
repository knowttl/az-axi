import { DESCRIPTION, commandListMarkdown } from "./registry.js";
import { packageInfo } from "./version.js";

/**
 * Single source of truth for the packaged agent skill. `scripts/skill.mjs`
 * renders this into `skills/az-axi/SKILL.md` (and `--check` refuses drift),
 * so the skill never drifts from the CLI's own description and leaf registry.
 * The body carries only durable guidance; per-leaf flags, defaults and
 * examples live in each leaf's `--help` and the README sections linked below.
 */

/** Published package invoked by the skill's non-interactive command forms. */
export function skillPackage(): string {
  return packageInfo().name;
}

/** Trigger-shaped frontmatter: name plus a terse, outcome-focused description. */
export function skillFrontmatter(): string {
  return [
    "---",
    "name: az-axi",
    'description: "Read-only Azure inspection: subscriptions, resources, RBAC, activity, Defender, Sentinel, network, policy, and Log Analytics."',
    "user-invocable: false",
    "---",
    "",
  ].join("\n");
}

/** Static durable guidance with generated values interpolated; no live state. */
export function skillBody(): string {
  const pkg = skillPackage();
  const npx = `npx -y ${pkg}`;
  return [
    "# az-axi",
    "",
    `${DESCRIPTION}. Results render as token-efficient TOON on stdout, with a raw REST escape hatch (\`api\`) for everything else.`,
    "",
    `Run every command as \`${npx} ...\`: no global install needed and no interactive prompts. Never run against a real tenant in tests; use the offline suite instead.`,
    "",
    "## Start here",
    "",
    "```sh",
    `${npx}                      # dashboard: profile, identity, subscriptions, alerts, score, exposure, writes`,
    `${npx} home                 # same dashboard`,
    `${npx} doctor               # auth, reachability and write status per profile`,
    `${npx} sub list             # subscriptions visible to the identity`,
    `${npx} <complete-leaf-path> --help  # that leaf's flags, defaults and examples`,
    "```",
    "",
    "Run the dashboard first. It prints the active profile, identity, visible subscription count, active Defender alerts by severity, average and lowest secure score, exposure counts, and write status - enough to act without a second call. A failed section degrades to a hint; the rest still render.",
    "",
    "## Commands",
    "",
    "The exact current leaf registry is `src/lib/registry.ts`. Capability labels: `native` (implemented handler), `passthrough` (pinned reviewed Azure CLI read), `api-only` (reviewed raw API operation only), `blocked` (policy refusal), `unsupported` (no supported implementation or reviewed API coverage). The table below records current executable leaves and their Azure effects; it makes no coverage claim for other Azure commands. `api` has a dynamic Azure effect determined by request policy, and `config init` only writes locally.",
    "",
    "<!-- command-registry:start -->",
    commandListMarkdown(),
    "<!-- command-registry:end -->",
    "",
    `Run \`${npx} <complete-leaf-path> --help\` for that leaf's accepted flags and reference. The \`--help\` output is the complete reference for the leaf: available flags with defaults, required arguments, and examples.`,
    "",
    "## Selecting profile, scope, and tenant",
    "",
    "Native commands accept these selector flags, and they never count as unknown flags:",
    "",
    `- \`--profile <name>\` - a configured profile (\`${npx} config list\`); may also be written before the command (\`${npx} --profile work rg query ...\`), including on the bare dashboard`,
    "- `--subscription a,b` - one-off subscription scope; `--management-group <mg>` for management-group scope",
    "- `--tenant <id>` - passed through to `az` for token acquisition",
    "- `--config <path>` - one-off config file",
    "- `$AZ_AXI_PROFILE` / `$AZ_AXI_SUBSCRIPTION` / `$AZ_AXI_TENANT` / `$AZ_AXI_CONFIG` - environment overrides",
    "",
    `With no config file at all, az-axi uses an implicit \`az\` profile, so it works right after \`az login\`. \`${npx} config init --name work --auth az\` manages profiles locally and never touches Azure.`,
    "",
    "## Reads",
    "",
    "- Discovery lists default to 50 compact rows with full IDs, counts and explicit empty states. `--fields a,b` selects columns, `--full` expands truncated content and shows every fetched row, `--limit N` caps rows.",
    `- Resource Graph: \`${npx} rg query --file query.kql\` (or piped stdin); without \`--full\`, \`--limit\` maps to \`$top\` (default 50, maximum 1000). When a skip token is returned, \`help[]\` carries the exact command for the next page.`,
    `- Log Analytics: \`${npx} logs query --file hunt.kql --workspace sentinel\`; \`--workspace\` takes a profile alias or workspace GUID, \`--timespan\` defaults to \`P1D\`.`,
    `- Exposure: \`${npx} exposure --check mgmt-ports\`; default \`--check all\` returns per-check counts plus the first rows of each.`,
    `- Escape hatch: \`${npx} api /subscriptions --api-version 2022-12-01\`; lists with a \`value[]\` array return \`count\` plus \`value\`, \`--all\` follows \`nextLink\`. \`${npx} op status '<operation-url>'\` checks a long-running operation.`,
    "- Per-command selectors, projections, paging limits and exclusions live in each leaf's `--help` and [README.md#use](../../README.md#use).",
    "",
    "## Safe shell input",
    "",
    "Pass JSON bodies and KQL containing quotes, pipes, or other shell metacharacters through file or stdin input, never through interpolated command-line arguments:",
    "",
    "```sh",
    `${npx} rg query --file query.kql`,
    `${npx} logs query --file hunt.kql --workspace sentinel`,
    `${npx} api POST /providers/Microsoft.ResourceGraph/resources --api-version 2024-04-01 --body-file query.json`,
    "```",
    "",
    "`api` takes exactly one body source (`--body-file` or piped stdin). See [README.md#use](../../README.md#use) for the full rule.",
    "",
    "## Writes",
    "",
    "Writes are disabled by default and read-only commands never change Azure state. The write leaves are `security alert update` (alias `defender alerts update`), `sentinel incident update`, `sentinel incident comment create`, `tag update`, and `network nsg rule create` (destructive: one Deny rule, needs `--confirm <name>`).",
    "",
    "- Every write previews first (what would change, with the exact command to execute) and needs human approval on every invocation: never batch, chain, or pre-approve writes. Execution needs `--execute` (plus `--confirm`, `--if-match`, `--timeout`, `--no-wait` where documented).",
    "- The human owns write access; this skill does not describe how to enable it. Launch agents that must never write with `AZ_AXI_READ_ONLY=1`.",
    "- See [README.md#writes](../../README.md#writes) for selectors, close/classification rules, preview and no-op behavior, and ETag handling.",
    "",
    "## Conventions",
    "",
    "- Output is TOON on stdout; errors are TOON too. When present, `help` lists next steps. Never log secrets: credential-bearing values are redacted, and secret/key child resources and actions are refused before retrieval.",
    "- Exit codes: 0 success (including no-ops), 1 error, 2 usage error. See [README.md#behavior](../../README.md#behavior) for error categories and output controls.",
    "- Unknown flags are rejected by name: read the `help` line and retry once.",
    "",
  ].join("\n");
}

/** Full SKILL.md content: frontmatter plus the durable body. */
export function skillMarkdown(): string {
  return `${skillFrontmatter()}\n${skillBody()}`;
}
