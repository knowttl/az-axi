<h1 align="center">az-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@knowttl/az-axi">npm</a> ·
  <a href="https://github.com/kunchenguid/axi">AXI</a> ·
  <a href="./LICENSE">MIT</a>
</p>

Azure CLI for agents and analysts, designed with AXI (Agent eXperience Interface).

az-axi inspects Azure resources, access permissions, activity, security posture and logs.
It is read-only by default and emits compact TOON on stdout with contextual next-step suggestions.
Run the dashboard for orientation, use a focused command, or inspect REST endpoints through `api`.

## Agent Ergonomics

- Compact list schemas, counts and aggregates keep results actionable.
- Empty and incomplete results are disclosed explicitly.
- `--fields`, `--limit` and `--full` control output where supported by the command.
- Errors use structured TOON with a code and available recovery hints.
- Writes require profile permission and subscription scope; permitted writes preview before execution.

## Quick Start

Requires Node.js 22.12 or later.
The default authentication mode also requires the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) and an existing `az login` session.
Alternatively, use a [token profile](#authentication).

### Skill installation

Install the packaged [az-axi skill](skills/az-axi/SKILL.md) for agent command discovery:

```sh
npx skills add knowttl/az-axi --skill az-axi
```

The skill directs agents to use `npx -y @knowttl/az-axi`, so a global CLI install is optional.

### Zero setup

With Azure CLI sign-in already available, native commands work without an az-axi configuration file:

```sh
npx -y @knowttl/az-axi --help
npx -y @knowttl/az-axi doctor
npx -y @knowttl/az-axi
```

Keep using `npx -y @knowttl/az-axi` when following hints that begin with `az-axi`.
To select a specific release, use `npx -y @knowttl/az-axi@<version>`.

## Other ways to install

### Global install and session hooks

Use session hooks to give agents local profile and scope context at session start:

```sh
npm install -g @knowttl/az-axi
az-axi setup hooks
```

This registers the local-only `az-axi-hook` entry point for Claude Code and Codex, plus an OpenCode ambient plugin.
Hook setup requires a persistent installation and refuses targets in temporary directories, git worktrees or pipeline builds, including symlinks to those targets.
Restart the agent session after installation.
The hook reads local configuration and environment only, with no network, Azure request or `az` subprocess.
It reports profile, scope, write posture, version and a next step; unconfigured machines report `not configured` and exit 0.
The skill and session hook are alternative discovery paths; you need only one.

### Direct install

For direct command entry without session integration:

```sh
npm install -g @knowttl/az-axi
az-axi doctor
az-axi account list
```

## <a id="use"></a>Usage

The no-argument dashboard reports the selected profile, identity, subscriptions, Defender alerts, secure score, exposure and write status.
Native commands call Azure REST APIs directly; the separate `az` passthrough supports only one pinned, reviewed read.
Use a complete command path followed by `--help` for accepted flags, defaults and examples.

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
The [leaf registry](src/lib/registry.ts) owns dispatch and Azure effect declarations; the [generated skill](skills/az-axi/SKILL.md#commands) lists exact leaves and capabilities.

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
Legacy `rbac list` uses `--principal` instead of `--assignee`, and `activity list` uses `--since` instead of `--offset`.

`api` accepts host-relative paths for `--resource arm|logs|graph` (default `arm`).
ARM requires `--api-version` unless the path already contains that query parameter.
`--query` adds HTTP query parameters on `api`; JMESPath output queries and `--output` are unsupported.
All body input forms share the same request classification and write safeguards.
Paging hints preserve body-file paths; for stdin input, replace the hint's `<body-file>` with a file containing the original JSON.

### <a id="behavior"></a>TOON output behavior

The [TOON dependency compatibility review](docs/toon-compatibility.md) records the synthetic output corpus, exact format changes and CLI/hook rendering boundaries for the 4.4.0 update.

| Control | Behavior |
| --- | --- |
| `--fields a,b` | Selects fields supported by that leaf; typed metadata views reject arbitrary provider properties |
| `--limit N` | Caps displayed rows; most inspection lists default to 50 |
| `--full` | Expands shortened values and usually removes display limits; Graph retains its page cap, while logs and `api` honor `--limit` |
| `api --all` | Follows ARM `nextLink` for up to 10 pages; `api` has no default display row cap |
| Native compute, Sentinel incident/rule/connector, resource group/resource, subscription/account, network/DNS and storage/Key Vault/ACR metadata lists | Fetch at most 1,000 rows per subscription or data-plane collection by default; `--all` raises this to 10,000 (Key Vault: at most 2,500 scanned at 25/page); `--max-rows N` overrides either budget (1 to 100,000). Every walk stops at 100 pages. `--limit` and `--full` affect display only and never bypass fetch budgets. |

Metadata data-plane commands retain their safe projections and bounds even with `--full`.
Counts disclose incomplete pagination as lower bounds; an incomplete empty result does not prove that no matching objects exist.
Native fetch budgets count rows before local filters; each selected subscription or data-plane collection receives its own budget.
When a budget is reached, narrow the scope or increase `--max-rows`; rerunning with `--full` only expands the fetched data.
Use leaf help for supported fields and paging limits.

Command paths must be complete and contiguous.
Put command-specific flags after the full leaf path.
Native list flags accept commas, spaces or repetition there; leading global lists and leaves with positional input consume one token per flag, so use commas or repetition.
`tag update --tags` is a literal `k=v` list: commas remain part of values.
Native booleans accept bare flags or true/false values; conflicting scalar values are refused.
Unknown flags, short clusters, abbreviations and missing values fail before requests.

Structured errors appear on stdout with `error`, `code` and available `help` suggestions.
Exit 0 means the command succeeded, exit 2 covers usage and access errors, and exit 1 covers other failures.
`AUTH_REQUIRED` intentionally remains exit 2 for compatibility, including missing authentication.
`doctor` prints every selected profile and exits 1 if any profile has a required check failure or cannot be resolved; healthy profiles and optional Graph-token failures exit 0.
Unknown flags list valid flags or a targeted replacement; other argument errors give a concise remedy, with full leaf help available through `--help`.
Common codes include `AUTH_REQUIRED`, `FORBIDDEN`, `UNKNOWN_FLAG`, `READ_ONLY`, `WRITES_DISABLED`, `PRECONDITION_FAILED`, `OPERATION_TIMEOUT`, `UNKNOWN_OUTCOME`, `PROVIDER_NOT_REGISTERED` and `API_ERROR`.
`WRITES_DISABLED` identifies either the forced `AZ_AXI_READ_ONLY` override or the profile write opt-in in its message.
`READ_ONLY` blocks credential-returning actions; `PROVIDER_NOT_REGISTERED` asks the subscription owner to register the provider namespace named by Azure.

Query input differs by path: `graph query --graph-query <kql>` (or `-q`) and `monitor log-analytics query --analytics-query <kql>` require flags; `rg query "<kql>"` and `logs query "<kql>"` accept positional KQL.
All four accept `--file` or stdin.

### Metadata reads and security boundaries

Typed inventory views return metadata instead of arbitrary provider properties.
Generic resource show is limited to the ARM envelope; workspace views exclude shared keys; disks exclude SAS URIs; Sentinel connectors project safelisted metadata.
Monitor action-group views suppress URI queries and fragments, redact credentialed URLs and omit logic-app callback and function trigger URLs.

Output replaces recognized secret fields and values, including nested objects, with `***redacted***`.
Absolute network URIs containing userinfo are redacted too.
Secret-named parameters and `secureString` / `secureObject` declarations have values, defaults and allowed values redacted, including paired inline deployment templates.
The [redaction implementation](src/lib/redact.ts) defines recognized patterns.

Storage, Key Vault and ACR metadata commands require Entra authentication and explicitly named public service endpoints.
Subscription and management-group selectors do not filter these data planes.
They refuse arbitrary endpoints and redirects, enforce bounded responses, and never fall back to account keys, SAS, connection strings, anonymous access or admin passwords.
Token profiles require the corresponding data-plane token and never fall back to ambient `az login` or ARM tokens.
Azure CLI token acquisition for these commands uses a sanitized, bounded child process with extensions disabled.

| Service | Reads and bounds | Exclusions |
| --- | --- | --- |
| Blob storage | `storage container\|blob list\|show`; `--account-name`, plus `--container-name` for blobs; lists use the shared fetch budget and display 50 rows by default; `--marker` starts a walk at a service marker; show uses HEAD | User metadata, tags, blob content, credential lookup and local output files; Azure CLI storage defaults and `AZURE_STORAGE_*` credentials are not consumed |
| Key Vault | `keyvault secret\|key\|certificate list --vault-name <vault>`; shared fetch budget counts scanned objects before filtering, default display 50 rows; `--expiring-within 30d` excludes expired items and those without expiry | Single-object retrieval, tags, secret values, key material, certificate bytes, export, backup, download and mutations |
| ACR | `acr repository list --name <registry>`, `acr repository show-tags --name <registry> --repository <repo>`, `acr manifest show-metadata --registry <registry> --name <repo:tag>`; lists use the shared fetch budget and display 50 rows by default; `--marker` starts a walk at a service marker | Credential export, image pulls, blob downloads, local output files, signatures, history, download URLs and mutations |

Storage needs Blob data RBAC permissions; Key Vault needs data-plane list permission; ACR needs registry pull access such as AcrPull.
ACR exchanges an Entra token at the registry for catalog or repository pull-scoped access.
Manifest reads also accept `repository@digest`; login-server-qualified references and `--limit` on manifest reads are refused.
Storage and ACR `--full` retain the same safe schema and fetch budget; Key Vault `--full` expands safe columns while retaining fetch budgets.
Service markers are returned only when they can resume without skipping an omitted page tail.
`tag update` remains a gated write.
Tag-related passthrough reads and Resource Graph queries retain their separate paging contracts.
Key Vault continuations stay on the same vault and collection.
Storage requests have a 30-second deadline and list XML is bounded to 1 MiB; Key Vault and ACR share a 30-second budget across credential acquisition and requests, with each response bounded to 1 MiB.
Denied reads fail without trying another authentication method, and data-plane errors exclude secret values.

### Pinned Azure CLI read catalogue

`az-axi az` is a restricted passthrough, separate from native commands.
Only this reviewed read is executable:

```sh
az-axi az group show --name rg-demo --subscription '<subscription-uuid>' --profile work
```

It requires a configured `auth: "az"` profile with an explicit tenant UUID and exactly one subscription matching the flag.
Implicit profiles, token profiles, management-group scope and environment tenant/subscription overrides are refused.
The [generated catalogue](src/lib/azReadCatalogue.ts) pins the official Azure CLI version, AzureCloud/latest, operations and an empty extension set.
This source audit does not certify a live or tampered runtime; use a trusted official Azure CLI installation and login configuration.

Unknown paths, writes, credentials, duplicate flags and unsupported arguments are refused before any child probe.
Fixed version, cloud and account probes validate the runtime and selected tenant/subscription before executing the read.
Installed CLI/core mismatches refuse the requested read.
Each child uses closed stdin, forced JSON, a 30-second deadline and a 1 MiB output ceiling, with prompts, dynamic extension installation, automatic upgrades and file logging disabled.
Fresh empty user/system extension directories and cleared development sources isolate every probe and read; temporary directories are removed afterward.
The signed-in `AZURE_CONFIG_DIR` is preserved, while unrelated environment overrides are stripped.

Output is normalized to TOON with id, name, location and state; `--full` adds tags, never raw properties.
`--fields` selects default fields and cannot combine with `--full=true`.
Passthrough arguments may occur only once, including aliases; `--subscription` has no short alias, and `--full=false` must use inline assignment rather than a separate value.
`--query`, `--output`, `--debug`, `--ids`, `--execute`, local destinations and data-plane reads are unavailable.
Failures return structured errors without raw child diagnostics.
Unknown versions, handlers and operations never become reads based on a verb or output filter.

### Writes

**Writes are disabled by default, including previews.**
A human must hand-edit the intended profile with `"allowWrites": true` and a non-empty `subscriptions` list.
Find the file with `az-axi config path`; no az-axi command enables writes, and invalid write configuration is rejected.
Writes are limited to ARM; Graph and Log Analytics support reads and reviewed queries only.
Recognized credential-returning actions are blocked before authentication in both preview and execution modes.
The [request policy](src/lib/policy.ts) owns classification and the secret/destructive action lists.

For write or destructive requests, gates run in order:

1. `AZ_AXI_READ_ONLY=1` blocks previews and execution.
2. The profile must permit writes.
3. The target must belong to a subscription in the profile's configured list; flags and environment cannot widen it, and tenant/management-group writes are blocked.
4. Without `--execute`, return a dry run without sending a write.
5. Destructive execution also requires `--confirm <resource-name>` matching the percent-decoded name exactly; destructive POST actions use the name before the action segment.
6. Execute only after these checks pass.

Grant the narrow RBAC permissions needed for each operation.
Prefer PIM-eligible roles with temporary activation over standing Owner or Contributor access.
For agents, use the [approval hook](#agent-approval-hook) and review the preview before approving execution; CLI flags themselves are supplied by the agent.

The following example previews a tag merge on a write-enabled profile:

```sh
az-axi tag update --profile work -s '<subscription-id>' --resource-id '<resource-ARM-id>' --operation merge --tags env=prod
```

Adding `--execute` sends the write.
Destructive operations also need confirmation; an NSG Deny rule can cut live traffic.

| Native write | Scope and behavior | Concurrency and repetition |
| --- | --- | --- |
| `security alert update` (legacy `defender alerts update`) | One explicit subscription ID, location and alert name; status `dismiss`, `resolve` or `activate`; bodyless POST | Matching status is a no-op; explicit `--if-match` is forwarded but the API documents no ETag guarantee |
| `sentinel incident update` | One explicit subscription ID and incident selected by name/GUID/number with workspace selectors, or full `--ids`; updates status, severity, owner or classification through GET-merge-PUT | Unchanged incident is a no-op; `--if-match` pins a reviewed ETag when supported, otherwise the fresh read's ETag is used when available |
| `sentinel incident comment create` | One explicit subscription ID, incident selected with `--incident-id` and workspace selectors or `--ids`, plus `--message`; appends one comment | Every invocation generates a new GUID, including execution after preview; repeating execution adds another comment |
| `tag update` | One exact resource/group `--resource-id` and explicit subscription ID; `merge` adds/overwrites named tags, `delete` removes names; `replace` is refused | Unchanged tags are a no-op; missing tags preview creation for merge or a no-op for delete; reviewed/fresh ETags are used when available but the API documents no guarantee |
| `network nsg rule create` | One existing NSG selected by `--nsg-name` plus resource group, or NSG `--ids`; explicit subscription ID, new rule name and priority 100-4096; Deny only | Existing name or priority is refused; best-effort child PUT, with no conditional header or `--if-match` support |

Native writes require an explicit subscription ID, not a name or implicit profile/environment scope.
Sentinel closing requires classification, and concrete classification requires a reason; use leaf help for allowed values.
Tag names match case-insensitively; conflicting values are refused, and delete ignores supplied values.
Do not paste `***redacted***` tag values from previews; supply the real value instead.
NSG defaults are Inbound, protocol `*`, and `*` for all four address/port lists, including destination ports (unlike Azure CLI's 80).
Ports must be 0-65535 with ascending ranges; multiple addresses require IPs/CIDRs, while service tags and `*` must stand alone.
Allow rules, application security groups, rule updates and rule deletes have no native command here.

NSG creation can overwrite a concurrent creation of the same rule name between the absence check and PUT.
Immediate readback compares the name and writable properties, including with `--no-wait`, and reports differences or failed reads.
A matching readback does not establish that no concurrent rule was overwritten.
If readback fails after asynchronous acceptance, polling stops and the error retains the operation URL and status command.
An owner-run concurrency check needs an isolated NSG; offline tests do not establish live race behavior.

#### REST previews and execution

Permitted `api` writes preview through current-state reads or deployment what-if, without sending the write itself.
PUT/PATCH previews show field differences, with PUT omissions shown as removals; PATCH compares supplied fields, but a supplied `tags` object replaces the tag set.
DELETE previews summarize the target and warn about detected resource/group locks or failed lock checks.
Other POST previews show the body and execution command; pending deployment previews provide an operation-status command without an execute command.
Bodies and hints are redacted, and `--full` expands shortened preview bodies.
Replace placeholder body files in stdin/redacted execution hints with files containing the original JSON.

Execution re-reads current state or the parent of a POST action.
Use the preview's `--if-match <etag>` for review-to-execute protection on APIs supporting conditional writes.
Without it, a fresh read's ETag protects only the read-to-write interval when supported; generic `api` reports the missing review-to-execute protection.
An unchanged PUT/PATCH or already-absent DELETE returns a no-op without a write or log entry.
DELETE, recognized disruptive POSTs and PUT/PATCH on protected authorization types or NSG rules require destructive confirmation.

Async writes with HTTP 201/202 and an operation URL poll after immediate verification, preferring `Azure-AsyncOperation` over `Location`.
`--timeout` sets a positive polling budget in seconds, default 600; it does not bound the initial read/write request.
`--no-wait` returns acceptance and an operation-status command, not eventual completion.
HTTP 202 without an operation URL is an error because completion cannot be tracked.
Outcomes include target, status, available request/correlation IDs, duration and verification guidance.

Attempted dispatched writes, including failures, append JSON Lines metadata to `$XDG_STATE_HOME/az-axi/writes.log` (default `~/.local/state/az-axi/writes.log`), overridden by `AZ_AXI_WRITE_LOG`.
On Windows the default is `%LOCALAPPDATA%\az-axi\writes.log`; XDG variables are ignored.
The log includes time, profile, identity, request class, method, URL, available request/correlation IDs, HTTP status and outcome, excluding bodies and headers.
Token-mode identity is recorded as unavailable without decoding the token.
New log files/directories use user-only permissions where supported.
Dry runs, no-ops and failures before dispatch are not logged; `--no-wait` logs acceptance.
If logging fails, verify the target before retrying because the write may have succeeded.

### Check an operation

Use the URL returned by Azure's asynchronous response:

```sh
az-axi op status 'https://management.azure.com/<operation-path>?api-version=<version>'
```

This performs one read-only GET and reports the current state; re-run the suggested command if still running.
Only absolute HTTPS URLs on `management.azure.com` are accepted.
Failed/Canceled operation states retain returned error details, but a successful status lookup still exits 0.
Request failures use the normal error contract.

### Agent approval hook

For read-only agent sessions, set `AZ_AXI_READ_ONLY=1` in the agent's environment.
For Claude Code sessions intended to execute writes, use the source-checkout [Bash approval hook](scripts/claude-guard.mjs) from a trusted absolute path.
Merge the following into `~/.claude/settings.json` or project `.claude/settings.json`, replacing the example path:

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

The hook requests human approval with the full command when shell text contains a recognizable az-axi invocation and `--execute` evidence.
It handles quoted words, paths, `env`, `npx` and chained commands, and scans raw/normalized ambiguous shell text without running it.
Ambiguous assignments, arrays, pipelines, here-documents and escaped/ANSI-quoted text may prompt on unrelated literal text such as `--execute-later`; even `--execute=false` prompts.
This Bash hook does not cover PowerShell, other tools, aliases or dynamically assembled commands without recognizable invocation/flag text.
Use an interactive session with permission prompts enabled.
After installation or hook upgrades, verify that harmless `az-axi api --help --execute` requests approval and `az-axi --help` does not.
See the official [hook decision reference](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).

## Configuration

### Profiles

az-axi follows the [AXI credential standard](https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md).
Configuration lookup order is `--config <path>`, `AZ_AXI_CONFIG`, then `$XDG_CONFIG_HOME/az-axi/config.json` when XDG_CONFIG_HOME is absolute, otherwise `~/.config/az-axi/config.json`.
On Windows the default is `%APPDATA%\az-axi\config.json`, and XDG variables are ignored.
Legacy `~/.az-axi/config.json` and `./az-axi.config.json` are never read; when only a legacy file exists, `CONFIG_MOVED` names the old and new paths and a move command.
Update the moved file to version 1, rename `tenant` to `tenantId`, and replace legacy `tokenEnv` entries with SecretRefs.
Profile selection is `--profile`, `AZ_AXI_PROFILE`, a complete env profile, `defaultProfile`, then the only configured profile.
The env profile uses ambient auth when `AZ_AXI_TENANT_ID` is set, or token auth when `AZ_AXI_ARM_TOKEN` is set; mixed and partial sources are rejected.
An explicit file profile ignores env-profile fields, while SecretRefs still resolve the variables they name.
With no config and no env profile, native commands use an implicit ambient `az` profile so `az login` alone still works.
An empty profile file requires a profile; multiple profiles without a selection are ambiguous.

```sh
az-axi config init --name work --auth az
az-axi config list
az-axi profile list
az-axi auth status
az-axi config path
```

Example configuration, with writes disabled:

```json
{
  "version": 1,
  "defaultProfile": "work",
  "profiles": {
    "work": {
      "auth": "az",
      "subscriptions": ["00000000-0000-0000-0000-000000000001"],
      "workspaces": {
        "sentinel": "00000000-0000-0000-0000-000000000010"
      }
    },
    "ci": {
      "auth": "token",
      "armToken": { "env": "AZ_AXI_ARM_TOKEN" },
      "logsToken": { "env": "AZ_AXI_LOGS_TOKEN" },
      "graphToken": { "env": "AZ_AXI_GRAPH_TOKEN" }
    }
  }
}
```

| Profile field | Meaning |
| --- | --- |
| `auth` | Required: `az` or `token` |
| `tenantId` | Tenant passed to Azure CLI token acquisition |
| `managementGroup` | Default Resource Graph scope |
| `subscriptions` | Default read scope; absent/empty means all accessible subscriptions; also the fixed write allowlist when writes are enabled |
| `workspaces` | Alias to Log Analytics workspace customer GUID, not ARM resource ID |
| `armToken`, `logsToken`, `graphToken`, `storageToken`, `vaultToken`, `registryToken` | SecretRefs, defaulting to the corresponding `AZ_AXI_<RESOURCE>_TOKEN` env variable |
| `description` | Profile description |
| `allowWrites` | Human-edited write opt-in, requiring non-empty subscriptions; see [Writes](#writes) |

Native selectors include `--profile`, `--tenant`, `--subscription`, `--management-group` and `--config`.
Read scope resolves from flags, then the selected profile.
Some operations require one subscription or reject management-group scope; leaf help describes those constraints.
Read-scope overrides never change the write allowlist.

### Authentication

| Mode | Source |
| --- | --- |
| `az` (default) | `az account get-access-token`, using existing Azure CLI sign-in; supports identities understood by `az` |
| `token` | Pre-acquired bearer tokens resolved from the profile's SecretRefs |

Run `az-axi doctor` after authentication or profile changes to check sign-in, tokens, ARM reachability and per-profile write status.
`az-axi auth status` reports profile, endpoint, credential source names or paths, and the ambient identity through `az account show`, without printing secrets or minting tokens.
Both diagnostic commands verify Windows DACLs; ordinary reads check file type and reject links/reparse points.
For Conditional Access failures, the CLI advises fresh Azure CLI sign-in in the intended tenant.
Token-mode credentials stay in process memory and are not persisted by az-axi; expired tokens must be replaced externally.
SecretRefs are exactly `{ "env": "NAME" }`, `{ "file": "/absolute/path" }`, or `{ "stored": true }`.
File references must be private regular files; UTF-8 BOM and trailing whitespace are removed.
Windows file references require absolute drive paths and reject UNC and device paths.
az-axi implements no credential store or login/logout commands, so stored references fail with `AUTH_REQUIRED`.
Unknown profile keys and inline secrets fail with `CONFIG_INVALID`, without echoing values.
Legacy `tokenEnv` keys remain accepted with a stderr deprecation notice for one minor release.
The package ships [axi-credential.schema.json](axi-credential.schema.json), the strict schema for one profile, with `x-secret` on each secret field.
Config writes are atomic and files are created with mode 0600 in 0700 directories on Linux/macOS.
Reads require owner UID and reject group/other write access to configs, and all group/other access to secret files.
Windows writes apply a protected DACL granting FullControl only to the current user, SYSTEM and Administrators, with bounded rename retries.
The Microsoft Azure CLI and its existing `~/.azure` login remain the ambient credential source and are unchanged.

| Variable | Meaning |
| --- | --- |
| `AZ_AXI_CONFIG` | Configuration path override |
| `AZ_AXI_PROFILE` | Selected profile |
| `AZ_AXI_TENANT_ID` | Env-profile tenant; selects ambient auth |
| `AZ_AXI_TENANT` | Deprecated alias for `AZ_AXI_TENANT_ID`, accepted with a stderr notice for one minor release |
| `AZ_AXI_SUBSCRIPTIONS` | Env-profile subscriptions, comma-separated |
| `AZ_AXI_SUBSCRIPTION` | Deprecated alias for `AZ_AXI_SUBSCRIPTIONS`, accepted with a stderr notice for one minor release |
| `AZ_AXI_MANAGEMENT_GROUP` | Env-profile management group |
| `AZ_AXI_ARM_TOKEN` | Default token variable for `https://management.azure.com/` |
| `AZ_AXI_LOGS_TOKEN` | Default token variable for `https://api.loganalytics.io` |
| `AZ_AXI_GRAPH_TOKEN` | Default Microsoft Graph token variable |
| `AZ_AXI_STORAGE_TOKEN` | Default native storage token variable for `https://storage.azure.com/` |
| `AZ_AXI_VAULT_TOKEN` | Default native Key Vault token variable for `https://vault.azure.net/` |
| `AZ_AXI_REGISTRY_TOKEN` | Default native ACR token variable for `https://containerregistry.azure.net` |
| `AZ_AXI_READ_ONLY` | `1` or `true` blocks writes; `0`, `false` or unset is off (case-insensitive); any other value fails with `CONFIG_INVALID` |
| `AZ_AXI_WRITE_LOG` | Write log path override |
| `NODE_EXTRA_CA_CERTS` | PEM root CA file for Node.js on networks with TLS-inspecting proxies |

The `storage`, `vault` and `registry` audiences apply only to their native metadata commands, not `api --resource`.
For TLS trust failures (`TLS_ERROR`), provide your organization's root CA through `NODE_EXTRA_CA_CERTS` and re-run `doctor`.

## Contributing and Security

Changes are validated locally with build, TypeScript checks, offline tests and a generated-skill drift check.
GitHub test CI is not required by the local validation gate; no current CI status is claimed here.
See [CONTRIBUTING.md](CONTRIBUTING.md) for development, benchmark, live-smoke and release procedures, and [SECURITY.md](SECURITY.md) for vulnerability reporting.
Current behavior is documented above and in command help, including session hooks, Key Vault metadata reads and Sentinel incident management.
Historical design and benchmark notes are preserved on [archive/internal-docs](https://github.com/knowttl/az-axi/tree/archive/internal-docs) and do not define the supported surface.

## License

[MIT](LICENSE).
See [NOTICE.md](NOTICE.md) and [UPSTREAM.md](UPSTREAM.md) for attribution, including portions of ado-axi and Microsoft Azure CLI/SDK source excerpts.
