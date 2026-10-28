# Safety reference

[README](../README.md#safety) · [Configuration](configuration.md) · [Commands](commands.md)

Contents: [Metadata boundaries](#metadata-reads-and-security-boundaries) · [Permissions](#permissions) · [Pinned reads](#pinned-azure-cli-read-catalogue) · [Writes](#writes) · [Operation status](#check-an-operation) · [Agent hooks](#agent-approval-hook).

### Metadata reads and security boundaries

Typed inventory views return metadata instead of arbitrary provider properties.
Generic resource show is limited to the ARM envelope; workspace views exclude shared keys; disks exclude SAS URIs; Sentinel connectors project safelisted metadata.
Monitor action-group views suppress URI queries and fragments, redact credentialed URLs and omit logic-app callback and function trigger URLs.

Output replaces recognized secret fields and values, including nested objects, with `***redacted***`.
Absolute network URIs containing userinfo are redacted too.
Secret-named parameters and `secureString` / `secureObject` declarations have values, defaults and allowed values redacted, including paired inline deployment templates.
The [redaction implementation](../src/lib/redact.ts) defines recognized patterns.

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

The default profile uses Azure CLI's existing login cache.
az-axi does not persist acquired bearer tokens; token profiles reference environment variables or private files.
Arbitrary provider text can still contain sensitive data; inspect output before sharing it.
See [credential storage protections](configuration.md#authentication).

Native requests send selectors, query text and requested bodies to the selected Azure service over HTTPS.
ACR reads exchange an Entra token for a pull-scoped registry token.
The session hook stays local; normal CLI output goes to stdout and write audit metadata stays in the local log.

### Permissions

Grant only the actions needed at the narrowest applicable scope.
These are common role choices, not permissions az-axi grants automatically.

| Surface | Required access / typical role |
| --- | --- |
| ARM inventory, Resource Graph, access and activity reads | Read actions on selected scope, commonly Reader; results follow the identity's access |
| Defender posture and alerts | Security read permissions, commonly Security Reader |
| Sentinel incident and configuration reads | Workspace security read permissions, commonly Microsoft Sentinel Reader |
| Log Analytics queries | Workspace query access, commonly Log Analytics Reader |
| Blob metadata | Data-plane container/blob read permissions, commonly Storage Blob Data Reader |
| Key Vault metadata | Metadata list permissions, commonly Key Vault Reader under Azure RBAC |
| ACR metadata | Repository metadata/pull access under the registry's configured permission mode |
| Writes | Corresponding action rights, such as Security Operator or Microsoft Sentinel Responder; tag and NSG actions need resource-specific write rights |

### Pinned Azure CLI read catalogue

`az-axi az` is a restricted passthrough, separate from native commands.
Only this reviewed read is executable:

```sh
az-axi az group show --name rg-demo --subscription '<subscription-uuid>' --profile work
```

It requires a configured `auth: "az"` profile with an explicit tenant UUID and exactly one subscription matching the flag.
Implicit profiles, token profiles, management-group scope and environment tenant/subscription overrides are refused.
The [generated catalogue](../src/lib/azReadCatalogue.ts) pins the official Azure CLI version, AzureCloud/latest, operations and an empty extension set.
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
The [request policy](../src/lib/policy.ts) owns classification and the secret/destructive action lists.

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
Concurrency checks require an isolated NSG; offline tests do not establish live race behavior.

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
For Claude Code sessions intended to execute writes, install the packaged [Bash approval hook](../scripts/claude-guard.mjs):

```sh
az-axi setup hooks
```

Setup installs or repairs `PreToolUse` with the `Bash` matcher in `~/.claude/settings.json` alongside `SessionStart`.
The guard runs from the installed package without a source checkout, using pinned absolute Node and script paths with shell quoting.
Setup repairs the documented legacy source-checkout guard command and preserves unrelated hooks and settings.
Invalid Claude settings stop setup without overwriting them.
The approval guard is specific to Claude Code; Codex and OpenCode retain their session context integrations.
The hook requests human approval with the full command when shell text contains a recognizable az-axi invocation and `--execute` evidence.
It handles quoted words, paths, `env`, `npx` and chained commands, and scans raw/normalized ambiguous shell text without running it.
Ambiguous assignments, arrays, pipelines, here-documents and escaped/ANSI-quoted text may prompt on unrelated literal text such as `--execute-later`; even `--execute=false` prompts.
This Bash hook does not cover PowerShell, other tools, aliases or dynamically assembled commands without recognizable invocation/flag text.
Use an interactive session with permission prompts enabled.
After installation or hook upgrades, verify that harmless `az-axi api --help --execute` requests approval and `az-axi --help` does not.
See the official [hook decision reference](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).

Session context is installed for Claude Code and Codex, plus an OpenCode ambient plugin.
It injects the selected profile, scope, write posture, version and a next step without network requests or Azure CLI subprocesses.
Restart the agent session after setup.
Repeat setup after moving or reinstalling the package to repair paths; unrelated settings are preserved.
Setup refuses temporary directories, worktrees and pipeline builds.
The skill uses `npx -y @knowttl/az-axi`, so it does not require a global installation.
The skill and session context are alternative discovery paths; the approval guard is a separate protection installed by hook setup.

To remove integrations, remove only az-axi entries from `SessionStart` in `~/.claude/settings.json` and `~/.codex/hooks.json`, the az-axi guard entry from Claude's `PreToolUse`, and `~/.config/opencode/plugins/axi-az-axi.js`.
Preserve other hooks and shared Codex feature settings.
