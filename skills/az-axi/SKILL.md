---
name: az-axi
description: "Inspect Azure subscriptions, resources, RBAC, activity, Defender, Sentinel, network, policy, and Log Analytics. Read-only by default, with gated writes requiring human approval and explicit execution."
user-invocable: false
---

# az-axi

Read-only Azure inspection for agents: resource inventory, RBAC, activity log, Defender for Cloud and Log Analytics. Results render as token-efficient TOON on stdout, with a raw REST escape hatch (`api`) for everything else.

Run commands as `npx -y @knowttl/az-axi ...`: no global install needed and no interactive prompts.
Version pinning is the installer's choice: use `npx -y @knowttl/az-axi@<version> ...` to select a specific release.
Never run against a real tenant in tests; use the offline suite instead.

## Investigation quickstart

Start with a known read below; reserve `--help` for a command that fails or an unfamiliar task.
Examples use a synthetic `demo` profile scoped to one subscription, with workspace alias `sentinel` mapping to its customer GUID.
Replace profile and resource selectors with the reviewed investigation scope; never widen scope to work around an access error.
All examples assume `AZ_AXI_READ_ONLY=1` in the process environment.

### Investigation reads

Each line is a complete example; optional filters are described below.
Use the installed binary in place of the non-interactive package prefix if available.

```sh
npx -y @knowttl/az-axi sub list --profile demo --fields name,id,state,inScope --limit 10
npx -y @knowttl/az-axi resource list --profile demo --resource-group rg-demo --fields name,id,type,location --limit 10
npx -y @knowttl/az-axi activity list --profile demo --since 24h --status Failed --fields time,caller,operation,status,resource --limit 10
npx -y @knowttl/az-axi rbac list --profile demo --privileged --fields principal,role,scope --limit 10
npx -y @knowttl/az-axi defender alerts --profile demo --severity High,Medium --status Active --limit 10
npx -y @knowttl/az-axi sentinel incident list --profile demo --workspace sentinel --status New,Active --limit 10
npx -y @knowttl/az-axi sentinel incident show --profile demo --workspace sentinel --name 3177
npx -y @knowttl/az-axi sentinel incident list-alert --profile demo --workspace sentinel --name 3177 --limit 10
npx -y @knowttl/az-axi sentinel incident list-entity --profile demo --workspace sentinel --name 3177 --limit 10
npx -y @knowttl/az-axi exposure --profile demo --check all --limit 5
npx -y @knowttl/az-axi rg query 'Resources' --profile demo --limit 10
npx -y @knowttl/az-axi logs query 'SigninLogs' --profile demo --workspace sentinel --timespan P1D --limit 10
```

- Inventory: `--resource-type` and `--name` match exactly; use full `id` values for later resource pivots.
- Activity: `--since` defaults to 24h and cannot exceed 90d; `--caller`, `--operation` and `--resource-group` narrow the hunt.
- RBAC: `--principal <UPN|objectId>`, `--role <name>` and `--scope <ARM-id>` narrow assignments; `--privileged` selects the four supported administrator roles.
- Defender: status defaults to Active; `--status all` includes closed alerts, `--since 7d` narrows age, and default rows include severity and alert identity.
- Sentinel: list filters include `--severity High,Medium`, `--owner <text>` and `--since 7d`; default rows include number, severity, title, status and time.
  Detail and related reads accept `--name <GUID|number>` with a workspace, or `--ids <incident-ARM-id>` alone; a workspace requires exactly one subscription.
  Related alert fields are name, alert, severity, status, time; entity fields are kind, entity, name.
- Queries: use `--file <path>` or stdin for KQL with shell metacharacters; project only needed columns and use KQL `take` or `summarize` to bound service results.
  Log Analytics requires a customer GUID or configured workspace alias, never an ARM ID; `--timespan` intersects KQL time filters.

### One-call forms and output bounds

RBAC joins role definitions and resolves principal names in one invocation; failed name resolution retains object IDs with a hint.
Exposure `--check all` combines public-ips, mgmt-ports and any-any checks with counts and rows; its default is 10 rows per check.
Sentinel `--name 3177` resolves the number and retrieves the detail, alerts or entities without a separate lookup call.
Number resolution scans the bounded incident list; a known incident GUID or ARM ID avoids that scan.
Related alerts and entities remain separate commands, not a combined incident bundle; their service responses do not paginate.

