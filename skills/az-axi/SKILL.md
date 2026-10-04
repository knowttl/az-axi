---
name: az-axi
description: Use az-axi for read-only Azure inspection - subscriptions, Resource Graph inventory, RBAC role assignments, activity log, Defender for Cloud alerts and secure score, NSG and public IP exposure, Log Analytics KQL queries.
user-invocable: false
---

# az-axi

Agent-ergonomic CLI for Azure, read-only by default. Resource inventory through
Resource Graph, RBAC, activity log, Defender for Cloud, internet exposure checks,
and Log Analytics KQL queries through token-efficient TOON output, with a raw
REST escape hatch for everything else.

Call the globally installed, pinned `az-axi` binary. Never use unpinned
`npx -y`. If `az-axi` is not on PATH, install
`@knowttl/az-axi` globally first. `az-axi doctor` prints the package name and
version it runs as.

## Orientation

The exact current leaf registry is `src/lib/registry.ts`.
Its capability labels are `native` (implemented handler), `passthrough` (pinned reviewed Azure CLI read), `api-only` (reviewed raw API operation only), `blocked` (policy refusal), and `unsupported` (no supported implementation or reviewed API coverage).
The list below records current executable leaves and their capabilities; it makes no coverage claim for other Azure commands.
`api` has a dynamic Azure effect determined by request policy, and `config init` only writes locally.
The offline test suite checks this list against the registry.

<!-- command-registry:start -->
| Command | Capability | Azure effect |
|---|---|---|
| `az-axi home` | native | read |
| `az-axi doctor` | native | read |
| `az-axi config init` | native | read |
| `az-axi config list` | native | read |
| `az-axi config path` | native | read |
| `az-axi sub list` | native | read |
| `az-axi account list` | native | read |
| `az-axi account show` | native | read |
| `az-axi monitor log-analytics workspace list` | native | read |
| `az-axi monitor log-analytics workspace show` | native | read |
| `az-axi group list` | native | read |
| `az-axi group show` | native | read |
| `az-axi resource list` | native | read |
| `az-axi resource show` | native | read |
| `az-axi graph query` | native | read |
| `az-axi rg query` | native | read |
| `az-axi rbac list` | native | read |
| `az-axi role assignment list` | native | read |
| `az-axi activity list` | native | read |
| `az-axi monitor activity-log list` | native | read |
| `az-axi defender alerts` | native | read |
| `az-axi security alert list` | native | read |
| `az-axi defender alerts get` | native | read |
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
<!-- command-registry:end -->

