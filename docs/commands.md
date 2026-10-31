# Commands

[README](../README.md#what-it-covers) · [Configuration](configuration.md) · [Safety](safety.md)

Contents: [Command groups](#command-surface-and-subcommands) · [Exact leaf table](#exact-command-reference) · [Query inputs](#queries-and-request-bodies) · [Output and paging](#behavior).

The no-argument dashboard reports the selected profile, identity, subscriptions, Defender alerts, secure score, exposure and write status.
Native commands call Azure REST APIs directly; the separate `az` passthrough supports only one pinned, reviewed read.
Start with the skill's [investigation quickstart](../skills/az-axi/SKILL.md#investigation-quickstart); use a complete command path followed by `--help` when a command fails or its selectors, flags or defaults are unfamiliar.

### Command surface and subcommands

| Domain | Commands |
| --- | --- |
| Orientation | `home`, `doctor`, `setup hooks`, `config init\|list\|path` |
| Subscriptions and inventory | `sub list`, `account list\|show`, `group list\|show`, `resource list\|show` |
| Resource Graph | `graph query` (legacy `rg query`) |
| Access | `role assignment list` (legacy `rbac list`), `role definition list\|show`, `deny-assignment list\|show` |
| Activity | `monitor activity-log list` (legacy `activity list`) |
| Defender | `security alert list\|update`, `security secure-scores list`, `security pricing list\|show`, `security sub-assessment list\|show`, `defender alerts\|assessments\|score`, `defender alerts get\|update` |
| Sentinel | `sentinel incident list\|show\|list-alert\|list-entity\|update`, `sentinel incident comment create`, `sentinel alert-rule list\|show`, `sentinel data-connector list\|show` |
| Monitoring | `monitor log-analytics workspace list\|show`, `monitor metrics alert list\|show`, `monitor action-group list\|show`, `monitor diagnostic-settings list\|show`, `monitor metrics list` |
| Log Analytics | `monitor log-analytics query` (legacy `logs query`) |
| Network | `network nsg\|nic\|vnet\|public-ip\|private-endpoint list\|show`, `network nsg rule create` |
| Public DNS | `network dns zone list\|show`, `network dns record-set list`, `network dns record-set <type> list\|show` |
| Compute | `vm list\|show\|get-instance-view`, `vmss list\|show\|get-instance-view`, `disk list\|show` |
| Governance | `policy assignment\|definition\|set-definition list\|show`, `policy state list`, `lock list\|show`, `tag update` |
| Exposure | `exposure` |
| Blob metadata | `storage container\|blob list\|show` |
| Key Vault metadata | `keyvault secret\|key\|certificate list` |
| Registry metadata | `acr repository list\|show-tags`, `acr manifest show-metadata` |
| REST and operations | `api`, `op status`, `az group show` |

DNS record types are `a`, `aaaa`, `caa`, `cname`, `mx`, `ns`, `ptr`, `soa`, `srv` and `txt`.
This is the supported surface, not full Azure CLI coverage.
The [leaf registry](../src/lib/registry.ts) owns dispatch and Azure effect declarations; the [generated skill](../skills/az-axi/SKILL.md#commands) lists exact leaves and capabilities.

### Exact command reference

This table and the skill use the same registry renderer.
Run `pnpm skill:generate` to refresh both and `pnpm skill:check` to detect drift.
Effects describe Azure operations; `config init` and `setup hooks` write local files only.
Aliases are supported spellings of the same command.

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

Examples below inspect existing resources.
Replace example names and quoted placeholders with your own scope.

```sh
# Inventory and access
az-axi account list
az-axi group list -s '<subscription-id>'
az-axi resource list -g rg-demo -s '<subscription-id>'
az-axi resource show --ids '<resource-ARM-id>' --full
az-axi role assignment list --assignee '<object-id-or-upn>'
az-axi role definition list --custom-role-only

# Activity, posture and Sentinel
az-axi monitor activity-log list --offset 24h --status Failed
az-axi security alert list --severity High
az-axi security secure-scores list
az-axi sentinel incident list -s '<subscription-id>' -g rg-demo --workspace-name logs-demo
az-axi sentinel incident show -s '<subscription-id>' -g rg-demo --workspace-name logs-demo --name 3177
az-axi exposure --check mgmt-ports

# Infrastructure and monitoring
az-axi network nsg show -s '<subscription-id>' -g rg-demo --name nsg-web
az-axi vm get-instance-view -s '<subscription-id>' -g rg-demo --name vm-demo
az-axi policy state list --compliance NonCompliant
az-axi monitor log-analytics workspace list -s '<subscription-id>' -g rg-demo
az-axi monitor diagnostic-settings list --resource '<resource-ARM-id>'
az-axi monitor metrics list --resource '<resource-ARM-id>'

# Resource Graph, logs and REST
az-axi graph query --file inventory.kql --subscriptions '<subscription-id>'
az-axi monitor log-analytics query --file hunt.kql --workspace '<workspace-guid>' --timespan P7D
az-axi api GET "/subscriptions?api-version=2022-12-01"
```

### Queries and request bodies

Use files or piped stdin for multiline or shell-sensitive KQL and JSON.
Choose exactly one input source per request.

| Command | Input and scope |
| --- | --- |
| `graph query` | `--graph-query` / `-q`, `--file`, or stdin; explicit subscriptions or management groups, then profile scope, otherwise all accessible subscriptions |
| `monitor log-analytics query` | `--analytics-query`, `--file`, or stdin; one required `--workspace` / `-w` alias or customer GUID, not an ARM ID |
| `api` | `--body`, `--body-file`, or stdin; any JSON value, with conflicting sources and invalid JSON refused before requests |

Graph defaults to 50 rows; `--first` aliases `--limit` (maximum 1000), `--full` requests a 1000-row page, and `--skip-token` continues it.
Explicit Graph subscription and management-group scope families are mutually exclusive; without explicit scope, profile `managementGroup` takes precedence over profile subscriptions.
Log Analytics defaults to `--timespan P1D`, which intersects KQL time filters, and 50 displayed rows.
It needs workspace query access, such as Log Analytics Reader.
Legacy `rg query` and `logs query` also accept positional KQL; canonical query paths use named input, file or stdin.
All four KQL command paths parse locally before authentication or network requests.
Syntax errors return `VALIDATION_ERROR` (exit 2), up to five structured `diagnostics` containing one-based line and column, code, token and message, plus query excerpts with carets.
If more diagnostics exist, help reports the omitted count.
Successful parsing prints no validation message and does not check tables, columns, workspace functions, permissions or service-specific restrictions.
Server semantic rejections say `The server rejected the query (semantic error)`; server-provided line, position and token are included as diagnostics when available.
Legacy `rbac list` uses `--principal` instead of `--assignee`, and `activity list` uses `--since` instead of `--offset`.

`api` accepts host-relative paths for `--resource arm|logs|graph` (default `arm`).
ARM requires `--api-version` unless the path already contains that query parameter.
`--query` adds HTTP query parameters on `api`; JMESPath output queries and `--output` are unsupported.
All body input forms share the same request classification and write safeguards.
Paging hints preserve body-file paths; for stdin input, replace the hint's `<body-file>` with a file containing the original JSON.

### <a id="behavior"></a>TOON output behavior

The [TOON dependency compatibility review](toon-compatibility.md) records the synthetic output corpus, exact format changes and CLI/hook rendering boundaries for the 4.4.0 update.

| Control | Behavior |
| --- | --- |
| `--fields a,b` | Selects fields supported by that leaf; typed metadata views reject arbitrary provider properties |
| `--limit N` | Caps displayed rows; most inspection lists default to 50 |
| `--full` | Expands shortened values and usually removes display limits; Graph retains its page cap, while logs and `api` honor `--limit` |
| `api --all` | Follows ARM `nextLink` for up to 10 pages; `api` has no default display row cap |
| All native Azure collection lists | Fetch at most 1,000 rows per subscription or data-plane collection by default; `--all` raises this to 10,000 (Key Vault: at most 2,500 scanned at 25/page); `--max-rows N` overrides either budget (1 to 100,000). Every walk stops at 100 pages. `--limit` and `--full` affect display only and never bypass fetch budgets. |

Metadata data-plane commands retain their safe projections and bounds even with `--full`.
Counts disclose incomplete pagination as lower bounds, except capped listings that report an exact service total; an incomplete empty result does not prove that no matching objects exist.
Native fetch budgets count rows before local filters; each selected subscription or data-plane collection receives its own budget.
Resource Graph inventories (RBAC, Defender assessments/scores and exposure checks) apply the budget across the selected scope, separately for each exposure check.
Monitor metric definitions use the shared budget; metric time-series queries keep their existing window, interval and display controls and reject native fetch flags.
Non-paged Sentinel related-alert/entity responses are capped locally; their service totals remain exact.
When a budget is reached, narrow the scope or increase `--max-rows`; rerunning with `--full` only expands the fetched data.
Use leaf help for supported fields and paging limits.

Command paths must be complete and contiguous.
Put command-specific flags after the full leaf path.
Native list flags accept commas, spaces or repetition there; leading global lists and leaves with positional input consume one token per flag, so use commas or repetition.
`tag update --tags` is a literal `k=v` list: commas remain part of values.
Native booleans accept bare flags or true/false values; conflicting scalar values are refused.
Unknown flags, short clusters, abbreviations and missing values fail before requests.

Structured errors appear on stdout with `error`, `code` and available `help` suggestions.
For example, `az-axi no-such-command` returns this offline usage error with exit 2:

```toon
error: unknown command `no-such-command`
code: VALIDATION_ERROR
help[2]: Run `az-axi --help` for the full command surface,Run `az-axi` with no arguments for the dashboard
```

Exit 0 means the command succeeded, exit 2 covers usage and access errors, and exit 1 covers other failures.
`AUTH_REQUIRED` intentionally remains exit 2 for compatibility, including missing authentication.
`doctor` prints every selected profile and exits 1 if any profile has a required check failure or cannot be resolved; healthy profiles and optional Graph-token failures exit 0.
Its `workspaces` column lists configured alias names, or `(none)` when the profile has no aliases.
Unknown workspace errors list known aliases or state that no workspace aliases are configured for the profile.
Unknown flags list valid flags or a targeted replacement; other argument errors give a concise remedy, with full leaf help available through `--help`.
Common codes include `AUTH_REQUIRED`, `FORBIDDEN`, `UNKNOWN_FLAG`, `READ_ONLY`, `WRITES_DISABLED`, `PRECONDITION_FAILED`, `OPERATION_TIMEOUT`, `UNKNOWN_OUTCOME`, `PROVIDER_NOT_REGISTERED` and `API_ERROR`.
The shared ARM, Log Analytics and Graph client rejects nonempty non-JSON successful responses with `API_ERROR`; `api --raw` explicitly requests text instead.
Lists using the shared `requestList` or `requestAll` helpers require a `value` array on every fetched page; malformed envelopes fail with `API_ERROR` instead of returning empty or partial results.
Malformed JSON and list envelopes from the shared client, and malformed Key Vault, ACR and Storage metadata responses, include HTTP `status`, bounded `contentType`, `shape` and `shapeTruncated` fields.
On write-execution errors, `responseStatus` identifies the malformed response's HTTP status while `status` retains the write's HTTP status (or 0 when unavailable); a failed operation poll can therefore report different statuses.
Use those fields to check API compatibility or an intercepting proxy.
The shape contains types and conservative identifier paths only, with other keys replaced by `<key>`; arrays show the first element and a count.
These diagnostic fields never print response values or validator messages.
Storage XML is represented only as a string type.
This envelope validation does not apply to generic `api` paging or commands with their own response handling.
The shared client accepts empty bodies for non-list requests, including no-content responses.
`WRITES_DISABLED` identifies either the forced `AZ_AXI_READ_ONLY` override or the profile write opt-in in its message.
`READ_ONLY` blocks credential-returning actions; `PROVIDER_NOT_REGISTERED` asks the subscription owner to register the provider namespace named by Azure.

Query input differs by path: `graph query --graph-query <kql>` (or `-q`) and `monitor log-analytics query --analytics-query <kql>` require flags; `rg query "<kql>"` and `logs query "<kql>"` accept positional KQL.
All four accept `--file` or stdin.