Lists normally display 50 rows; `--fields a,b` selects row columns and `--limit N` reduces display.
Native collection reads follow pages automatically: 1000 fetched rows by default, `--all` raises this to 10000, `--max-rows 1..100000` overrides it, with at most 100 pages per subscription or collection (per exposure check across scope).
Budgets apply before local filters; incomplete totals are lower bounds, not proof of absence.
`--full` expands cells and normally shows all fetched rows, so avoid it for compact lists; it never removes fetch budgets.
Resource Graph query is different: `--limit` requests one page (default 50, maximum 1000); `--full` requests 1000, and `help[]` supplies the next-page command when a skip token exists.
Log Analytics `--limit` only caps displayed rows, including with `--full`; inspect `warning` and `otherTables` for partial results and omitted tables.

### Read allowlist and state changes

The exact read paths in the example block are suitable inputs to a reviewed allowlist, with scoped selectors and query inputs reviewed separately.
RBAC, Resource Graph, Log Analytics and Sentinel related reads may use read POSTs; HTTP POST alone does not imply mutation.
Azure writes include `security alert update` (also `defender alerts update`), `sentinel incident update`, `sentinel incident comment create`, `tag update`, and `network nsg rule create`.
Generic `api` is policy-dependent and must not be allowlisted wholesale; `config init` and `setup hooks` change local files.
Write previews are outside the read allowlist; execution needs profile write gates, human approval and `--execute`, plus confirmation for destructive operations.

### Help and failures

Top-level `--help` returns the command overview, aliases, global selectors and output/write rules; group `--help` returns that family's reference; complete leaf `--help` returns accepted flags, selectors, defaults and examples.
Read the structured error and `help[]` first, then consult the failing leaf's help if needed; do not start each case by traversing help.
Output and errors are TOON on stdout; exit 0 means success (including empty results), exit 2 means usage/access refusal, and exit 1 covers other failures.

| Code or symptom | Adjustment |
| --- | --- |
| `UNKNOWN_FLAG`, `VALIDATION_ERROR` | Correct syntax or selectors; KQL diagnostics identify line/column. Do not repeat unchanged input. |
| `AUTH_REQUIRED` | Refresh the approved sign-in or external token source. |
| `FORBIDDEN`, `NOT_FOUND` | Check authorized scope, permissions and resource identity; do not retry with broader scope. |
| `TLS_ERROR`, `NETWORK_ERROR` | Repair trust/connectivity; TLS may need `NODE_EXTRA_CA_CERTS`. |
| `PROVIDER_NOT_REGISTERED` | Ask an administrator to register the named provider. |
| `RATE_LIMITED` | Honor the retry-after hint and narrow the query or timespan before retrying. |
| `API_ERROR` | For malformed responses, inspect status, contentType and the bounded shape report, then check API compatibility and intercepting proxies. Reports contain types and safe key paths only, never response values. Otherwise follow the request hint for query semantics or throttling. |
| `READ_ONLY`, `WRITES_DISABLED`, `SUBSCRIPTION_NOT_WRITABLE` | A write was attempted; return to the read plan instead of changing gates. |
| Incomplete count, warning, failed exposure check | Narrow the query or deliberately increase its budget; partial success is not a clean negative finding. |

## Orientation

```sh
npx -y @knowttl/az-axi                      # dashboard: profile, identity, subscriptions, alerts, score, exposure, writes
npx -y @knowttl/az-axi home                 # same dashboard
npx -y @knowttl/az-axi doctor               # auth, reachability and write status per profile
npx -y @knowttl/az-axi sub list             # subscriptions visible to the identity
npx -y @knowttl/az-axi <complete-leaf-path> --help  # that leaf's flags, defaults and examples
```

Use the dashboard when you need orientation, or run a known command directly.
It prints the active profile, identity, visible subscription count, active Defender alerts by severity, average and lowest secure score, exposure counts, and write status - enough to act without a second call.
A failed section degrades to a hint; the rest still render.