See [README.md#use](../../README.md#use) for az-shaped aliases, their native scope and defaults, exact command paths, short flags, list and boolean parsing, and literal positional input.
Run `az-axi <complete-leaf-path> --help` for that leaf's accepted flags and reference.

See [storage metadata reads](../../README.md#storage-metadata-reads) for the storage commands, required flags, Entra-only authentication, safe properties, literal values and paging limits.

See [key vault metadata reads](../../README.md#key-vault-metadata-reads) for the keyvault commands, required flags, Entra-only authentication, property-only listing with no value retrieval, expiry filtering and paging limits.

See the [pinned Azure CLI read catalogue reference](../../README.md#pinned-azure-cli-read-catalogue) for runtime constraints, refusal policy, credential exclusions and maintenance workflow.

Run `az-axi` with no arguments first. It prints the active profile, identity,
visible subscription count, active Defender alerts by severity, average and lowest
secure score, exposure counts, and write status - enough to act without a second
call. A failed section degrades to a hint; the rest still render.
See [README.md#writes](../../README.md#writes) for the dashboard and `doctor` write scope, read-only override and log path details.

```sh
az-axi                      # dashboard
az-axi home                 # same dashboard
az-axi config list          # configured profiles
az-axi doctor               # auth, reachability and write status per profile
az-axi sub list             # subscriptions visible to the identity
```

## Selecting profile, scope, and tenant

Native commands accept these selector flags, and they never count as unknown
flags:

- `--profile <name>` - a configured profile (`az-axi config list`); may also be
  written before the command (`az-axi --profile work rg query ...`), including
  on the bare dashboard
- `--subscription a,b` - one-off subscription scope; `--management-group <mg>`
  for management-group scope
- `--tenant <id>` - passed through to `az` for token acquisition
- `--config <path>` - one-off config file
- `$AZ_AXI_PROFILE` / `$AZ_AXI_SUBSCRIPTION` / `$AZ_AXI_TENANT` /
  `$AZ_AXI_CONFIG` - environment overrides

Native write scope restrictions are documented in [README.md#writes](../../README.md#writes).

With no config file at all, az-axi uses an implicit `az` profile, so it works
right after `az login`. `az-axi config init` manages profiles locally and never
touches Azure:

```sh
az-axi config init --name work --auth az
az-axi config list
az-axi config path
```

## Inventory

```sh
az-axi group list
az-axi group show -n rg-demo -s <subscription>
az-axi resource list -g rg-demo
az-axi resource show --ids <ARM-id> --full
az-axi account list
az-axi account show -s <subscription> --full
az-axi monitor log-analytics workspace list -g rg-demo
az-axi monitor log-analytics workspace show -g rg-demo --workspace-name logs-demo --full
```

See [README.md#use](../../README.md#use) for discovery subscription scope, including `resource show --ids`.
Unambiguous subscription names resolve to IDs without changing the Azure CLI account default.
Lists default to 50 compact metadata rows with full IDs, counts and explicit empty states.
`--fields` selects metadata fields; `--full` expands metadata and shows every fetched row.
Generic `resource show` returns only the ARM envelope: id, name, type, kind, location, tags, sku, identity type and provisioningState.
Its default view shows name, id, type and location; `--full` expands the envelope, and `--fields` selects envelope fields only.
Provider `properties` and nested field paths are rejected by `--fields`; no show view returns the raw properties blob.
Use typed commands for provider details, or the raw `az-axi api` path with its existing redaction.
See [README.md#use](../../README.md#use) for discovery paging limits and incomplete counts.
Show by name requires one subscription; resource show also requires `--resource-group` and `--resource-type`, or exactly one `--ids` instead.
Resource show selects the newest stable provider API version unless `--api-version` is supplied.
Credential-bearing child resources and actions are refused before retrieval.
Management-group discovery is unsupported; select subscriptions explicitly.

See [README.md#use](../../README.md#use) for native account and workspace discovery scope, selectors, metadata fields, paging limits and credential exclusions, including how `account list` differs from legacy `sub list`.

```sh
az-axi graph query -q Resources
az-axi graph query --file query.kql
```

`rg query` trims surrounding query whitespace, then POSTs the KQL to Resource Graph across the scope in `--subscription` / `--management-group` flags, then the profile `managementGroup`, then the profile `subscriptions`.
See [README.md#use](../../README.md#use) for the canonical `graph query` path, query input flags, plural scope selectors, Azure CLI differences and pagination hint paths.
Without `--full`, `--limit` maps to `$top` (default 50, maximum 1000).
`--full` ignores `--limit` and requests up to 1000 rows per page.
Output is `total`, `count`, `rows`; nested objects render as compact JSON truncated at 200 characters unless `--full`.
When a skip token is returned, `help[]` carries the exact command for the next page.

## Access and activity

```sh
az-axi rbac list --privileged
az-axi rbac list --principal analyst@contoso.com
az-axi rbac list --show-query
az-axi activity list --since 24h --status Failed
```

`rbac list` queries Resource Graph over `authorizationresources`, joined to role definitions, paging as needed.
`--privileged` keeps Owner, Contributor, User Access
Administrator, and RBAC Administrator by built-in role GUID. `--principal`
accepts an object ID or a UPN (UPNs resolve through Graph; if Graph is
unavailable, pass the object ID). Principal names are best effort: on any Graph
failure the raw object IDs are shown with a hint, and the command still
succeeds. Output is `total`, `count`, `byRole`, and rows of
`principal, type, role, scope, created`.

`activity list` reads the per-subscription activity log, merged newest first.
`--since` accepts `30m`, `24h`, `7d`, ISO 8601 durations, and ISO dates; values
older than 90 days are rejected with a hint to query the `AzureActivity` table
via `logs query` instead. `--status` and `--operation` filter client-side.
Output is `total`, `count`, `topCallers`, and rows of
`time, caller, operation, status, resource`.

## Security posture

```sh
az-axi defender alerts --severity High
az-axi defender alerts get <alert-resource-id>
az-axi defender assessments --severity High
az-axi defender score
az-axi exposure --check mgmt-ports
```

`defender alerts` lists per-subscription alerts, newest first
(`--status Active` by default, `--status all` for every status). `alerts get`
takes the full alert resource ID from the list output, not a bare name, and
returns description, remediation steps, and an entities summary.
`defender assessments` returns one row per recommendation
(`recommendation, severity, unhealthyCount, total`), worst severity first;
`--resource <name>` switches to per-resource rows for one resource.
`defender score` returns one row per subscription
(`subscription, current, max, percent`), lowest percent first.
`--show-query` on `assessments` prints the exact KQL without running it.

```sh
az-axi sentinel incident list -g rg-demo --workspace-name logs-demo
az-axi sentinel incident show --name 3177 --workspace sentinel
az-axi sentinel incident list-alert --name 3177 --workspace sentinel
az-axi sentinel incident list-entity --name 3177 --workspace sentinel
az-axi sentinel alert-rule list -g rg-demo --workspace-name logs-demo
az-axi sentinel alert-rule show --name <rule-id> --workspace sentinel
az-axi sentinel data-connector list -g rg-demo --workspace-name logs-demo
az-axi sentinel data-connector show --name <connector-id> --workspace sentinel
```

See [Sentinel incident triage](../../README.md#use) for workspace and subscription selectors, incident identities and aliases, filters, output fields, paging limits and investigation scope.

`exposure` runs canned Resource Graph checks: `public-ips` (attached addresses
only), `mgmt-ports` (inbound Allow rules from any source covering ports 22,
3389, 5985, or 5986, including ranges), and `any-any` (any source to any port).
Default `--check all` returns per-check counts plus the first 10 rows of each;
`--limit` changes that cap. `az-axi exposure --show-query` prints the canned
KQL without running it.

## Logs

```sh
az-axi monitor log-analytics query --file hunt.kql --workspace sentinel
```

`--workspace` takes an alias from the profile `workspaces` map or a workspace
ID GUID. An ARM resource ID is rejected with the `rg query` that finds the
GUID. `--timespan` defaults to `P1D` and accepts `30m`, `24h`, `7d`, ISO 8601
durations, ISO dates, and start/end intervals; it intersects any time filter in
the query.
Surrounding query whitespace is trimmed; no row limits or time filters are added.
See [README.md#use](../../README.md#use) for the canonical `monitor log-analytics query` path, query input flags, timespan default and workspace coverage.
`--limit` caps displayed rows client-side (default 50). Output is
`total`, `count`, `rows` from the first table; extra tables appear by name and
row count only. Partial errors return a `warning` instead of failing.

## Escape hatch

```sh
az-axi api /subscriptions --api-version 2022-12-01
```

`api` covers any read or query request. Paths are relative to the host root;
`--resource` selects `arm` (default), `logs`, or `graph`. `--api-version` is
required for `arm` when the path carries none. Lists with a `value[]` array
return `count` plus `value`; `--all` follows ARM `nextLink` up to 10 pages.
Strings truncate at 4,000 characters unless `--full`.
See [README.md#writes](../../README.md#writes) for write and destructive request support.

Use `az-axi op status '<operation-url>'` to inspect an existing long-running operation.
See [README.md#check-an-operation](../../README.md#check-an-operation) for URL requirements, output and recheck behavior.

## Safe shell input

In every shell, pass JSON bodies and KQL containing quotes, pipes, or other shell metacharacters through file or stdin input, never through interpolated command-line arguments.
Use file or stdin input for all multiline content as well.
`rg query` and `logs query` take it from `--file` or piped stdin; passing both a query and `--file` is an error.
Keep inline KQL short and free of shell metacharacters, as in `az-axi graph query -q Resources` above.
Prefer these file commands across shells:

```sh
az-axi rg query --file query.kql
az-axi logs query --file hunt.kql --workspace sentinel
```

`api` accepts JSON through `--body-file <path>` or piped stdin.
Use exactly one body source; combining either with inline `--body`, or a file with non-empty stdin, is an error.
Empty stdin means no body; files and non-empty stdin must contain valid JSON.
Do not use inline `api --body` for shell-sensitive content under this rule.
```sh
az-axi api POST /providers/Microsoft.ResourceGraph/resources --api-version 2024-04-01 --body-file query.json
az-axi api POST /providers/Microsoft.ResourceGraph/resources --api-version 2024-04-01 < query.json
```

Write previews retain the file path in execution hints.
For stdin or redacted inline bodies, replace `<body-file>` in the hint with a file containing the original JSON before execution.
For Resource Graph and Log Analytics queries, use the file or stdin inputs of `rg query` and `logs query`, which construct the JSON request body internally.

## Writes

Writes are disabled by default.
See [README.md#writes](../../README.md#writes) for `security alert update`, its `defender alerts update` alias, required selectors, supported statuses, preview and no-op behavior, and concurrency limits.
See the same reference for `sentinel incident update` (status, severity, owner, classification) and `sentinel incident comment create`, their required selectors, close/classification rules, preview and no-op behavior, and ETag handling.
Write execution needs `--execute`; see the README reference above for `--if-match`, `--confirm`, `--timeout` and `--no-wait`.
Show a dry run first (what would change, with the exact command to execute), and obtain human approval on every invocation - never batch, chain, or pre-approve writes.
The human owns write access; this skill does not describe how to enable it.

## Conventions

- Output is TOON on stdout; errors are TOON too.
  When present, `help` lists next steps.
  Apply the [safe shell input](#safe-shell-input) rule to hints too.
- See [README.md#behavior](../../README.md#behavior) for exit codes, error categories, and output controls.
- Unknown flags are rejected by name - read the `help` line and retry once.
- Read-only commands never change Azure state. `config init` writes a local
  file only.
