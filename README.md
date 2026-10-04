# az-axi

az-axi is a CLI for agents and analysts to inspect Azure resources, access permissions, activity, security posture and logs.
It is read-only by default and returns compact, token-efficient TOON output with actionable hints.
Start with `az-axi` for a dashboard, then use focused inspection commands, KQL queries or the `api` REST escape hatch to investigate a selected profile and scope.

## How it works

The backend is a local Node.js application written in TypeScript that calls Azure REST APIs directly.
Reviewed Azure CLI reads use the bounded child-process transport described in the [passthrough reference](#pinned-azure-cli-read-catalogue).

- **Command routing:** [the router](src/lib/router.ts) resolves exact leaf paths, validates flags and serves leaf help before loading handlers.
  [The CLI entry point](src/bin/az-axi.ts) uses `axi-sdk-js` for execution, top-level help and error rendering.
  The [registry](src/lib/registry.ts) loads command handlers and enforces their declared Azure effects.
- **Profiles and authentication:** [config](src/lib/config.ts) resolves the profile, tenant and scope from files, flags and environment variables.
  [Authentication](src/lib/auth.ts) obtains tokens from Azure CLI sign-in or profile-selected environment variables.
- **Requests and output:** one [HTTP client](src/lib/client.ts) serves ARM, Resource Graph (through ARM), Log Analytics and Microsoft Graph.
  Commands use [formatting helpers](src/lib/format.ts) to select fields and shorten output; the registry applies [secret redaction](src/lib/redact.ts) before TOON encoding.
- **Write controls:** [policy](src/lib/policy.ts) classifies requests before [gates](src/lib/gates.ts) check the read-only override, profile write permission and subscription scope.
  Permitted writes produce a [dry run](src/lib/dryRun.ts) unless `--execute` is supplied; [execution](src/lib/execute.ts) requires destructive confirmation where applicable and handles ETags and no-ops.
- **Operation tracking:** [long-running operations](src/lib/lro.ts) poll Azure's operation URL during execution, or `op status` checks it once.
  Dispatched write attempts record outcome metadata, excluding bodies and headers, in the append-only [write log](src/lib/writeLog.ts).

## Install

Requires Node.js 22.12 or later, and the Azure CLI for the default `az` profile mode.

```
npm i -g @knowttl/az-axi
az-axi --help
az-axi doctor
```

See [Configure](#configure) for authentication and profile checks.

From source (requires pnpm):

```
git clone https://github.com/knowttl/az-axi.git
cd az-axi
pnpm install --frozen-lockfile
pnpm run build
node dist/bin/az-axi.js --help
```

### Releases

Conventional commits on `main` produce a release-please PR with the version and `CHANGELOG.md` changes.
The initial release is `0.1.0`; merging a release PR creates its tag and GitHub release, then builds and checks that tag and publishes it to npm with OIDC provenance unless the version is already published.
`release-please` owns the changelog and GitHub release notes; `scripts/release-notes.mjs` remains available to extract a version's changelog section locally.
The previous tag-driven release workflow is replaced by `.github/workflows/release-please.yml`.
The `typecheck` script runs this repository's TypeScript no-emit check; no separate style linter is configured.

For the first publish, the owner must bootstrap the npm package before merging the first release PR:

1. Sign in to npmjs.com with an account allowed to publish under `@knowttl`, enable two-factor authentication, and confirm that the scope belongs to that account or organization.
   In GitHub repository Settings → Actions → General, enable GitHub Actions to create pull requests so release-please can open its PRs.
2. Keep the first `0.1.0` release PR open for owner review.
   From a reviewed checkout of that PR, run `corepack pnpm install --frozen-lockfile`, `corepack pnpm run build`, `corepack pnpm run typecheck` and `corepack pnpm test`.
   Confirm `package.json` says `0.1.0`, then authenticate locally with `npm login` and publish once with `npm publish --access public`.
   This creates the package; a new package has no Settings page on which to configure OIDC beforehand.
   Do not put npm credentials into GitHub or this repository, or reuse another project's token.
   This local bootstrap publish has no CI provenance.
3. On npmjs.com, open `@knowttl/az-axi` → Settings → Trusted publishing → Add trusted publisher → GitHub Actions.
   Set organization/user to `knowttl`, repository to `az-axi`, workflow filename to `release-please.yml` (filename only), and leave environment blank.
   Enable direct `npm publish` in Allowed actions and save.
4. After a privacy audit confirms no secrets or private data anywhere in the git history, make `knowttl/az-axi` public, then merge the approved release PR.
   The workflow skips the already published `0.1.0`; later versions publish with provenance from the public repository.

See npm's [trusted publisher setup](https://docs.npmjs.com/trusted-publishers/) for the configuration fields and provenance requirements.

## Agent integration

Install the usage skill from this repository:

```
npx skills add knowttl/az-axi --skill az-axi -g
```

For agent sessions that should never write, launch the agent with `AZ_AXI_READ_ONLY=1` in its environment.
For example, `AZ_AXI_READ_ONLY=1 claude` forces az-axi write previews and execution to remain blocked even on a write-enabled profile.

For Claude Code sessions where writes are intended, install the Bash approval hook from a reviewed checkout's [scripts/claude-guard.mjs](scripts/claude-guard.mjs).
Keep the script at a trusted absolute path and merge this configuration into `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project), replacing the example path:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/az-axi/scripts/claude-guard.mjs\""
          }
        ]
      }
    ]
  }
}
```

The hook requests human approval with the full command whenever it detects an az-axi invocation containing `--execute`, including quoted words, paths, `env`, `npx` and chained commands.
For ambiguous shell text, the hook checks both raw and normalized text for a recognizable az-axi name and literal `--execute` evidence, including assignments, arrays, pipelines, here-documents and escaped or ANSI-quoted text.
That evidence need not form an exact flag token or belong to the same command, so unrelated literal text and strings such as `--execute-later` may also prompt in ambiguous commands.
Even simple commands containing `--execute=false` prompt.
It only inspects text and never runs the command itself.
It is a Bash hook, so it does not cover PowerShell or other tools, aliases or dynamically assembled commands that contain no recognizable az-axi name and flag.
Use an interactive session with permission prompts enabled; after installation or a Claude Code hook upgrade, check approval with the harmless `az-axi api --help --execute` command, and check that `az-axi --help` does not trigger this hook.
See the official [hooks reference](https://code.claude.com/docs/en/hooks), [setup guide](https://code.claude.com/docs/en/hooks-guide) and [permissions documentation](https://code.claude.com/docs/en/permissions).
CLI flags are supplied by the agent; the harness approval is the human control.

## Configure

az-axi authenticates in one of two modes, chosen per profile.

| Mode | Source | Use it for |
|---|---|---|
| `az` (default) | `az account get-access-token`, using whatever `az login` holds | Interactive users, service principals, managed identities, federated sign-in |
| `token` | One environment variable per resource, holding a pre-acquired bearer token | CI, or any environment where a token is minted elsewhere |

Native commands work right after `az login`, before any config file exists.
For passthrough configuration requirements, see the [passthrough reference](#pinned-azure-cli-read-catalogue).
Run `az-axi doctor` after any change to check the Azure CLI, sign-in, tokens, reachability and write status of every profile.

### Profiles

Profiles live in `~/.az-axi/config.json`.
The file is found in this order: `--config <path>`, `$AZ_AXI_CONFIG`, `./az-axi.config.json`, `~/.az-axi/config.json`.
The profile is chosen in this order: `--profile`, `$AZ_AXI_PROFILE`, `defaultProfile`, the only profile in the file.
With no profiles configured, az-axi uses an implicit `az` profile.
Several profiles and no selection is an error.

```json
{
  "defaultProfile": "work",
  "profiles": {
    "work": {
      "auth": "az",
      "tenant": "00000000-0000-0000-0000-000000000001",
      "managementGroup": "contoso-root",
      "subscriptions": [],
      "workspaces": { "sentinel": "00000000-0000-0000-0000-000000000010" },
      "description": "Daily analyst profile"
    },
    "ci": {
      "auth": "token",
      "tokenEnv": {
        "arm": "AZ_AXI_ARM_TOKEN",
        "logs": "AZ_AXI_LOGS_TOKEN",
        "graph": "AZ_AXI_GRAPH_TOKEN"
      }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `auth` | `az` or `token` (required) |
| `tenant` | Passed as `--tenant` to `az` |
| `managementGroup` | Default scope for Resource Graph queries |
| `subscriptions` | Default subscription IDs; empty or missing means every subscription the identity can see |
| `workspaces` | Alias to Log Analytics workspace ID (the workspace GUID, not the ARM resource ID) |
| `tokenEnv` | Token audience (`arm`, `logs`, `graph`, `storage`, `vault`, `registry`) to environment variable name, for `token` mode; `storage`, `vault` and `registry` are only for native [storage](#storage-metadata-reads), [key vault](#key-vault-metadata-reads) and [ACR](#acr-metadata-reads) metadata reads, not `api --resource` |

Create a profile without editing JSON:

```
az-axi config init --name work --auth az --tenant 00000000-0000-0000-0000-000000000001
az-axi config list
az-axi config path
```

Native commands accept `--profile`, `--tenant`, `--subscription a,b`, `--management-group` and `--config`.
`$AZ_AXI_TENANT` and `$AZ_AXI_SUBSCRIPTION` set the same overrides from the environment.
Native write commands constrain scope as documented in [Writes](#writes).
`$AZ_AXI_READ_ONLY=1` forces the whole process read-only whatever a profile says.

### Signing in

Native commands support any identity that `az` understands in `az` mode.

```
# Interactive user
az login

# Interactive user in a specific tenant
az login --tenant 00000000-0000-0000-0000-000000000001

# Service principal with a certificate
az login --service-principal \
  --username 00000000-0000-0000-0000-000000000002 \
  --tenant 00000000-0000-0000-0000-000000000001 \
  --certificate /path/to/cert.pem

# Managed identity (on an Azure host)
az login --identity

# Federated token (for example a CI workload identity)
az login --service-principal \
  --username 00000000-0000-0000-0000-000000000002 \
  --tenant 00000000-0000-0000-0000-000000000001 \
  --federated-token "$FEDERATED_TOKEN"
```

When Conditional Access or MFA asks for more, run `az logout`, then `az login --tenant <tenant-id>` again.

### Token mode

Mint a token for each resource you need and export it under the variable named in the profile:

```
export AZ_AXI_ARM_TOKEN=$(az account get-access-token --resource https://management.azure.com/ --query accessToken --output tsv)
export AZ_AXI_LOGS_TOKEN=$(az account get-access-token --resource https://api.loganalytics.io --query accessToken --output tsv)
export AZ_AXI_GRAPH_TOKEN=$(az account get-access-token --resource-type ms-graph --query accessToken --output tsv)
```

Then use a profile with `"auth": "token"`.
Tokens live only in memory: they are never written to disk, logged or printed.
A token that expires mid-session is not refreshed; mint a new one.

### TLS-inspecting proxies

Networks that re-sign TLS traffic make Node reject Azure's certificate, which shows up as a `TLS_ERROR`.
Point Node at your organization's root CA (a PEM file) and re-run `az-axi doctor`:

```
export NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem
```

## Query logs

Run KQL against a workspace configured in the selected profile:

```
az-axi monitor log-analytics query --file hunt.kql --workspace sentinel --timespan P7D
```

The identity needs Log Analytics Reader on the workspace.
See the agent guide's [safe shell input rule](skills/az-axi/SKILL.md#safe-shell-input) for query input across shells.
Use `az-axi monitor log-analytics query --help` for workspace IDs, query input handling, time windows and output limits.

## Use

```sh
az-axi group list
az-axi group show -n rg-demo -s <subscription>
az-axi resource list -g rg-demo
az-axi resource show --ids <ARM-id> --full
az-axi account list
az-axi account show -s <subscription> --full
az-axi monitor log-analytics workspace list -g rg-demo
az-axi monitor log-analytics workspace show -g rg-demo --workspace-name logs-demo --full
az-axi monitor metrics alert list -g rg-demo
az-axi monitor metrics alert show --name high-cpu -g rg-demo
az-axi monitor action-group list -g rg-demo
az-axi monitor action-group show --name ag-demo -g rg-demo
az-axi monitor diagnostic-settings list --resource <ARM-id>
az-axi monitor diagnostic-settings show --resource <ARM-id> --name to-hub
az-axi monitor metrics list --resource <ARM-id>
az-axi monitor metrics list --resource <ARM-id> --metric "Percentage CPU"
az-axi sentinel incident list -g rg-demo --workspace-name logs-demo -s <subscription>
az-axi sentinel incident show --name 3177 --workspace sentinel
az-axi sentinel incident list-alert --name 3177 --workspace sentinel
az-axi sentinel incident list-entity --name 3177 --workspace sentinel
az-axi sentinel alert-rule list -g rg-demo --workspace-name logs-demo
az-axi sentinel alert-rule show --name <rule-id> --workspace sentinel
az-axi sentinel data-connector list -g rg-demo --workspace-name logs-demo
az-axi sentinel data-connector show --name <connector-id> --workspace sentinel
az-axi network nsg list -g rg-demo
az-axi network nsg show --name nsg-web -g rg-demo
az-axi network nsg rule create --nsg-name nsg-web -g rg-demo --name deny-telnet --priority 400 --destination-port-ranges 23 --protocol Tcp -s <subscription>
az-axi network nic list -g rg-demo
az-axi network nic show --name nic-demo -g rg-demo
az-axi network vnet list -g rg-demo
az-axi network vnet show --name vnet-demo -g rg-demo
az-axi network public-ip list -g rg-demo
az-axi network public-ip show --name pip-demo -g rg-demo
az-axi network private-endpoint list -g rg-demo
az-axi network private-endpoint show --name pe-storage -g rg-demo
az-axi network dns zone list -g rg-demo
az-axi network dns zone show --name example.com -g rg-demo
az-axi network dns record-set list -g rg-demo --zone-name example.com
az-axi network dns record-set a show -g rg-demo --zone-name example.com --name www
az-axi vm list -g rg-demo
az-axi vm show --name vm-demo -g rg-demo
az-axi vm get-instance-view --name vm-demo -g rg-demo
az-axi vmss list -g rg-demo
az-axi vmss show --name vmss-demo -g rg-demo
az-axi vmss get-instance-view --name vmss-demo -g rg-demo
az-axi disk list -g rg-demo
az-axi disk show --name disk-demo -g rg-demo
az-axi policy assignment list -g rg-demo
az-axi policy assignment show --name CostManagement
az-axi policy definition list
az-axi policy definition show --ids <definition-ARM-id>
az-axi policy set-definition list
az-axi policy set-definition show --ids <initiative-ARM-id>
az-axi policy state list --compliance NonCompliant
az-axi lock list
az-axi lock show --name sub-lock
az-axi deny-assignment list
az-axi deny-assignment show --ids <deny-assignment-ARM-id>
az-axi role definition list
az-axi role definition list --custom-role-only
az-axi role definition show --name <definition-GUID>
az-axi security pricing list
az-axi security pricing show --name VirtualMachines
az-axi security sub-assessment list --assessment-name <assessment>
az-axi security sub-assessment show --assessment-name <assessment> --name <finding>
```

Sentinel incident list and show use read-only ARM GETs against Microsoft.SecurityInsights (api-version 2025-09-01) on one Log Analytics workspace.
Show accepts `--name` / `-n` (also `--incident-id`) with an incident GUID or sequential incident number; full ARM IDs use `--ids`.
List and name-based show need `--workspace-name` and `--resource-group`, or `--workspace <alias|guid>` from the profile `workspaces` map, plus exactly one subscription.
`show --ids` takes exactly one incident ARM ID without workspace or name selectors; it uses the ID's subscription when no subscription scope is configured, otherwise that subscription must be included in the selected scope.
Alias and GUID workspaces resolve through the ARM workspace list by customer ID within that subscription.
`--status`, `--severity`, `--owner` (assignee name, email or UPN substring) and `--since` filter client-side; lists are newest first with `bySeverity` and `byStatus` aggregates.
Status and severity matches are case-insensitive and accept multiple values; owner matching is also case-insensitive.
`--since` filters creation time using a relative time such as `24h`, an ISO duration such as `P1D`, or an ISO date; no time filter applies by default.
List rows default to number, severity, title, status and time; `--full` adds full ARM IDs, owner and creation time and shows every fetched row; `--fields` selects row fields.
`--limit` defaults to 50 and accepts integers from 1 to 1000; `--full` ignores this display limit.
`--fields` accepts number, severity, title, status, time, id, created and owner, and takes precedence over the full row schema.
Show returns the description (truncated at 200 characters unless `--full`), owner, labels, provider, tactics and alert count.
Lists follow up to 10 pages and mark incomplete counts as lower bounds.
Number-based show and related reads search the same bounded incident list and report `INCOMPLETE_SEARCH` if the number is absent from fetched pages while more pages exist; use the GUID or ARM ID for a direct lookup.
Workspace GUID resolution stops at 100 pages and reports `INCOMPLETE_SEARCH` if more pages exist and uniqueness cannot be established; use workspace name and resource group to bypass discovery.
Related alerts (`incident list-alert`) and entities (`incident list-entity`) read one incident's related records through reviewed bodyless POSTs (api-version 2025-09-01) with the same incident and workspace selectors as show.
Alert rows default to name, alert, severity, status and time with `bySeverity` and `byStatus` aggregates; `--full` adds ARM IDs, tactics and product names, and `--fields` accepts these keys (id, tactics and product for the additions).
Entity rows default to kind, entity and name with `byKind` aggregates from the server metadata, falling back to returned entity counts when metadata counts are absent; `--full` adds ARM IDs, and `--fields` accepts kind, entity, name and id.
Both related commands use the same display limit as incident list; `--full` shows every returned row, and `--fields` takes precedence over the full row schema.
Neither related response pages.
Analytics rules (`sentinel alert-rule list|show`) and data connectors (`sentinel data-connector list|show`) read workspace configuration through plain ARM GETs (api-version 2025-09-01) with the same workspace selectors as incident show: `--name` takes the rule or connector ID with `--workspace-name` and `--resource-group` (or `--workspace <alias|guid>`), while `--ids` takes the full ARM ID alone.
List and name-based show require exactly one subscription; `show --ids` uses the ID's subscription when no subscription scope is configured, otherwise that subscription must be included in the selected scope.
Both lists follow up to 10 pages and mark incomplete counts as lower bounds; `--limit` defaults to 50 and accepts integers from 1 to 1000, while `--full` shows every fetched row.
Rule lists sort by display name with `byKind` and `byEnabled` aggregates (kinds include Scheduled, NRT, MicrosoftSecurityIncidentCreation and Fusion).
Rule rows default to name, rule, kind, enabled and severity; `--full` adds ARM IDs, tactics, templates and modification times.
Rule list `--fields` accepts name, rule, kind, enabled, severity, id, tactics, template and modified, and takes precedence over the full row schema.
Rule show returns the description and, for query-based kinds, the KQL query, each truncated at 200 characters unless `--full`.
Connector lists sort by name with `byKind` aggregates.
Connector rows default to name, kind and types (connected data types with state); `--full` adds ARM IDs plus tenant, subscription and modification metadata.
Connector list `--fields` accepts name, kind, types, id, tenant, subscriptionId and modified, and takes precedence over the full row schema.
Connector show returns all of that safelisted metadata by default; `--full` does not expand it.
Connector views project safelisted metadata only: secrets, keys and credential fields are never printed, and credential-returning actions are never called.
There is no rule or connector mutation command; query workspace tables with `logs query` to investigate further.
For the native incident update and comment create writes, see [Writes](#writes).
Management-group scope is unsupported; select one subscription explicitly.

Monitor reads (`monitor metrics alert list|show`, `monitor action-group list|show`, `monitor diagnostic-settings list|show`, `monitor metrics list`) use read-only ARM GETs against Microsoft.Insights: metric alert rules use api-version 2026-01-01; action groups use api-version 2023-01-01; diagnostic settings use api-version 2021-05-01-preview (the only version); metric definitions and values use api-version 2024-02-01.
Alert and action-group lists fan out across the selected subscriptions with `--resource-group` / `-g` scoping and exact, case-insensitive `--name` / `-n` filtering, sorted by name with `bySeverity`/`byEnabled` aggregates (alerts) and `byEnabled` plus receiver counts (action groups).
Alert and action-group show by name needs `--name` with `--resource-group` in exactly one subscription; `--ids` takes exactly one ARM ID of the same collection, uses the ID's subscription when no subscription scope is configured, and otherwise requires that subscription in the selected scope.
Alert rows default to name, severity, enabled, scopes and criteria (metric, operator, threshold); webhook action properties arrive as names only.
Action-group rows default to name, enabled, short name and receiver type counts; show also defaults to receiver counts, while `show --full` projects safelisted receiver metadata only (webhook URLs with query and fragment suppressed, credentialed URI values redacted, webhook property names without values; logic-app callback URLs and function trigger URLs never shown).
Diagnostic settings and metrics target exactly one `--resource <ARM-id>` (a resource, resource group or subscription ID for settings; a resource ID for metrics).
The target's subscription must be in the selected scope; diagnostic show by `--resource` and `--name` also requires exactly one selected subscription, or use `--ids <setting-ARM-id>` alone with the same subscription checks as alert show.
Setting rows default to name, enabled log and metric categories or category groups and destinations (storage account, workspace, event hub, marketplace partner); show returns every category with enabled flags and retention days plus the destination IDs.
Alert, action-group, diagnostic-setting and metric-definition lists default to 50 rows (`--limit` accepts 1-1000); `--full` shows every fetched row.
These lists follow up to 100 ARM pages per target and disclose incomplete counts as lower bounds.
Without `--metric`, metrics list returns the resource's metric definitions (metric, unit, supported aggregations) with a hint for the first metric's values; with `--metric <name>`, it returns values over a bounded window (`--start-time`/`--end-time`, ISO 8601 datetimes with a timezone, default last hour ending at `--end-time` or now, at most 31 days) with optional `--interval` and `--aggregation` (Average, Minimum, Maximum, Total, Count).
`--metric` and `--aggregation` accept multiple values; metric query errors fail the command.
Value rows default to metric, unit, point count, latest aggregation values and time, plus the window's `from` and `to`; `--full` expands timestamped points containing numeric aggregation values (capped at `--limit` per metric with disclosure).
Rule, action-group and setting mutations, subscription-scope metric batch queries, dimension filters and Application Insights data-plane queries stay out of scope.
Management-group scope is unsupported; select subscriptions explicitly.

Network reads (`network nsg|nic|vnet|public-ip|private-endpoint list|show`, `network dns zone list|show`, `network dns record-set list`, and `network dns record-set <type> list|show`) use read-only ARM GETs against Microsoft.Network: NSGs, NICs, VNets, public IPs and private endpoints use api-version 2024-05-01; public DNS zones and record sets use api-version 2018-05-01.
Lists fan out across the selected subscriptions (flags, environment, profile, else all accessible) with `--resource-group` / `-g` scoping and exact, case-insensitive `--name` / `-n` filtering, sorted by name with `byLocation` aggregates (record sets add `byType`).
Show by name needs `--name` with `--resource-group` in exactly one subscription; `--ids` takes exactly one ARM ID of the same collection and uses the ID's subscription when no subscription scope is configured, otherwise that subscription must be included in the selected scope.
Record-set list needs `--zone-name` with `--resource-group`, with an optional exact `--name` filter.
Type subgroups (`a`, `aaaa`, `caa`, `cname`, `mx`, `ns`, `ptr`, `soa`, `srv`, `txt`) provide typed list and show commands following Azure CLI grammar; the all-types `record-set list` is also available.
Typed show needs `--zone-name`, `--resource-group` and `--name`, or one record-set `--ids` of the selected type alone.
NSG show returns custom security rules (name, priority, direction, access, protocol, source, destination, ports) plus attached subnets and NICs; VNet show returns the address space, every subnet (prefix, NSG, route table) and every peering (state, remote VNet); NIC show returns every IP configuration plus NSG, virtual machine and MAC address; public-IP show returns the address, allocation, association, FQDN, SKU and zones; private-endpoint show returns the target service, connection state, subnet, NICs and custom DNS configs; zone show returns record counts and name servers; record-set show returns the TTL, FQDN and every routed value.
NSG list `rules` and show `totalRules` count custom rules only; Azure default security rules are excluded, including with `--full`.
`network nsg rule create` is the one native NSG write: it adds a single Deny rule to one existing NSG and is classified destructive, so it needs `--confirm <rule-name>` on top of every write gate; see [Writes](#writes).
Long nested rule, subnet, peering and IP-configuration lists are capped at `--limit` with their totals disclosed; `--full` shows every nested row.
Joined rule sources, destinations and ports, VNet list prefixes and subnet prefix lists, DNS list targets and individual DNS show values are shortened to 200 characters by default; shortened output includes a selector-preserving `--full` hint.
List rows default to compact fields (NSGs add the custom rule count, NICs the first IP configuration's private IP and the attached VM, VNets the prefixes and subnet count, public IPs the address and attachment, private endpoints the service and status, zones the record and name-server counts, record sets the type, TTL and joined targets); `--full` shows every fetched row with untruncated values.
For show, `--full` also adds safe metadata; `--fields` can select that metadata without `--full`, but does not expand capped rows or shortened values.
`--fields` selects only the list or show fields advertised by that leaf's `--help`, even when combined with `--full`; list and show field sets differ.
DNS A, AAAA and CNAME aliases return their target resource ARM ID instead of literal records; TXT chunks concatenate within each record, and SOA values include all seven components in host, email, serial, refresh, retry, expiry and minimum TTL order.
`--limit` defaults to 50 and accepts integers from 1 to 1000; lists follow up to 100 pages per subscription and mark incomplete counts as lower bounds.
Effective security rules, effective routes, Network Watcher diagnostics, DNSSEC signing keys and private DNS zones stay out of scope; native network writes are limited to [`network nsg rule create`](#writes).
`exposure` keeps its canned checks unchanged.
Management-group scope is unsupported; select subscriptions explicitly.

Compute reads (`vm list|show|get-instance-view`, `vmss list|show|get-instance-view`, `disk list|show`) use read-only ARM GETs against Microsoft.Compute: virtual machines and scale sets use api-version 2024-11-01; managed disks use api-version 2024-03-02.
Lists fan out across the selected subscriptions with `--resource-group` / `-g` scoping and exact, case-insensitive `--name` / `-n` filtering, sorted by name with `byLocation` aggregates.
Show by name needs `--name` with `--resource-group` in exactly one subscription; `--ids` takes exactly one ARM ID of the same collection and uses the ID's subscription when no subscription scope is configured, otherwise that subscription must be included in the selected scope.
VM list rows default to name, location, size, OS and the model provisioning state; lists carry no live power state.
`vm show` reads the model with `$expand=instanceView` in one GET and returns the live power and provisioning states from the instance-view statuses plus size, OS, image, disks and NICs; `vm get-instance-view` returns the dedicated runtime view with the agent version, fault and update domains and per-disk and per-extension statuses.
VMSS rows default to name, location, SKU, capacity, orchestration mode and provisioning state; show adds the upgrade-policy mode, computer-name prefix, image reference and zones.
`vmss get-instance-view` returns aggregate runtime `statuses` (code, displayStatus, level) and `vmStatuses` (code and count of VMs with that status), with total row counts for both arrays; per-VM-instance reads remain out of scope.
Both runtime commands accept the resource ARM ID, without an `/instanceView` suffix, and append the endpoint themselves.
Disk rows default to name, location, size in GiB, SKU, state and OS type; show adds the attachment, encryption type and network-access policy.
No view returns admin passwords, custom data, secrets, user data, keys, SAS URIs or boot-diagnostic blob URIs; only the computer name (VMs) or computer-name prefix (scale sets) is projected from OS profiles.
VM and scale-set actions (start, stop, restart, deallocate, reimage, run-command), disk grant-access and export, and image, snapshot, restore-point, gallery and host resources stay out of scope; there are no native compute mutation commands.
Data-disk, disk-status, extension and VMSS aggregate status rows are capped at `--limit` with totals disclosed; `--full` shows every nested row and adds safe metadata.
`--limit` defaults to 50 and accepts integers from 1 to 1000; lists follow up to 100 pages per subscription and mark incomplete counts as lower bounds.
Management-group scope is unsupported; select subscriptions explicitly.

Governance inventory reads (`policy assignment|definition|set-definition list|show`, `lock list|show`, `deny-assignment list|show`) use read-only ARM GETs against Microsoft.Authorization: assignments, definitions and initiatives use api-version 2021-06-01; locks use api-version 2020-05-01; deny assignments use api-version 2022-04-01.
Compliance states (`policy state list`) query the latest states through a reviewed bodyless read POST against Microsoft.PolicyInsights (api-version 2024-10-01); scan triggers, summaries, exemptions and remediations stay out of scope.
Lists fan out across the selected subscriptions with `--resource-group` / `-g` scoping (definitions and initiatives are subscription-scoped and reject `--resource-group`) and exact, case-insensitive `--name` / `-n` filtering.
Inventory records are deduplicated by case-insensitive full ARM ID across subscriptions before filtering, counting and limiting, so shared tenant-scoped built-ins appear once while distinct custom definitions remain separate.
State list applies client-side, case-insensitive filters: `--name` matches the exact resource name, `--assignment` the exact assignment name, and `--compliance` the compliance state (for example Compliant or NonCompliant).
States sort newest first with `byCompliance` counts; assignment lists carry `byEnforcement` counts, definition and initiative lists `byType` counts, lock lists `byLevel` counts and deny lists `byScopeKind` counts.
Totals and aggregates count fetched matches after filtering, before the display limit; incomplete paging leaves totals as lower bounds even when no fetched rows match.
Assignment rows default to name, scope, definition (the assigned policy or initiative) and enforcement; the effect lives on the definition, so the assignment hint points at `policy definition show` or `policy set-definition show` as appropriate.
Definition rows default to name, display, type (BuiltIn or Custom), effect and category; initiative rows replace the effect with the member definition count.
State rows default to resource, assignment, compliance, definition and evaluation time; full views expand ARM IDs.
Lock rows default to name, level (CanNotDelete or ReadOnly) and scope; deny rows default to name, scope, actions (denied control-plane actions) and dataActions (denied data-plane actions).
Lock and deny lists include resource-level records returned by the selected scope; showing a resource-level record requires `--ids`.
Deny detail output labels actions, dataActions, notActions and notDataActions separately and includes principals and excludePrincipals; each field supports `--fields` selection.
Show by name needs exactly one subscription with optional `--resource-group` scoping (assignments, locks, denies); definitions and initiatives show customs by name in one subscription and built-ins (tenant-scoped) with `--ids`.
`--ids` takes exactly one ARM ID of the same collection and uses the ID's subscription when no subscription scope is configured, otherwise that subscription must be included in the selected scope.
Long descriptions, rules, parameters, notes and action lists truncate at 200 characters with a selector-preserving `--full` hint; `--limit` defaults to 50 and accepts integers from 1 to 1000.
`--full` shows every fetched matching row, expands assignment definition IDs, and includes assignment exclusions and metadata or initiative member references in show views; `--fields` selects supported fields.
Definition show reads its version from `metadata.version`.
ARM lists follow up to 100 pages per subscription and compliance queries up to 10 service pages per subscription without imposing a query result limit; incomplete counts are disclosed as lower bounds.
There are no native policy-assignment, lock or deny-assignment mutation commands; generic `api` writes to these types are destructive under policy and require the existing destructive confirmation.
Deny assignments have no dedicated Azure CLI group: the spelling follows the ARM resource type.
Role definition reads (`role definition list|show`) use read-only ARM GETs against Microsoft.Authorization at api-version 2022-04-01.
Lists fan out across the selected subscriptions with optional `--resource-group` / `-g` scoping and carry built-in definitions alongside customs; `--name` / `-n` matches one definition GUID or role name (for example Reader), and `--custom-role-only` keeps custom roles.
Definition rows default to name (the GUID), role (the display name), type (BuiltInRole or CustomRole), actions and dataActions, with `byType` counts.
Show takes the definition GUID by name in one subscription with optional `--resource-group` / `-g` scoping, or one definition `--ids` alone (built-ins are tenant-scoped: show them with `--ids`); resolve a display name to its GUID with `role definition list` first.
Definition detail labels actions, dataActions, notActions and notDataActions separately and includes assignable scopes; `--full` expands these arrays and adds `createdOn` and `updatedOn`, which can also be requested through `--fields`.
There are no native role-definition mutation commands; generic `api` writes to role definitions are destructive under policy and require the existing destructive confirmation. Role assignments stay on `rbac list` (alias `role assignment list`).
Defender plan and finding reads (`security pricing list|show`, `security sub-assessment list|show`) use read-only ARM GETs against Microsoft.Security: pricings use api-version 2024-01-01; sub-assessments use api-version 2019-01-01-preview (the only version).
Pricing lists fan out across the selected subscriptions with exact, case-insensitive `--name` / `-n` plan filtering; rows default to name (the plan), tier (Free or Standard), subPlan and coverage, with `byTier` counts.
Pricing show takes the plan name in one subscription, or one pricing `--ids` alone (resource-scoped pricings need `--ids`); it returns the tier, subPlan, enablement and trial times, enforcement, coverage, deprecation, replacement plans and extensions with their enabled state; `--full` expands extension entries and includes their additional properties.
Sub-assessment lists use the subscription list-all across the selected subscriptions, worst severity first, with `byStatus` and `bySeverity` counts; rows default to name, assessment (the parent assessment), resource (the assessed resource's final ARM path segment, expanded to its full ID with `--full`), status and severity.
Sub-assessment list applies client-side, case-insensitive filters: `--assessment-name` keeps one parent assessment, `--assessed-resource-id` keeps findings for one assessed resource ARM ID (it must sit in a selected subscription), and `--name` / `-n` matches one exact finding name.
Sub-assessment show needs `--assessment-name` plus `--name` / `-n` in one subscription (add `--assessed-resource-id` for a resource-scoped finding), or one finding `--ids` alone; it returns the display name, description, category, impact, remediation, assessed resource, status code, cause, severity and generation time, with `vulnId` and `additionalData` in `--full` or when selected through `--fields`.
Long descriptions, impacts, remediations, rules and action lists truncate at 200 characters with a selector-preserving `--full` hint; `--limit` defaults to 50 and accepts integers from 1 to 1000.
There are no native Defender plan or assessment mutation commands (`security pricing create` stays out); plan changes stay on generic `api` writes behind the existing gates. Alert status updates stay on `security alert update` and assessment summaries on `defender assessments`.
Management-group scope is unsupported; select subscriptions explicitly.

Discovery uses live ARM GETs.
Lists and name-based shows use subscription flags, environment or profile scope, otherwise all accessible subscriptions.
`resource show --ids` uses the ID's subscription when no subscription scope is configured; otherwise that subscription must be included in the selected scope.
Unambiguous subscription names resolve to IDs without changing the Azure CLI account default.
Lists default to 50 compact metadata rows with full IDs, counts and explicit empty states.
`--fields` selects metadata fields; `--full` expands metadata and shows every fetched row.
Group views default to name, id, location and state; `--fields state` selects the group's provisioning state even with `--full`.
`resource list --resource-group` scopes the list; `--name` and `--resource-type` filter exact, case-insensitive matches.
Generic `resource show` returns only the ARM envelope: id, name, type, kind, location, tags, sku, identity type and provisioningState.
Its default view shows name, id, type and location; `--full` expands the envelope, and `--fields` selects envelope fields only.
Provider `properties` and nested field paths are rejected by `--fields`; no show view returns the raw properties blob.
Use typed commands for provider details, or the raw `az-axi api` path with its existing redaction.
Group and resource paging stops at 100 pages per subscription and marks incomplete counts as lower bounds.
Show by name requires one subscription; resource show also requires `--resource-group` and `--resource-type`, or exactly one `--ids` instead.
Resource show selects the newest stable provider API version unless `--api-version` is supplied.
Credential-bearing child resources and actions are refused before retrieval.
Management-group discovery is unsupported; select subscriptions explicitly.

`account list/show` reads live ARM subscription metadata within the same discovery scope, resolving subscription names to IDs.
This differs from Azure CLI's cached account list: it uses the selected profile identity and flags/environment/profile subscriptions, otherwise all accessible subscriptions.
`account show` requires exactly one selected subscription and never changes defaults or chooses an ambient Azure CLI account.
The legacy `sub list` still lists all visible subscriptions with `inScope` markers.
Account defaults are name, subscription GUID id, state and tenantId; `--full` adds armId, authorizationSource, quotaId, spendingLimit and locationPlacementId.
Account `--fields` selects only these metadata fields.
Workspace lists default to name, ARM id, location and customerId (the GUID used for Log Analytics queries).
Workspace list accepts `--resource-group` / `-g` to scope the list and `--name` / `-n` to filter exact names case-insensitively.
Workspace show accepts exactly one workspace `--ids`, or `--resource-group` plus `--workspace-name` (also `--name` / `-n`) within one subscription.
An ID's subscription is used only when no subscription scope is configured; otherwise it must belong to selected scope.
Full workspace views and `--fields` expose only documented metadata: name, id, type, location, tags, customerId, state, retentionInDays, sku, publicNetworkAccessForIngestion and publicNetworkAccessForQuery.
Shared keys, arbitrary provider properties and credential-bearing children/actions are excluded before output; child/action selectors are refused before retrieval.
Account lists follow up to 100 pages of the subscription catalogue; workspace lists follow up to 100 pages per subscription.
Both default to 50 displayed rows; `--full` shows all fetched rows, and incomplete counts are lower bounds.
Existing command scope, defaults and aliases are unchanged.

One example per inspection command; see [Profiles](#profiles) for `config init` and `config path` examples.
Every command also accepts `--help` with its full reference.

The machine-readable exact leaf registry in [src/lib/registry.ts](src/lib/registry.ts) owns dispatch metadata, Azure effect declarations, capability definitions and the existing grouped help.
Its generated [agent skill command list](skills/az-axi/SKILL.md#orientation) records each leaf's capability and Azure effect.
The registry includes additive az-shaped paths for existing native operations and does not claim coverage for other Azure commands.
`api` retains its request-classified dynamic effect and all write safeguards; `config init` has no Azure effect.
Offline tests fail when help or the committed skill command list diverges from the registry.

```
az-axi                                                  # dashboard: profile, identity, subscriptions, alerts, score, exposure, writes
az-axi home                                             # the same dashboard
az-axi doctor                                           # check az, tokens, ARM reachability and write status per profile
az-axi config list                                      # profiles with scope, write status and description
az-axi sub list                                         # subscriptions visible to the identity
az-axi rg query --file query.kql                        # Resource Graph query across subscriptions
az-axi rbac list --privileged                           # role assignments for privileged roles
az-axi activity list --since 24h --status Failed        # activity log across subscriptions, newest first
az-axi defender alerts --severity High                  # active Defender alerts
az-axi defender alerts get /subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Security/locations/westeurope/alerts/example-alert  # details for a full alert resource ID from the list
az-axi security alert update -s 00000000-0000-0000-0000-000000000001 -l westeurope -n example-alert --status dismiss  # gated preview only
az-axi defender assessments --severity High             # recommendations grouped with unhealthy counts
az-axi defender score                                   # secure score per subscription, lowest first
az-axi sentinel incident list -g rg-demo --workspace-name logs-demo -s <subscription>  # Sentinel incidents, newest first
az-axi sentinel incident show --name 3177 --workspace sentinel  # one incident by GUID or number
az-axi sentinel incident list-alert --name 3177 --workspace sentinel  # related alerts for one incident
az-axi sentinel incident list-entity --name 3177 --workspace sentinel  # related entities for one incident
az-axi sentinel alert-rule list -g rg-demo --workspace-name logs-demo -s <subscription>  # analytics rules, by display name
az-axi sentinel alert-rule show --name <rule-id> --workspace sentinel  # one analytics rule with description and query
az-axi sentinel data-connector list -g rg-demo --workspace-name logs-demo -s <subscription>  # data connectors, safelisted metadata only
az-axi sentinel data-connector show --name <connector-id> --workspace sentinel  # one data connector
az-axi sentinel incident update -s <subscription> --name 3177 -g rg-demo --workspace-name logs-demo --status Closed --classification FalsePositive --classification-reason IncorrectAlertLogic  # gated preview only
az-axi sentinel incident comment create -s <subscription> --incident-id <incident-id> -g rg-demo --workspace-name logs-demo --message Triaged  # gated preview only
az-axi exposure --check mgmt-ports                      # NSGs exposing management ports
az-axi logs query --file hunt.kql --workspace sentinel   # Log Analytics KQL (see Query logs)
az-axi api /subscriptions --api-version 2022-12-01      # escape hatch for any read or query request
az-axi az group show -n rg-demo --subscription <uuid>   # pinned, reviewed Azure CLI read
az-axi storage container list --account-name stexample # container properties using Entra auth
az-axi storage container show --account-name stexample --name example
az-axi storage blob list --account-name stexample --container-name example
az-axi storage blob show --account-name stexample --container-name example --name folder/example.txt
az-axi keyvault secret list --vault-name kvexample     # secret properties and expiry using Entra auth
az-axi keyvault key list --vault-name kvexample
az-axi keyvault certificate list --vault-name kvexample --expiring-within 30d
az-axi acr repository list --name myregistry  # registry catalog using Entra token exchange
az-axi acr repository show-tags --name myregistry --repository hello-world
az-axi acr manifest show-metadata --registry myregistry --name hello-world:latest
az-axi op status '<operation-url>' --profile work       # read the current result of a pending operation
```

See [Profiles](#profiles) for selector flags and environment overrides, and [Behavior](#behavior) for output controls.

### Storage metadata reads

`storage container list|show` and `storage blob list|show` use native public Azure Blob REST reads with forced Entra bearer authentication, equivalent to `--auth-mode login`.
That is the only accepted auth mode.
List calls use GET with `comp=list`; show calls use HEAD for properties and never download blob content.
No account key lookup, SAS, connection string, anonymous fallback, credential command or local output file is supported.
Azure CLI storage config and `AZURE_STORAGE_*` credentials/defaults are never consumed.
Only internal `az account get-access-token --resource https://storage.azure.com/` token acquisition runs for az-auth profiles, with a bounded, sanitized child environment and extensions disabled.
Token profiles require `$AZ_AXI_STORAGE_TOKEN`, or a custom environment variable named by `tokenEnv.storage` in the profile; they never use ambient az login or ARM tokens as a fallback.

`--account-name` explicitly selects the account; subscription and management-group selectors do not filter this data plane.
Blob commands require `--container-name`; show also requires `--name` (`-n`).
Lists fetch one page with `--limit` (default 50, integer 1-1000), optional `--prefix`, and optional `--marker`.
Blob `--name`, list `--prefix` and opaque `--marker` values are preserved literally, including surrounding or whitespace-only values; empty values are refused.
Quote shell-sensitive values and use inline assignment for values beginning with a dash, such as `--prefix=-reports`.
Account and container names retain strict service-name validation.
When `nextMarker` is present, the count is a lower bound and the output includes a continuation command; an empty page can still have a continuation.
Outputs allow only name, lastModified, etag and publicAccess for containers, or size and blobType for blobs.
`--fields` selects from those properties; `--full` preserves the same safe schema and page bound.
User metadata, tags, blob contents and all secret values are excluded, including from errors.
Redirects and arbitrary endpoints are refused; responses have a 30-second deadline and list XML has a 1 MiB bound.
Entra access needs Blob data RBAC permissions for the operation; a denied read fails without trying other authentication.
See Microsoft's [List Containers](https://learn.microsoft.com/rest/api/storageservices/list-containers2), [List Blobs](https://learn.microsoft.com/rest/api/storageservices/list-blobs), [Get Container Properties](https://learn.microsoft.com/rest/api/storageservices/get-container-properties) and [Get Blob Properties](https://learn.microsoft.com/rest/api/storageservices/get-blob-properties) contracts.

### Key Vault metadata reads

`keyvault secret|key|certificate list` use native public Azure Key Vault REST property listings (api-version 7.4) with forced Entra bearer authentication.
Only the collection endpoints are ever called: `GET /secrets`, `/keys` and `/certificates` on `{vault}.vault.azure.net`, plus service continuations validated back to the same vault and collection.
Single-object endpoints (`/{collection}/{name}[/{version}]`), which return secret values or key material, are never constructed.
Secret download, key export and backup, certificate download with private key, deleted-object, purge, recover, set and rotation operations have no command path and are refused as unknown paths before transport.
Only internal `az account get-access-token --resource https://vault.azure.net/` token acquisition runs for az-auth profiles, with a bounded, sanitized child environment and extensions disabled.
Token profiles require `$AZ_AXI_VAULT_TOKEN`, or a custom environment variable named by `tokenEnv.vault` in the profile; they never use ambient az login or ARM tokens as a fallback.

`--vault-name` explicitly selects the vault; subscription and management-group selectors do not filter this data plane.
Vault names retain strict service-name validation.
Lists page through the service continuation until `--limit` matching rows (default 50, integer 1-1000), the end of the collection or the 40-page scan cap.
A trailing `+` on the count means the listing is incomplete: matching rows were omitted or service pages remain unscanned.
Increasing `--limit` cannot extend the 40-page scan cap; an incomplete empty scan does not establish that no matching objects exist.
`--expiring-within 30d` (also `Nh` or `Nm`) filters client-side to items expiring after now and no later than the end of the window; already expired items and items without an expiry are excluded.
Lists default to name, enabled and expiresOn; `--fields` or `--full` expands to the safe schema (notBefore, created, updated, contentType for secrets, thumbprint for certificates, managed).
`--full` retains both the row limit and scan cap; `--fields` selects only safe columns and takes precedence over `--full`.
Tags, secret values, key material and certificate bytes are excluded, including from errors.
Redirects and arbitrary endpoints are refused; credential acquisition and all list pages share a 30-second deadline, and each list body has a 1 MiB bound.
Entra access needs Key Vault data-plane list permission for the collection; a denied read fails without trying other authentication.
See Microsoft's [Get Secrets](https://learn.microsoft.com/en-us/rest/api/keyvault/secrets/get-secrets?view=rest-keyvault-secrets-7.4), [Get Keys](https://learn.microsoft.com/en-us/rest/api/keyvault/keys/get-keys?view=rest-keyvault-keys-7.4) and [Get Certificates](https://learn.microsoft.com/en-us/rest/api/keyvault/certificates/get-certificates?view=rest-keyvault-certificates-7.4) contracts.

### ACR metadata reads

`acr repository list|show-tags` and `acr manifest show-metadata` follow az's group/subgroup/verb grammar with native registry data-plane reads using Entra-based token exchange only.
The Entra token (audience `https://containerregistry.azure.net`) is exchanged at the registry's own `oauth2/exchange` endpoint for a refresh token, then at `oauth2/token` for a pull-scoped access token (`registry:catalog:*` for the catalog, `repository:<name>:pull` for tags and manifests).
No `docker login`, admin-user password, credential export (`listCredentials`, `regenerateCredential`), image pull, blob download or local output file is supported.
`--username`, `--password`, `--suffix`, `--image`, `--file`, `--detail` and `--execute` are refused before any transport, as are delete/untag/update paths.
Only internal `az account get-access-token --resource https://containerregistry.azure.net` token acquisition runs for az-auth profiles, with a bounded, sanitized child environment and extensions disabled.
Token profiles require `$AZ_AXI_REGISTRY_TOKEN`, or a custom environment variable named by `tokenEnv.registry` in the profile; they never use ambient az login or ARM tokens as a fallback.

`--name` (`-n`) on repository leaves and `--registry` on the manifest leaf explicitly select the registry; the public login server `<registry>.azurecr.io` is built from the validated registry name, and subscription and management-group selectors do not filter this data plane.
`show-tags` requires `--repository`; `show-metadata` requires `--name` (`-n`) as `repository:tag` or `repository@digest` (login-server-qualified IDs are refused).
Named tags resolve through one exact manifest GET, never by scanning tag lists.
Lists fetch one page with `--limit` (default 50, integer 1-1000) and optional `--marker`, continuing from the service Link header; `show-tags` also accepts `--orderby time_asc|time_desc` (az vocabulary).
`--limit` does not apply to `show-metadata` and is refused there.
Registry, repository and reference values retain strict service-name validation.
When `nextMarker` is present, the count is a lower bound and the output includes a continuation command; an empty page can still have a continuation.
Repository rows carry only the name; tag rows carry name, digest, createdTime and lastUpdateTime; manifests project digest (from `Docker-Content-Digest`), mediaType, schemaVersion, config, layers and manifests only.
Config and layer descriptors contain digest and optional mediaType and size; manifest-list/index entries use the same descriptor fields plus optional platform architecture, os and variant.
`--fields` selects from those properties; `--full` preserves the same safe schema and page bound.
Signatures, history, download URLs, blob contents and all secret values are excluded, including from errors.
Redirects and arbitrary endpoints are refused; credential acquisition, token exchange and the metadata request share a 30-second deadline, and each token or data response has a 1 MiB bound.
Entra access needs AcrPull on the registry; a denied read fails without trying other authentication.
See Microsoft's [Get Repositories](https://learn.microsoft.com/en-us/rest/api/registry-dataplane/container-registry/get-repositories?view=rest-registry-dataplane-2021-07-01), [Get Tags](https://learn.microsoft.com/en-us/rest/api/registry-dataplane/container-registry/get-tags?view=rest-registry-dataplane-2021-07-01), [Get Manifest](https://learn.microsoft.com/en-us/rest/api/registry-dataplane/container-registry/get-manifest?view=rest-registry-dataplane-2021-07-01) and [token exchange](https://learn.microsoft.com/en-us/rest/api/registry-dataplane/authentication/exchange-aad-access-token-for-acr-refresh-token?view=rest-registry-dataplane-2021-07-01) contracts (api-version 2021-07-01).

These az-shaped paths run the same native operation as the legacy path, with identical TOON output and scope:

| Az-shaped path | Legacy path | Native behavior |
|---|---|---|
| `graph query -q <kql>` | `rg query <kql>` | Resource Graph; profile scope applies; default 50 rows |
| `monitor log-analytics query --analytics-query <kql> --workspace <alias-or-guid>` | `logs query <kql> --workspace <alias-or-guid>` | Single workspace; default P1D timespan |
| `role assignment list --assignee <id-or-upn>` | `rbac list --principal <id-or-upn>` | Cross-subscription analysis including inherited assignments |
| `monitor activity-log list --offset 24h` | `activity list --since 24h` | Default 24h; newest first across subscriptions |
| `security alert list` | `defender alerts` | Active alerts by default |
| `security secure-scores list` | `defender score` | Per-subscription scores, lowest percentage first |

All legacy paths remain available.
Command paths must be complete and contiguous; put command flags after the full leaf path.
Global selector and display flags may precede the command, with one token per value; use commas or repeated flags for leading lists.
`--assignee` and `--offset` are accepted on their az-shaped paths only; legacy paths retain `--principal` and `--since`.
`rg query` continues to mean Resource Graph; use `group list/show` for resource groups and `resource list/show` for ARM resources, as described [above](#use).
For native account and workspace discovery, see the [discovery reference above](#use).
Raw assessment lists and alert name/location selectors for reads remain separate additions.
For the native alert status write and its legacy alias, see [Writes](#writes).
The aliases expose az grammar with the existing analyst defaults; they do not claim full Azure CLI semantics.

`graph query` and `monitor log-analytics query` are the canonical query paths; `rg query` and `logs query` remain aliases with their existing flags and output keys.
For inline KQL, use `--graph-query` / `-q` on `graph query` or `--analytics-query` on `monitor log-analytics query`.
Both canonical paths also accept `--file` or piped stdin; choose one query source, with no positional KQL.
Graph accepts `--subscriptions a b` (also `--subscription` / `-s a b`), `--management-groups a b`, `--first` as an alias for `--limit` (maximum 1000), and `--skip-token`.
Explicit subscription and management-group scope families are mutually exclusive on the canonical Graph path.
The singular `--management-group` selector remains accepted, but cannot be combined with `--management-groups`.
Without explicit scope, the profile management group takes precedence over profile subscriptions; without either, all accessible subscriptions are queried.
Azure CLI's Graph default is all accessible subscriptions, while az-axi honors profile scope and defaults to a 50-row page.
`--full` retains the existing 1000-row Graph page cap; `--skip` and `--allow-partial-scopes` are rejected.
Graph pagination hints retain the legacy `rg query` path, except queries using `--management-groups` receive a `graph query` hint that preserves the plural scope.
Log Analytics accepts `--workspace` / `-w` and `--timespan` / `-t`; workspace aliases and the P1D default remain, while Azure CLI defaults to all available data.
The selected timespan is included in TOON output as `timespan`.
Additional workspaces are unsupported.

The following parsing rules apply to native leaves; passthrough uses the stricter rules in the [passthrough reference](#pinned-azure-cli-read-catalogue).
Use `-h` for leaf help, `-s` for subscription (also before the command), `-g` for resource-group, `-n` for name, `-l` for location, and `-w`/`-t` for workspace/timespan where the leaf accepts those long flags.
After the complete leaf path, list flags accept commas, spaces or repetition, such as `--subscription a b --subscription c` or `--severity High Medium`.
For the literal `tag update --tags` exception, see [Writes](#writes).
On leaves taking positional input (`rg query`, `logs query`, `api`, `op status`, `defender alerts get`), lists consume one token per flag to preserve existing argument placement; use commas or repeated flags there.
Canonical query paths use named query input and accept space-separated lists after the full leaf path.
Boolean flags accept a bare flag, `--full=false`, or `--full false`.
Repeated scalar and boolean flags may repeat the same value; conflicting values are refused.
`--` ends flag parsing and protects literal positional input.
Unknown flags, short clusters or abbreviations, and missing values fail with exit 2 before requests.
`--query` retains its HTTP-parameter meaning only on `api`; output JMESPath and `--output` are unsupported.

### Pinned Azure CLI read catalogue

[src/lib/azReadCatalogue.ts](src/lib/azReadCatalogue.ts) is the sole allowlist for `az-axi az ...` read passthrough.
The generated artifact's catalogue-only status describes its maintenance workflow; execution lives in the separately validated consumer.
The generated catalogue owns the exact allowlist, handler and operation mappings, runtime and SDK version pins, profiles, clouds, platforms and approved extension set.
This is a source audit, not a live runtime certification; no Azure CLI handler is imported or executed to build it.
`group list` is deliberately excluded because its official registration uses a custom handler.

Each entry records argument constraints, authentication and permission needs, exact operations, an output schema identifier and immutable source commits, line ranges and excerpt hashes.
The consumer validates its `arguments` and `argumentPolicy`, requires matching az-auth tenant/subscription context, forces JSON transport, disables prompts and dynamic extension installation, then normalizes output to TOON.
Token profiles do not authorize ambient az identity use.

Only `az-axi az group show --name <name> --subscription <uuid>` can run, using the trusted official Azure CLI version pinned in the [generated catalogue](src/lib/azReadCatalogue.ts), AzureCloud/latest and **no extensions in the isolated child runtime**.
The configured profile must use `auth: "az"`, an explicit tenant UUID and exactly one subscription matching the flag.
Implicit profiles, management groups and environment tenant/subscription overrides are refused.
`--profile` and `--config` select the wrapper profile; name aliases `-n`, `-g` and `--resource-group` come from the catalogue.
`--subscription` has no short alias and accepts one UUID; every argument may occur only once, including aliases.
`--full` accepts a bare flag or `--full=true` / `--full=false`, without a separate boolean value.
`--fields` accepts comma-separated id, name, location and state, and cannot be combined with `--full=true`.
Default TOON reports `resourceGroup` with id, name, location and state; `--fields` selects these columns and `--full` adds tags.
Raw resource properties are never returned, including with `--full`.

Unknown commands, mutations, credential commands, unsupported flags, duplicate aliases and invalid arguments produce **zero child executions**, including preflight probes.
Before any probe, the consumer refuses an unsupported catalogue schema, a missing generation version, a non-read entry or an entry runtime version that differs from `generatedFrom.azureCliVersion`.
Regenerate and review the catalogue to resolve these inconsistencies; installed CLI/core version mismatches are refused by the version probe.
Approved arguments permit only fixed `az version --output json`, `az cloud show --output json` and `az account show --output json` probes, in that order.
These validate CLI/core versions, extension set, cloud/API profile, ARM endpoint and an enabled account with a named user/service principal matching the profile tenant/subscription.
Profiles do not pin a principal name; identity matching means the selected az-auth account in that tenant/subscription.
Any preflight mismatch produces **zero executions of the requested read**, although earlier fixed probes have run.
Probe argv never contains caller arguments.
The read receives only canonical catalogue flags plus forced JSON output.
`--query`, `--output`, `--debug`, `--ids`, `--execute`, credential retrieval, local destinations, data-plane reads and all child-process writes are unavailable.

Every process has closed stdin, a 30-second deadline and a combined stdout/stderr ceiling of 1 MiB.
Per-process overrides disable automatic upgrades and file logging even when enabled in saved Azure CLI configuration.
Cancellation terminates the process, including the Windows shim tree.
The child inherits only platform/path, selected Azure config directory, locale and proxy/CA environment settings; token and logging overrides are stripped.
Before every probe and read, `AZURE_EXTENSION_DIR` and `AZURE_EXTENSION_SYS_DIR` point to a fresh empty temporary directory and `AZURE_EXTENSION_DEV_SOURCES` is cleared.
This prevents installed user, system or development extensions from loading before the version probe; catalogue `extensions: []` describes this effective isolated runtime.
All temporary extension directories are removed after success, failure or cancellation.
`AZURE_CONFIG_DIR` and the signed-in identity/context are preserved.
Failures become structured AXI errors without raw child diagnostics.
This assumes a trusted Azure CLI installation and local login/configuration; probes cannot certify a tampered executable.
Native commands, aliases and every existing write gate remain unchanged.

Unknown command, version, extension, handler or operation means **write/refusal**, including custom handlers and transitive operations.
Keys, connection strings, SAS, secret values, credentials and similar actions never become reads based on a `list` verb, GET method or output filter.
The generator reads pinned official excerpts as text, without Python, extension imports, child execution, network access or dynamic discovery.

```sh
node scripts/az-read-catalogue.mjs --help
pnpm catalogue:generate
pnpm catalogue:check
```

These maintenance commands require a source checkout with development dependencies installed.
[scripts/az-read-catalogue.sources.json](scripts/az-read-catalogue.sources.json) holds the reviewed excerpts.
To refresh, retrieve the referenced files at immutable Microsoft commits using `gh-axi api repos/<owner>/<repo>/contents/<path>?ref=<commit>`, review the registration, arguments, client factory, dependency/profile and complete SDK operation chain, then update the source snapshots and generator's integrity and CLI/SDK provenance pins together.
The generated `generatedFrom` metadata records the CLI version and commit and SDK package and version.
Excerpts preserve each inclusive line range with its surrounding whitespace trimmed; separated ranges are then joined by a newline.
Regenerate and review the artifact diff, then run the catalogue tests and full offline suite.
The generator never promotes newly discovered commands; broadening the allowlist requires explicit code and provenance review.
Offline tests check reproducibility, refusal invariants and zero network/child execution; catalogue maintenance does not require an Azure account.

## Behavior

Resource inspection commands bound rows and long cells by default, except `api` lists have no default row cap.
Use `--limit N` to cap rows and `--fields a,b` to select list columns.
`--full` expands truncated cells and removes display row limits for most inspection lists; `rg query` keeps its page cap, and `logs query` and `api` still honor `--limit`.
For storage's fixed schema and page bound, see [Storage metadata reads](#storage-metadata-reads).
For key vault's minimal default list schema and page bound, see [Key Vault metadata reads](#key-vault-metadata-reads).
For the registry equivalents, see [ACR metadata reads](#acr-metadata-reads).
`api` follows additional pages only with `--all`, subject to a page cap.
For JSON request bodies, use `--body-file <path>` or pipe JSON on stdin, for example `az-axi api POST /providers/Microsoft.ResourceGraph/resources --api-version 2024-04-01 --body-file query.json` or the same command with `< query.json` instead of `--body-file query.json`.
Inline `--body` remains supported; choose exactly one source.
Bodies accept any JSON value, including strings, numbers, booleans and null, and preserve its JSON type in the request.
Conflicting sources, unreadable files and invalid JSON are refused before requests; empty stdin means no body.
All input forms use the same request classification and write safeguards.
Paging hints retain `--body-file` paths; for stdin bodies, replace the hint's `<body-file>` placeholder with a file containing the original JSON before rerunning with `--all`.
Use each command's `--help` for its defaults and paging limits.

Command output replaces recognized secret fields and values with `***redacted***`, including nested objects and arrays.
Shared redaction also replaces complete absolute network URI values containing userinfo with `***redacted***`; URI values without recognized secrets or userinfo are preserved exactly.
Monitor action-group receiver projections additionally suppress URI queries and fragments.
Parameter values, defaults and allowed values are redacted when their parameter name is recognized as secret or their declaration uses `secureString` or `secureObject`.
Supplied deployment parameter values are also matched against secure declarations in the paired inline template, including nested deployments.
Errors render as TOON with a `code` and `help[]` suggestions when available.
Unexpected errors use `UNKNOWN` with exit code 1 and no `help[]`.
Exit code 0 means successful completion; exit code 2 covers usage and access errors, and exit code 1 covers other failures, including network failures before a response is received.
See [Writes](#writes) for the read-only policy.

| Code | Exit | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 2 | Bad flag value, missing argument, unknown command |
| `UNKNOWN_FLAG` | 2 | Flag not accepted by this command; the error names a known replacement or lists valid flags |
| `PASSTHROUGH_FAILED` | 1 | Azure CLI child failure, invalid JSON, cancellation or exceeded time/output bounds |
| `AUTH_REQUIRED` | 2 | Not signed in, token missing or expired |
| `FORBIDDEN` | 2 | Signed in, but RBAC denies access; the hint names the role needed |
| `NOT_FOUND` | 2 | Subscription, workspace or resource not found |
| `READ_ONLY` | 2 | Request class not permitted for this resource |
| `WRITES_DISABLED` | 2 | Write or destructive request blocked because writes are disabled |
| `SUBSCRIPTION_NOT_WRITABLE` | 2 | Write target is outside the profile's configured subscriptions |
| `CONFIRM_REQUIRED` | 2 | Destructive execution needs `--confirm <resource-name>` |
| `CONFIRM_MISMATCH` | 2 | Confirmation does not match the target resource name |
| `PRECONDITION_FAILED` | 1 | HTTP 412: ETag mismatch; re-run the dry run before retrying |
| `OPERATION_FAILED` | 1 | Long-running operation reported Failed or Canceled |
| `OPERATION_TIMEOUT` | 1 | Polling budget expired; use the suggested `op status` command |
| `CONFLICT` | 1 | HTTP 409 from ARM, an NSG rule found at the pre-write check, or a post-write rule mismatch; see [Writes](#writes) |
| `VERIFY_FAILED` | 1 | NSG rule PUT was sent, but the immediate post-write read failed; see [Writes](#writes) |
| `TLS_ERROR` | 1 | Certificate trust failure; see TLS-inspecting proxies in Configure |
| `RATE_LIMITED` | 1 | HTTP 429 or throttled; the hint carries the retry delay |
| `NETWORK_ERROR` | 1 | The request could not be sent |
| `API_ERROR` | 1 | Anything else, with the HTTP status and ARM `error.code` |

## Check an operation

Inspect an existing Azure long-running operation using the URL from its `Azure-AsyncOperation` or `Location` response header.
Pass exactly one absolute HTTPS URL on `management.azure.com`, including its `api-version` query parameter.

```
az-axi op status 'https://management.azure.com/<operation-path>?api-version=<v>'
```

This checks the current state once; re-run the suggested command if the operation is still running.
The suggested command retains the selected config file, profile and tenant.
Output preserves the response payload, including `status` and completed results such as `properties.changes`.
A string `status` in the response body identifies the operation state; Succeeded, Failed and Canceled are terminal, matched case-insensitively, and other states are still running.
Without a string body status, output adds `operation` (the URL), `state` and `status` (the HTTP status); HTTP 202 means InProgress and other successful HTTP responses mean Succeeded.
Failed and Canceled are reported as operation states with any returned error details; a successful status lookup still exits 0.
Returned error details remain in the response payload as `error.code` and `error.message`; request failures use the normal [error categories](#behavior).
For automatic polling during write execution, see [Writes](#writes).

## Writes

Writes are disabled by default.
To permit `api` and native write previews and execution, a human must hand-edit the selected profile with `"allowWrites": true` and a non-empty `subscriptions` list.
Find the selected configuration file with `az-axi config path`, then edit only the intended profile.
No az-axi command enables writes.
A profile with an invalid write configuration is rejected before it is used.
Writes are limited to ARM; Graph and Log Analytics accept only reads and supported queries.

`security alert update` (legacy alias `defender alerts update`) supports exactly one named Defender alert and one of `--status dismiss|resolve|activate`.
It requires `--location / -l` and `--name / -n`, with optional `--resource-group / -g`; omission selects subscription scope.
`--subscription / -s` requires a single explicit subscription ID; names and implicit env/profile scope are not accepted.
The preview reads the alert and shows its current and desired status, plus the exact native execute command.
Execution reads again, skips matching status without a POST or log entry, and otherwise sends one bodyless `POST .../Microsoft.Security/locations/<location>/alerts/<name>/<action>?api-version=2022-01-01` through the shared pipeline.
These Defender actions do not document ETag/If-Match support.
An explicit `--if-match` is forwarded, but no concurrency guarantee is claimed even when the read returns an ETag.
`--execute`, write logging, asynchronous operation handling, read-only gates and the Claude approval hook apply as for `api`.
Only the three named actions are supported; batches, `inprogress`, body input and credential actions are refused.

`sentinel incident update` sets status, severity, owner and classification on exactly one Sentinel incident.
Incident selection mirrors `incident show`: `--name / --incident-id` takes the incident GUID or its sequential number with `--workspace-name` and `--resource-group` (or `--workspace <alias|guid>`), while `--ids` takes the full incident ARM ID alone.
`--subscription / -s` requires a single explicit subscription ID; names and implicit env/profile scope are not accepted.
At least one of `--status New|Active|Closed`, `--severity High|Medium|Low|Informational`, `--owner <object-id|email|name>` or `--classification Undetermined|TruePositive|BenignPositive|FalsePositive` is required.
Closing (`--status Closed`) requires `--classification`; a concrete classification requires `--classification-reason SuspiciousActivity|SuspiciousButExpected|IncorrectAlertLogic|InaccurateData`, with optional `--classification-comment`.
`--owner` takes one identity: a GUID becomes `objectId`, text with `@` becomes email, anything else becomes the assigned-to name.
When that identity already matches the current owner, its existing metadata is preserved: object IDs and email or user principal name match case-insensitively; assigned-to names match exactly.
The preview re-reads the incident and shows the field-level diff plus the exact native execute command.
Execution re-reads again, returns a no-op without a PUT or log entry when nothing would change, and otherwise sends one merged `PUT .../Microsoft.SecurityInsights/incidents/<incident-id>?api-version=2025-09-01` (GET-merge-PUT, as az does) through the shared pipeline.
The preview's execute command includes `--if-match <etag>` when the read returns an ETag, pinning the reviewed value.
Without `--if-match`, execution uses the fresh re-read ETag when available, protecting only against changes between that read and the PUT.

`sentinel incident comment create` appends one comment to exactly one Sentinel incident, selected with `--incident-id` (GUID or number, with workspace selectors) or `--ids`.
`--message` is required; each invocation generates a new comment GUID, so executing the preview's command uses a fresh ID rather than the previewed ID.
Existing comments cannot be edited with this command; repeated execution adds another comment.
The preview reports the new comment resource; execution sends one `PUT .../incidents/<incident-id>/comments/<comment-id>?api-version=2025-09-01` with `{properties:{message}}` through the shared pipeline.
`--execute`, `--timeout`, `--no-wait`, write logging, asynchronous operation handling, read-only gates and the Claude approval hook apply to both Sentinel writes as for `api`.
`--if-match` applies to incident updates.
Both Sentinel previews include the redacted request body; `--full` expands a truncated body.

`tag update` sets or removes tags on exactly one resource or resource group, given as one exact `--resource-id` in a single explicit `--subscription / -s`.
Names and implicit env/profile scope are not accepted; a mismatched, subscription-only or subscriptionless ID is refused, as is the tags wrapper itself.
`--operation merge` adds the named tags or overwrites their values; `--operation delete` removes the named tags; `replace` is refused because it rewrites the whole tag set.
`--tags` takes individual `k=v` arguments after one flag or repeated flags, preserving commas, spaces and additional equals signs in values.
Names are case-insensitive and conflicting values for one name are refused, and delete matches by name with supplied values ignored and sent as null.
The preview reads the tags wrapper (`GET .../providers/Microsoft.Resources/tags/default?api-version=2021-04-01`) and shows the tag-map diff plus a native execute command; a missing wrapper previews creation for merge and a no-op for delete.
Protected tag values are redacted in both the diff and execute command; a pasted `***redacted***` value is refused before any request, so re-supply the real value instead.
Execution re-reads, returns a no-op without a PATCH or log entry when nothing would change, and otherwise sends one `PATCH .../tags/default?api-version=2021-04-01` with `{operation, properties:{tags}}` through the shared pipeline.
The preview's execute command includes `--if-match <etag>` when the read returns an ETag, pinning the reviewed value.
Without `--if-match`, execution uses the fresh re-read ETag when the service returns one; the Tags API documents no ETag guarantee.
`--execute`, `--timeout`, `--no-wait`, write logging, read-only gates and the Claude approval hook apply as for `api`.

`network nsg rule create` adds one Deny security rule to exactly one existing network security group, using az's `network nsg rule create` flag spellings.
Select the NSG with `--nsg-name` plus `--resource-group` / `-g`, or with `--ids <nsg-ARM-id>` alone (which still needs `--name` for the new rule).
`--subscription` / `-s` requires a single explicit subscription ID; names and implicit env/profile scope are not accepted.
`--name` / `-n` names the new rule and `--priority` takes one integer 100-4096; a name or priority that already exists on the NSG refuses instead of overwriting, and rule updates and deletes stay out of scope.
`--access` takes Deny alone and defaults to Deny; Allow is refused.
`--direction` takes Inbound or Outbound and defaults to Inbound; `--protocol` takes Tcp, Udp, Icmp, Esp, Ah or `*` and defaults to `*`.
The four address/port lists default to `*` (unlike az, whose destination-port default is 80).
Multiple source or destination address values must be IP addresses or CIDR prefixes; use a service tag or `*` alone.
Source and destination ports accept `*`, individual ports in 0-65535, or ascending ranges within those bounds; invalid ports are refused before reading the NSG.
Application security groups are unsupported and rejected as unknown flags.
The preview reads the NSG (`GET .../networkSecurityGroups/<nsg>?api-version=2024-05-01`) and lists its existing rules plus the exact rule to be added, with the native execute command.
Execution checks the exact rule for existence and sends one child `PUT .../securityRules/<rule>?api-version=2024-05-01` through the shared pipeline, retaining mandatory destructive `--confirm <rule-name>`.
This is best-effort creation: Azure's documented [Security Rules Create Or Update](https://learn.microsoft.com/en-us/rest/api/virtualnetwork/security-rules/create-or-update) API cannot rule out a concurrent create of the same rule name in the seconds between preview and execution; such a create can be overwritten.
No `If-Match` header is sent and the native command does not accept `--if-match`, because Azure does not document rule-absence protection.
Immediately after the PUT, including asynchronous acceptance and `--no-wait`, the command re-reads the rule and compares its name and writable properties with the rule sent, excluding service metadata.
A differing rule or failed read is reported clearly with the write outcome and an inspection command; a matching readback does not prove that no concurrent rule was overwritten, and asynchronous acceptance remains acceptance rather than completion.
If readback fails after asynchronous acceptance, automatic polling stops; the error retains the validated `operationUrl` and an `az-axi op status` command so the accepted operation can still be monitored.
Owner-run live check: in an isolated NSG, create the same rule name concurrently between the existence check and PUT, inspect overwrite behavior and post-write readback, and confirm the documented best-effort limitation.
Offline tests use fake transports and do not perform this live check.
`--execute`, `--timeout`, `--no-wait`, write logging, asynchronous operation handling, read-only gates and the Claude approval hook apply as for `api`.
Recognized credential-returning POST actions are blocked with `READ_ONLY` before authentication, in preview and execution modes.
The authoritative action lists and path matching rules are in [policy.ts](src/lib/policy.ts).

For requests classified as write or destructive, the gates run in this order and stop at the first failure:

1. `AZ_AXI_READ_ONLY=1` blocks previews and execution with `WRITES_DISABLED`.
2. The selected profile must have writes enabled, or return `WRITES_DISABLED`.
3. The target path must start with a subscription in that profile's configured `subscriptions`, or return `SUBSCRIPTION_NOT_WRITABLE`.
   Flag and environment overrides cannot widen this list; tenant and management-group targets are always blocked.
4. Without `--execute`, return a dry run and send no write.
5. Destructive execution requires `--confirm <resource-name>`; missing or incorrect confirmation returns `CONFIRM_REQUIRED` or `CONFIRM_MISMATCH`.
6. Execute only after all preceding gates pass, with the ETag, no-op, polling and audit behavior below.

Grant only the RBAC permissions needed for the intended operations, scoped to the write-enabled subscriptions or narrower resource scopes.
Prefer PIM-eligible roles with temporary activation over standing Owner or Contributor access, especially at management-group scope.
Use the [agent approval hook](#agent-integration) when an agent performs writes, and review the preview before approving execution.

Without `--execute`, a permitted write or destructive request returns a dry run using current-state reads or a deployment what-if query, without sending the write.
The following preview details apply to `api`; native write previews are described above.
For example, `az-axi api PATCH <resource-path> --api-version <version> --body-file body.json --profile <profile>` previews a field-level diff.
PUT and PATCH previews show `changes[]{path,from,to}`, capped at 20 rows with `remaining` for additional changes, and `noop: true` when nothing would change.
PUT also lists omitted fields as removals; PATCH normally compares supplied fields, but supplying `tags` replaces the tag set, so omitted tags appear as removals.
Preview output includes the request class, method, shortened target, subscription, redacted body and available ETag; `--full` expands a truncated body.
DELETE previews summarize the resource and warn about detected resource or resource-group locks; a failed lock check produces a hint.
Other POST actions show the body and execution command without a current-state diff.
Completed deployment what-if previews summarize change counts.
Pending deployment previews return an `az-axi op status` command without polling or an execution command.
Other previews include a shell-quoted execution command with an available ETag and destructive confirmation.
File bodies retain their `--body-file` path; stdin and redacted inline bodies use `--body-file '<body-file>'`, whose placeholder must be replaced with a file containing the original JSON.

Add `--execute` to send the write after all gates pass.
Destructive execution requires `--confirm <resource-name>`, matching the percent-decoded resource name exactly; for destructive POST actions, use the name preceding the action segment.
DELETE, recognized disruptive POST actions, PUT/PATCH on protected Microsoft.Authorization types, and PUT/PATCH on NSG security rules require this confirmation; [policy.ts](src/lib/policy.ts) owns the lists.
Execution re-reads the resource, or the parent resource for POST actions, before sending.
For APIs supporting conditional writes, use `--if-match <etag>` from the reviewed preview for review-to-execute protection.
Without it, execution uses the fresh GET's ETag when available; generic `api` execution reports that review-to-execute protection was not used.
Native execution reports its operation-specific protection limits as described above.
An unchanged PUT/PATCH or DELETE of an already absent resource returns `result: already in desired state (no-op)` without sending or logging a write.

Async writes with HTTP 201/202 and an operation URL poll automatically after any immediate post-write verification succeeds, preferring `Azure-AsyncOperation` over `Location`.
`--timeout <seconds>` sets a positive polling budget, defaulting to 600 seconds; it does not bound the initial resource read or write request.
`--no-wait` returns `result: operation accepted`, the operation URL and an `op status` command instead of polling.
HTTP 202 without an operation URL reports `API_ERROR` because completion cannot be tracked.
See [Check an operation](#check-an-operation) for URL requirements, output and recheck behavior.
Completed execution returns `result: done`; write failures include `result: failed` alongside the normal error code.
Write outcomes include the target, HTTP status, available request and correlation IDs, duration in seconds and a suggested GET to verify the resource.

Attempted writes, including failures, append metadata to `~/.az-axi/writes.log`, overridden by `$AZ_AXI_WRITE_LOG`.
The append-only JSON Lines log records time, profile, identity, request class, method, URL, available request/correlation IDs, HTTP status and outcome, excluding bodies and headers.
Token-mode identity is recorded as unavailable without decoding the token.
New log directories and files use user-only permissions where supported.
Dry runs, no-ops and failures before write dispatch are not logged.
With `--no-wait`, a successful log entry records acceptance, not eventual operation completion.
If logging fails, execution reports `API_ERROR` with `result: write log failed`; verify the resource before retrying because the write may have succeeded.

The dashboard reports the selected profile's effective write status and configured write subscriptions.
`doctor` reports them for each inspected profile, including when authentication fails.
Both report whether `AZ_AXI_READ_ONLY` is set and whether its value forces read-only, plus the resolved write log path.
Read-scope overrides do not change the reported write subscriptions.

The owner-only source-checkout smoke script keeps its existing checks when run without write flags.
Build with `pnpm run build` before running it; the script imports API versions from `dist`.
Write checks require all three flags explicitly: `--writes --subscription <id> --resource-group <rg>`.
Select a write-enabled profile whose configured subscriptions include the sandbox subscription, with `AZ_AXI_READ_ONLY` not forcing read-only.
The script preserves existing tags and sets the sandbox resource group's `axi-test` tag to `1` (or `2` if already `1`), then checks execution, a repeated no-op and the read-only block.
It leaves the test tag in place.
It never creates resources or deletes the supplied resource group.

```sh
node scripts/live-smoke.mjs --profile <profile> --writes --subscription <id> --resource-group <sandbox-rg>
# Optional destructive check: the owner must create a throwaway account first.
node scripts/live-smoke.mjs --profile <profile> --writes --subscription <id> --resource-group <sandbox-rg> --delete-storage-account <throwaway-account>
```

The destructive step is skipped when `--delete-storage-account` is omitted.
When supplied, the named account must already exist in that resource group; a missing or mismatched target fails the check without deletion.
It previews deletion, refuses detected locks or failed lock checks, checks that execution without confirmation is blocked, deletes with `--confirm <throwaway-account>`, and verifies the account is gone.
Where a tag preview returns an ETag, execution uses `--if-match` and a subsequent write with the stale reviewed ETag must return `PRECONDITION_FAILED`.
The storage account's tag preview is also checked; its tag round trip runs only when it returns an ETag.
Without an ETag, resource-group execution checks the explicit notice that review-to-execute protection was not used.
If neither target returns an ETag, the summary states `If-Match path not exercised: target returned no ETag`.
No wildcard or fabricated ETag is used.
The script prints and saves only check outcomes and skip reasons, never response bodies.
Live checks belong to the owner and are never run in CI.

## Benchmark utilities

The source checkout provides `scrub` in `scripts/benchmark/scrub.mjs` and `countTokens` in `scripts/benchmark/tokens.mjs`.
Build with `pnpm run build` before importing the scrubber, which uses constants from `dist`.
These modules and the benchmark harness are not packaged with the CLI.
Use `pnpm bench` for offline replay of owner-made captures and `pnpm bench:surface` for skill and help token counts.
Only the owner runs `pnpm bench:capture`; see [BENCHMARK.md](BENCHMARK.md) for targets, privacy constraints, replay matching and measurement limitations.

`scrub(value, { leakCheck: [] })` returns scrubbed JSON data without mutating the input.
It replaces string values and object keys by default, preserving only exact, case-sensitive entries in the module's `PUBLIC_VOCABULARY` and parseable timestamps of the form `YYYY-MM-DDTHH:mm:ss[.fraction](Z|±HH:mm)`.
The vocabulary includes public API names, schema fields, classifications and built-in role IDs.
Mixed strings are split into segments: separators remain, and each non-public segment becomes `scrub_` followed by its SHA-256 hex digest.
Empty and separator-only strings are replaced too.
The same segment receives the same replacement across calls, keys, values and traversal orders.
Numbers, booleans and null remain unchanged.
There are no rename, preserve or suffix modes.

Supply known private strings in `leakCheck`.
The scrubber throws before returning if any appears as a case-insensitive substring in decoded keys, string values or serialized output, even when the text is otherwise allowed.
The error does not print the private string.
See [BENCHMARK.md](BENCHMARK.md#owner-capture) for capture storage and privacy constraints.

`countTokens(text)` measures text using `gpt-tokenizer`'s `o200k_base` encoding, treating special-token spellings as ordinary text.
Synthetic scrubber, response replay and token counter coverage lives in `test/benchmark.test.ts`.
Built-CLI record/replay, scenario runner and surface measurement coverage lives in `test/benchmarkHarness.test.ts`.