The installed CLI's `setup hooks` command requires a persistent installation and installs or repairs session context for Claude Code, Codex and OpenCode, plus the packaged Claude Code PreToolUse Bash approval guard.
The guard requests human approval for recognizable az-axi invocations with `--execute`; setup preserves unrelated settings and hooks.

## Commands

The exact current leaf registry is `src/lib/registry.ts`. Capability labels: `native` (implemented handler), `passthrough` (pinned reviewed Azure CLI read), `api-only` (reviewed raw API operation only), `blocked` (policy refusal), `unsupported` (no supported implementation or reviewed API coverage). The table below records current executable leaves and their Azure effects; it makes no coverage claim for other Azure commands. `api` has a dynamic Azure effect determined by request policy, and `config init` only writes locally.

<!-- command-registry:start -->
| Command | Capability | Azure effect |
|---|---|---|
| `az-axi auth status` | native | read |
| `az-axi home` | native | read |
| `az-axi setup hooks` | native | read |
| `az-axi doctor` | native | read |
| `az-axi config init` | native | read |
| `az-axi config list` | native | read |
| `az-axi profile list` | native | read |
| `az-axi config path` | native | read |
| `az-axi sub list` | native | read |
| `az-axi account list` | native | read |
| `az-axi account show` | native | read |
| `az-axi monitor log-analytics workspace list` | native | read |
| `az-axi monitor log-analytics workspace show` | native | read |
| `az-axi monitor metrics alert list` | native | read |
| `az-axi monitor metrics alert show` | native | read |
| `az-axi monitor action-group list` | native | read |
| `az-axi monitor action-group show` | native | read |
| `az-axi monitor diagnostic-settings list` | native | read |
| `az-axi monitor diagnostic-settings show` | native | read |
| `az-axi monitor metrics list` | native | read |
| `az-axi group list` | native | read |
| `az-axi group show` | native | read |
| `az-axi resource list` | native | read |
| `az-axi resource show` | native | read |
| `az-axi tag update` | native | write |
| `az-axi graph query` | native | read |
| `az-axi rg query` | native | read |
| `az-axi rbac list` | native | read |
| `az-axi role assignment list` | native | read |
| `az-axi activity list` | native | read |
| `az-axi monitor activity-log list` | native | read |
| `az-axi defender alerts` | native | read |
| `az-axi security alert list` | native | read |
| `az-axi defender alerts get` | native | read |
| `az-axi security pricing list` | native | read |
| `az-axi security pricing show` | native | read |
| `az-axi security sub-assessment list` | native | read |
| `az-axi security sub-assessment show` | native | read |
| `az-axi security alert update` | native | write |
| `az-axi defender alerts update` | native | write |
| `az-axi defender assessments` | native | read |
| `az-axi defender score` | native | read |
| `az-axi security secure-scores list` | native | read |
| `az-axi sentinel incident list` | native | read |
| `az-axi sentinel incident show` | native | read |
| `az-axi sentinel incident list-alert` | native | read |
| `az-axi sentinel incident list-entity` | native | read |
| `az-axi sentinel incident update` | native | write |
| `az-axi sentinel incident comment create` | native | write |
| `az-axi sentinel alert-rule list` | native | read |
| `az-axi sentinel alert-rule show` | native | read |
| `az-axi sentinel data-connector list` | native | read |
| `az-axi sentinel data-connector show` | native | read |
| `az-axi exposure` | native | read |
| `az-axi monitor log-analytics query` | native | read |
| `az-axi logs query` | native | read |
| `az-axi api` | native | dynamic |
| `az-axi op status` | native | read |
| `az-axi az group show` | passthrough | read |
| `az-axi storage container list` | native | read |
| `az-axi storage container show` | native | read |
| `az-axi storage blob list` | native | read |
| `az-axi storage blob show` | native | read |
| `az-axi keyvault secret list` | native | read |
| `az-axi keyvault key list` | native | read |
| `az-axi keyvault certificate list` | native | read |
| `az-axi acr repository list` | native | read |
| `az-axi acr repository show-tags` | native | read |
| `az-axi acr manifest show-metadata` | native | read |
| `az-axi network nsg list` | native | read |
| `az-axi network nsg show` | native | read |
| `az-axi network nsg rule create` | native | destructive |
| `az-axi network nic list` | native | read |
| `az-axi network nic show` | native | read |
| `az-axi network vnet list` | native | read |
| `az-axi network vnet show` | native | read |
| `az-axi network public-ip list` | native | read |
| `az-axi network public-ip show` | native | read |
| `az-axi network private-endpoint list` | native | read |
| `az-axi network private-endpoint show` | native | read |
| `az-axi network dns zone list` | native | read |
| `az-axi network dns zone show` | native | read |
| `az-axi policy assignment list` | native | read |
| `az-axi policy assignment show` | native | read |
| `az-axi policy definition list` | native | read |
| `az-axi policy definition show` | native | read |
| `az-axi policy set-definition list` | native | read |
| `az-axi policy set-definition show` | native | read |
| `az-axi policy state list` | native | read |
| `az-axi lock list` | native | read |
| `az-axi lock show` | native | read |
| `az-axi deny-assignment list` | native | read |
| `az-axi deny-assignment show` | native | read |
| `az-axi role definition list` | native | read |
| `az-axi role definition show` | native | read |
| `az-axi network dns record-set list` | native | read |
| `az-axi network dns record-set a list` | native | read |
| `az-axi network dns record-set a show` | native | read |
| `az-axi network dns record-set aaaa list` | native | read |
| `az-axi network dns record-set aaaa show` | native | read |
| `az-axi network dns record-set caa list` | native | read |
| `az-axi network dns record-set caa show` | native | read |
| `az-axi network dns record-set cname list` | native | read |
| `az-axi network dns record-set cname show` | native | read |
| `az-axi network dns record-set mx list` | native | read |
| `az-axi network dns record-set mx show` | native | read |
| `az-axi network dns record-set ns list` | native | read |
| `az-axi network dns record-set ns show` | native | read |
| `az-axi network dns record-set ptr list` | native | read |
| `az-axi network dns record-set ptr show` | native | read |
| `az-axi network dns record-set soa list` | native | read |
| `az-axi network dns record-set soa show` | native | read |
| `az-axi network dns record-set srv list` | native | read |
| `az-axi network dns record-set srv show` | native | read |
| `az-axi network dns record-set txt list` | native | read |
| `az-axi network dns record-set txt show` | native | read |
| `az-axi vm list` | native | read |
| `az-axi vm show` | native | read |
| `az-axi vm get-instance-view` | native | read |
| `az-axi vmss list` | native | read |
| `az-axi vmss show` | native | read |
| `az-axi vmss get-instance-view` | native | read |
| `az-axi disk list` | native | read |
| `az-axi disk show` | native | read |
<!-- command-registry:end -->

