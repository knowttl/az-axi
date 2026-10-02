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

This is not [`masyanru/az-axi`](https://github.com/masyanru/az-axi), an unrelated
project that owns the unscoped npm package `az-axi`. This project is
[`@knowttl/az-axi`](https://www.npmjs.com/package/@knowttl/az-axi). Never install
both globally on one machine: the second install overwrites the `az-axi` binary.

Call the globally installed, pinned `az-axi` binary. Never use unpinned
`npx -y`: it can fetch a different `az-axi` on a machine where this package is
not installed. If `az-axi` is not on PATH, install
`@knowttl/az-axi` globally first. `az-axi doctor` prints the package name and
version it runs as, so a clash is visible.

## Orientation

Run `az-axi` with no arguments first. It prints the active profile, identity,
visible subscription count, active Defender alerts by severity, average and lowest
secure score, exposure counts, and write status - enough to act without a second
call. A failed section degrades to a hint; the rest still render.

```sh
az-axi                      # dashboard
az-axi config list          # configured profiles
az-axi doctor               # auth, reachability and write status per profile
az-axi sub list             # subscriptions visible to the identity
```

## Selecting profile, scope, and tenant

Every command accepts these selector flags, and they never count as unknown
flags:

- `--profile <name>` - a configured profile (`az-axi config list`); may also be
  written before the command (`az-axi --profile work rg query ...`), including
  on the bare dashboard
- `--subscription a,b` - one-off subscription scope; `--management-group <mg>`
  for Resource Graph commands
- `--tenant <id>` - passed through to `az` for token acquisition
- `--config <path>` - one-off config file
- `$AZ_AXI_PROFILE` / `$AZ_AXI_SUBSCRIPTION` / `$AZ_AXI_TENANT` /
  `$AZ_AXI_CONFIG` - environment overrides

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
az-axi rg query "Resources | take 5"
az-axi rg query --file query.kql
cat query.kql | az-axi rg query
```

`rg query` trims surrounding query whitespace, then POSTs the KQL to Resource Graph across the scope in `--subscription` / `--management-group` flags, then the profile `managementGroup`, then the profile `subscriptions`.
`--limit` maps to `$top` (default 50, maximum 1000).
Output is `total`, `count`, `rows`; nested objects render as compact JSON truncated at 200 characters unless `--full`.
When a skip token is returned, `help[]` carries the exact command for the next page.

## Access and activity

```sh
az-axi rbac list --privileged
az-axi rbac list --principal analyst@contoso.com
az-axi rbac list --show-query
az-axi activity list --since 24h --status Failed
```

`rbac list` runs one Resource Graph query over `authorizationresources`, joined
to role definitions. `--privileged` keeps Owner, Contributor, User Access
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

`exposure` runs canned Resource Graph checks: `public-ips` (attached addresses
only), `mgmt-ports` (inbound Allow rules from any source covering ports 22,
3389, 5985, or 5986, including ranges), and `any-any` (any source to any port).
Default `--check all` returns per-check counts plus the first 10 rows of each;
`--limit` changes that cap. `az-axi exposure --show-query` prints the canned
KQL without running it.

## Logs

```sh
az-axi logs query "SigninLogs | take 5" --workspace sentinel
az-axi logs query --file hunt.kql --workspace sentinel
cat hunt.kql | az-axi logs query --workspace sentinel
```

`--workspace` takes an alias from the profile `workspaces` map or a workspace
ID GUID. An ARM resource ID is rejected with the `rg query` that finds the
GUID. `--timespan` defaults to `P1D` and accepts `30m`, `24h`, `7d`, ISO 8601
durations, ISO dates, and start/end intervals; it intersects any time filter in
the query.
Surrounding query whitespace is trimmed; no row limits or time filters are added.
`--limit` caps displayed rows client-side (default 50). Output is
`total`, `count`, `rows` from the first table; extra tables appear by name and
row count only. Partial errors return a `warning` instead of failing.

## Escape hatch

```sh
az-axi api /subscriptions --api-version 2022-12-01
az-axi api POST /providers/Microsoft.ResourceGraph/resources --api-version 2024-04-01 --body '{"query":"Resources | take 1"}'
```

`api` covers any read or query request. Paths are relative to the host root;
`--resource` selects `arm` (default), `logs`, or `graph`. `--api-version` is
required for `arm` when the path carries none. Lists with a `value[]` array
return `count` plus `value`; `--all` follows ARM `nextLink` up to 10 pages.
Strings truncate at 4,000 characters unless `--full`. Write and destructive
requests are blocked (see Writes below).

## Safe shell input

Multi-line KQL never goes on the command line. `rg query` and `logs query`
take it from `--file` or piped stdin; passing both a query and `--file` is an
error:

```sh
az-axi rg query --file query.kql
cat query.kql | az-axi rg query
az-axi rg query <<'EOF'
Resources | take 5
EOF
```

Never double-quote a flag value containing backticks, `$`, `!`, or quotes. The
shell expands these before `az-axi` starts, so the CLI receives valid but
mangled input and cannot detect it. The same applies to `--body` JSON: keep it
single-quoted and short, and prefer `--file`-backed KQL through `rg query` or
`logs query` over hand-built `api --body` payloads for anything multiline.

On Windows, never pass large or multiline content through the `.cmd` shim as an
interpolated argument such as `--body "$(cat body.json)"`; `cmd.exe` can
truncate it. For `rg query` and `logs query`, use piped stdin or `--file`
instead. For `api --body`, keep JSON single-quoted and short.

## Writes

Writes are disabled by default.
See [README.md#writes](../../README.md#writes) for current write support.
For a future write-capable version, a write always needs `--execute`.
Show a dry run first (what would change, with the exact command to execute), and obtain human approval on every invocation - never batch, chain, or pre-approve writes.
The human owns write access; this skill does not describe how to enable it.

## Conventions

- Output is TOON on stdout; errors are TOON too, with a `help` list of exact,
  runnable next steps. Follow hints literally.
- Exit codes: 0 success (including no-ops), 1 runtime error, 2 usage error.
- Unknown flags are rejected by name - read the `help` line and retry once.
  Flags that do not apply to the subcommand are rejected the same way.
- Lists take `--limit` and `--fields a,b`; detail views truncate and take
  `--full`.
- Read-only commands never change Azure state. `config init` writes a local
  file only.
