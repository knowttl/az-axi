---
name: az-axi
description: "Read-only Azure inspection: subscriptions, resources, RBAC, activity, Defender, Sentinel, network, policy, and Log Analytics."
user-invocable: false
---

# az-axi

Read-only Azure inspection for agents: resource inventory, RBAC, activity log, Defender for Cloud and Log Analytics. Results render as token-efficient TOON on stdout, with a raw REST escape hatch (`api`) for everything else.

Run commands as `npx -y @knowttl/az-axi ...`: no global install needed and no interactive prompts.
Version pinning is the installer's choice: use `npx -y @knowttl/az-axi@<version> ...` to select a specific release.
Never run against a real tenant in tests; use the offline suite instead.

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

## Commands

The exact current leaf registry is `src/lib/registry.ts`. Capability labels: `native` (implemented handler), `passthrough` (pinned reviewed Azure CLI read), `api-only` (reviewed raw API operation only), `blocked` (policy refusal), `unsupported` (no supported implementation or reviewed API coverage). The table below records current executable leaves and their Azure effects; it makes no coverage claim for other Azure commands. `api` has a dynamic Azure effect determined by request policy, and `config init` only writes locally.

<!-- command-registry:start -->
| Command | Capability | Azure effect |
|---|---|---|
| `az-axi home` | native | read |
| `az-axi setup hooks` | native | read |
| `az-axi doctor` | native | read |
| `az-axi config init` | native | read |
| `az-axi config list` | native | read |
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
- `$AZ_AXI_PROFILE` / `$AZ_AXI_SUBSCRIPTION` / `$AZ_AXI_TENANT` / `$AZ_AXI_CONFIG` - environment overrides

With no config file at all, az-axi uses an implicit `az` profile, so it works right after `az login`. `npx -y @knowttl/az-axi config init --name work --auth az` manages profiles locally and never touches Azure.

## Reads

- Discovery lists default to 50 compact rows with full IDs, counts and explicit empty states. `--fields a,b` selects columns, `--full` expands truncated content and shows every fetched row, `--limit N` caps rows.
- Resource Graph: `npx -y @knowttl/az-axi rg query --file query.kql` (or piped stdin); without `--full`, `--limit` maps to `$top` (default 50, maximum 1000). When a skip token is returned, `help[]` carries the exact command for the next page.
- Log Analytics: `npx -y @knowttl/az-axi logs query --file hunt.kql --workspace sentinel`; `--workspace` takes a profile alias or workspace GUID, `--timespan` defaults to `P1D`.
- Exposure: `npx -y @knowttl/az-axi exposure --check mgmt-ports`; default `--check all` returns per-check counts plus the first rows of each.
- Escape hatch: `npx -y @knowttl/az-axi api /subscriptions --api-version 2022-12-01`; lists with a `value[]` array return `count` plus `value`, `--all` follows `nextLink`. `npx -y @knowttl/az-axi op status '<operation-url>'` checks a long-running operation.
- Per-command selectors, projections, paging limits and exclusions live in each leaf's `--help` and [README.md#use](../../README.md#use).

## Safe shell input

Pass JSON bodies and KQL containing quotes, pipes, or other shell metacharacters through file or stdin input, never through interpolated command-line arguments:

```sh
npx -y @knowttl/az-axi rg query --file query.kql
npx -y @knowttl/az-axi logs query --file hunt.kql --workspace sentinel
npx -y @knowttl/az-axi api POST /providers/Microsoft.ResourceGraph/resources --api-version 2024-04-01 --body-file query.json
```

`api` takes exactly one body source (`--body-file` or piped stdin). See [README.md#use](../../README.md#use) for the full rule.

## Writes

Writes are disabled by default and read-only commands never change Azure state. The write leaves are `security alert update` (alias `defender alerts update`), `sentinel incident update`, `sentinel incident comment create`, `tag update`, and `network nsg rule create` (destructive: one Deny rule, needs `--confirm <name>`).

- Every write previews first (what would change, with the exact command to execute) and needs human approval on every invocation: never batch, chain, or pre-approve writes. Execution needs `--execute` (plus `--confirm`, `--if-match`, `--timeout`, `--no-wait` where documented).
- The human owns write access; this skill does not describe how to enable it. Launch agents that must never write with `AZ_AXI_READ_ONLY=1`.
- See [README.md#writes](../../README.md#writes) for selectors, close/classification rules, preview and no-op behavior, and ETag handling.

## Conventions

- Output is TOON on stdout; errors are TOON too. When present, `help` lists next steps. Never log secrets: credential-bearing values are redacted, and secret/key child resources and actions are refused before retrieval.
- Exit codes: 0 success (including no-ops), 1 error, 2 usage error. See [README.md#behavior](../../README.md#behavior) for error categories and output controls.
- Unknown flags are rejected by name: read the `help` line and retry once.