Run `npx -y @knowttl/az-axi <complete-leaf-path> --help` for that leaf's accepted flags and reference. The `--help` output is the complete reference for the leaf: available flags with defaults, required arguments, and examples.

## Selecting profile, scope, and tenant

Native commands accept these selector flags, and they never count as unknown flags:

- `--profile <name>` - a configured profile (`npx -y @knowttl/az-axi config list`); may also be written before the command (`npx -y @knowttl/az-axi --profile work rg query ...`), including on the bare dashboard
- `--subscription a,b` - one-off subscription scope; `--management-group <mg>` for management-group scope
- `--tenant <id>` - passed through to `az` for token acquisition
- `--config <path>` - one-off config file
- `$AZ_AXI_PROFILE` / `$AZ_AXI_CONFIG` - profile and config selectors; `$AZ_AXI_SUBSCRIPTIONS` / `$AZ_AXI_TENANT_ID` configure the env profile only
File-selected profiles ignore env-profile fields. Legacy AZ_AXI_SUBSCRIPTION, AZ_AXI_TENANT and tokenEnv are deprecated for one minor release.
The [AXI credential standard](https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md) defines the profile contract; `npx -y @knowttl/az-axi auth status` reports credential sources without values.

With no config file at all, az-axi uses an implicit `az` profile, so it works right after `az login`. `npx -y @knowttl/az-axi config init --name work --auth az` manages profiles locally and never touches Azure.

## Reads

- Discovery lists default to 50 compact rows with full IDs, counts and explicit empty states. `--fields a,b` selects columns, `--full` expands truncated content and shows every fetched row, `--limit N` caps rows.
- Native list fetch budgets (`--all`/`--max-rows`) cover all native Azure collection lists, including activity, monitoring, security, RBAC, governance and exposure; see [command reference](../../docs/commands.md) for budgets and display controls. Fetch budgets apply before local filters; `--limit` and `--full` control display only and incomplete totals are lower bounds.
- Resource Graph: `npx -y @knowttl/az-axi rg query --file query.kql` (or piped stdin); without `--full`, `--limit` maps to `$top` (default 50, maximum 1000). When a skip token is returned, `help[]` carries the exact command for the next page.
- Log Analytics: `npx -y @knowttl/az-axi logs query --file hunt.kql --workspace <alias|guid>`; `--workspace` takes a profile alias or workspace GUID, `--timespan` defaults to `P1D`.
- Query input differs by path: `graph query --graph-query <kql>` (or `-q`) and `monitor log-analytics query --analytics-query <kql>` require flags; `rg query "<kql>"` and `logs query "<kql>"` accept positional KQL.
  All four accept `--file` or stdin.
- These KQL commands parse locally before authentication or requests.
  Syntax failures return `VALIDATION_ERROR` (exit 2), up to five `diagnostics` with line, column, code, token and message, and query excerpts.
  Successful parsing prints no validation message.
  Tables, columns, workspace functions, permissions and service-specific restrictions remain server checks; semantic rejections are identified separately.
- Exposure: `npx -y @knowttl/az-axi exposure --check mgmt-ports`; default `--check all` returns per-check counts plus the first rows of each.
- Escape hatch: `npx -y @knowttl/az-axi api /subscriptions --api-version 2022-12-01`; lists with a `value[]` array return `count` plus `value`, `--all` follows `nextLink`. `npx -y @knowttl/az-axi op status '<operation-url>'` checks a long-running operation.
- Per-command selectors, projections, paging limits and exclusions live in each leaf's `--help` and [command reference](../../docs/commands.md).

## Safe shell input

Pass JSON bodies and KQL containing quotes, pipes, or other shell metacharacters through file or stdin input, never through interpolated command-line arguments:

```sh
npx -y @knowttl/az-axi rg query --file query.kql
npx -y @knowttl/az-axi logs query --file hunt.kql --workspace <alias|guid>
npx -y @knowttl/az-axi api POST /providers/Microsoft.ResourceGraph/resources --api-version 2024-04-01 --body-file query.json
```

`api` takes exactly one body source (`--body-file` or piped stdin). See [command reference](../../docs/commands.md) for the full rule.

## Writes

Writes are disabled by default and read-only commands never change Azure state. The write leaves are `security alert update` (alias `defender alerts update`), `sentinel incident update`, `sentinel incident comment create`, `tag update`, and `network nsg rule create` (destructive: one Deny rule, needs `--confirm <name>`).

- Every write previews first (what would change, with the exact command to execute) and needs human approval on every invocation: never batch, chain, or pre-approve writes. Execution needs `--execute` (plus `--confirm`, `--if-match`, `--timeout`, `--no-wait` where documented).
- The human owns write access; this skill does not describe how to enable it. Launch agents that must never write with `AZ_AXI_READ_ONLY=1`.
- See [write reference](../../docs/safety.md#writes) for selectors, close/classification rules, preview and no-op behavior, and ETag handling.

## Conventions

- Output is TOON on stdout; errors are TOON too. When present, `help` lists next steps. Never log secrets: credential-bearing values are redacted, and secret/key child resources and actions are refused before retrieval.
- Exit codes: 0 success (including no-ops), 1 error, 2 usage error. See [output contract](../../docs/commands.md#behavior) for error categories and output controls.
- Unknown flags are rejected by name: read the `help` line and retry once.
