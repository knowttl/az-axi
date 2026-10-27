# az-axi

Azure inspection and gated operations for agents and the humans running them, with compact TOON output instead of large REST responses.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/%40knowttl%2Faz-axi)](https://www.npmjs.com/package/@knowttl/az-axi)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12.0-green)](package.json)
[![Release provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/@knowttl/az-axi#provenance)

```sh
az-axi sub list
```

Actual output from the built CLI using the repository's synthetic service fixture:

```toon
profile: demo
count: 1 subscriptions
subscriptions[1]{name,id,state,inScope}:
  "Sandbox, demo",00000000-0000-0000-0000-000000000001,Enabled,yes
```

[Quickstart](#quickstart) • [Use with your agent](#use-with-your-agent) • [Features](#features) • [Safety](#safety) • [Configuration](#configuration) • [Commands](#commands)

## Why this exists

Azure CLI JSON and raw REST responses expose more fields than an agent usually needs to choose its next action.
az-axi provides small metadata views, explicit empty states and scoped follow-up commands through a shell interface, without requiring an MCP server.
Native commands call Azure REST APIs directly; Azure CLI supplies the default ambient authentication.

## Features

- **Inventory:** inspect subscriptions, resources, compute, networks, DNS and governance.
- **Security:** inspect access, Defender posture, Sentinel incidents and public exposure.
- **Queries:** run Resource Graph and Log Analytics queries from flags, files or stdin.
- **Metadata:** list Blob, Key Vault and registry metadata without retrieving secret values or blob content.
- **Output:** select fields, expand details and bound collection fetches with incomplete-result disclosure.
- **Operations:** preview permitted writes, enforce subscription allowlists and record dispatched write outcomes locally.

## Quickstart

| Prerequisite | Requirement |
| --- | --- |
| Runtime | Node.js 22.12 or later and npm |
| Authentication | Azure CLI on PATH with an existing sign-in, or a [token profile](docs/configuration.md#authentication) |
| Azure access | Read permissions on the selected resources; see [permissions](#permissions) |

Install the CLI, sign in through Azure CLI's own flow, then inspect visible subscriptions:

```sh
npm install -g @knowttl/az-axi
az login
az-axi doctor
az-axi sub list
```

With an existing sign-in, no az-axi configuration is required.
The subscription output has the shape shown above; names, IDs, counts and profile reflect your identity.
`doctor` checks sign-in, token acquisition, ARM reachability and write posture; it exits 1 if a required check fails.
Its `workspaces` column lists each profile's configured workspace aliases, or `(none)`.
These read commands contact Azure.
For a one-off invocation without a global install, use `npx -y @knowttl/az-axi doctor` or `npx -y @knowttl/az-axi sub list`.

To save a named profile using the existing Azure CLI session:

```sh
az-axi config init --name work --auth az
az-axi auth status --profile work
```

Never paste tokens into command arguments or chat.
Token profiles resolve credentials from environment variables or private files through SecretRefs; az-axi has no login, logout or credential-store commands.

## Use with your agent

Install session integration from a persistent global installation:

```sh
az-axi setup hooks
```

This installs local-only session context for Claude Code and Codex, plus an OpenCode ambient plugin.
It injects the selected profile, scope, write posture, version and a next step, without network requests or Azure CLI subprocesses.
It also installs Claude Code's packaged Bash approval guard.
Restart the agent session after setup.
Repeat setup after moving or reinstalling the package to repair paths; unrelated settings are preserved.
Setup refuses temporary directories, worktrees and pipeline builds.

For on-demand command discovery, install the generated [agent skill](skills/az-axi/SKILL.md):

```sh
npx skills add knowttl/az-axi --skill az-axi
```

The skill uses `npx -y @knowttl/az-axi`, so it does not require a global installation.
The skill and session context are alternative discovery paths; either is sufficient.
The approval guard is a separate protection installed by hook setup.
To remove integrations, remove only az-axi entries from `SessionStart` in `~/.claude/settings.json` and `~/.codex/hooks.json`, the az-axi guard entry from Claude's `PreToolUse`, and `~/.config/opencode/plugins/axi-az-axi.js`.
Preserve other hooks and shared Codex feature settings.
See [approval-hook behavior and limits](docs/safety.md#agent-approval-hook).

<a id="writes"></a>
<a id="metadata-reads-and-security-boundaries"></a>

## Safety

Azure writes are disabled by default.
`config init` writes a local profile; `setup hooks` writes local agent settings.
Neither changes Azure resources.

| Azure write capability | Behavior |
| --- | --- |
| `security alert update` / `defender alerts update` | Change alert status |
| `sentinel incident update` | Change incident status, severity, owner or classification |
| `sentinel incident comment create` | Append a new comment on each execution |
| `tag update` | Merge or delete named tags; replacement refused |
| `network nsg rule create` | Create a Deny rule; destructive confirmation required |
| `api` | Policy-permitted ARM writes and destructive operations; credential-returning actions blocked |

Every Azure write requires a human-edited profile with `allowWrites: true` and a nonempty `subscriptions` allowlist.
The target must belong to that fixed allowlist; scope flags cannot widen it.
Without `--execute`, permitted requests return a preview instead of dispatching a write.
Destructive execution also requires `--confirm <resource-name>` with an exact name match.
`AZ_AXI_READ_ONLY=1` blocks both write previews and execution.
Preview reads and deployment what-if may contact Azure.
Use narrow RBAC permissions and review previews before approving execution.
See the complete [write gates, concurrency limits and async outcomes](docs/safety.md#writes).

The installed Claude Bash guard asks for human approval when it recognizes az-axi and `--execute` in shell text.
It needs an interactive session with permission prompts enabled; it does not cover PowerShell, other tools or unrecognizable dynamically assembled commands.
Codex and OpenCode receive session context only.
Verify the guard with harmless `az-axi api --help --execute` (approval expected) and `az-axi --help` (no approval expected).

Dispatched write attempts append metadata, excluding bodies and headers, to `~/.local/state/az-axi/writes.log` by default, or `%LOCALAPPDATA%\az-axi\writes.log` on Windows.
`XDG_STATE_HOME` changes the Unix state root; `AZ_AXI_WRITE_LOG` overrides the path.
Dry runs, no-ops and failures before dispatch are not logged.
If logging fails after dispatch, verify the resource before retrying.

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

### Credentials and data

The default profile uses Azure CLI's existing login cache.
az-axi does not persist acquired bearer tokens; token profiles reference environment variables or private files.
Secrets are redacted from output, including recognized nested fields and credentialed URLs.
Arbitrary provider text can still contain sensitive data; inspect output before sharing it.
See [metadata projections and redaction boundaries](docs/safety.md#metadata-reads-and-security-boundaries) and [credential storage protections](docs/configuration.md#authentication).

Native requests send selectors, query text and requested bodies to the selected Azure service over HTTPS.
ACR reads exchange an Entra token for a pull-scoped registry token.
The session hook stays local; normal CLI output goes to stdout and write audit metadata stays in the local log.

<a id="authentication"></a>

## Configuration

Use `az-axi config path` to locate configuration and `az-axi config list` to inspect profiles without printing tokens.
The default path is `~/.config/az-axi/config.json` on Unix and `%APPDATA%\az-axi\config.json` on Windows.

| Control | Purpose |
| --- | --- |
| `--config` / `AZ_AXI_CONFIG` | Override the config path |
| `--profile` / `AZ_AXI_PROFILE` | Select a profile |
| `--subscription`, `--tenant`, `--management-group` | Select supported read scope |
| `auth: az` | Use existing Azure CLI sign-in |
| `auth: token` with `armToken: { "env": "AZ_AXI_ARM_TOKEN" }` | Resolve a pre-acquired ARM token from the environment |
| `AZ_AXI_READ_ONLY=1` | Force write protection |
| `NODE_EXTRA_CA_CERTS` | Add a PEM root CA for TLS-inspecting networks |

<details>
<summary>Minimal named profile with writes disabled</summary>

```json
{
  "version": 1,
  "defaultProfile": "work",
  "profiles": {
    "work": { "auth": "az" }
  }
}
```

</details>

See [configuration](docs/configuration.md) for precedence, all environment variables, workspace aliases, SecretRefs and migration guidance.
Deprecated `AZ_AXI_TENANT`, `AZ_AXI_SUBSCRIPTION` and `tokenEnv` aliases remain accepted with stderr notices for one minor release; migrate to `AZ_AXI_TENANT_ID`, `AZ_AXI_SUBSCRIPTIONS` and SecretRefs.

<a id="use"></a>

## Commands

| Domain | Representative command |
| --- | --- |
| Orientation and profiles | `doctor`, `auth status`, `config list` |
| Inventory and access | `account list`, `resource list`, `role assignment list` |
| Security and incidents | `security alert list`, `sentinel incident list`, `exposure` |
| Infrastructure and governance | `vm list`, `network nsg list`, `policy state list` |
| Monitoring and queries | `monitor metrics list`, `graph query`, `monitor log-analytics query` |
| Data-plane metadata | `storage blob list`, `keyvault secret list`, `acr repository list` |
| REST and operations | `api`, `op status` |

Use a complete command path followed by `--help` for required selectors, supported flags and defaults.
The [command reference](docs/commands.md) covers the full surface, query inputs and compatibility aliases.
The [generated exact leaf list](skills/az-axi/SKILL.md#commands) comes from the CLI registry and is checked by `pnpm skill:check`.

`graph query`, `rg query`, `monitor log-analytics query` and `logs query` parse KQL locally before authentication or requests.
Syntax errors return exit 2 with `VALIDATION_ERROR`, up to five diagnostics with line, column, code, token and message, and query excerpts to guide corrections.
Successful parsing is silent; tables, columns, workspace functions, permissions and service-specific restrictions still require server checks.

<a id="behavior"></a>

### Output and exit codes

Data and structured errors use TOON on stdout; diagnostics and deprecation notices use stderr.
Help is plain text and version flags print the bare version.

| Exit | Meaning |
| --- | --- |
| 0 | Success, including no-ops |
| 1 | Other failures; `doctor` required-check failures |
| 2 | Usage and access errors, including `AUTH_REQUIRED`, `FORBIDDEN` and write-gate refusals |

`--fields a,b` selects supported fields; `--limit N` caps displayed rows, usually 50.
Native lists fetch up to 1,000 rows per subscription or collection by default; `--all` raises the budget to 10,000 and `--max-rows N` overrides it, with a 100-page ceiling.
Key Vault scans at most 2,500 objects at 25 per page.
`--full` expands fetched data and does not bypass fetch budgets.
Incomplete counts are disclosed as lower bounds unless the service supplies an exact total.
Graph, logs and raw API have distinct paging controls; see the [output and paging contract](docs/commands.md#behavior) and the [TOON compatibility review](docs/toon-compatibility.md).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `AUTH_REQUIRED` / Conditional Access failure | Refresh Azure CLI sign-in in the intended tenant, or replace expired external tokens, then run `doctor` |
| `TLS_ERROR` | Set `NODE_EXTRA_CA_CERTS` to your organization's PEM root CA and rerun `doctor` |
| `PROVIDER_NOT_REGISTERED` | Ask a subscription administrator to register the provider namespace named by Azure |
| Incomplete results | Narrow scope or increase `--max-rows`; `--full` only changes display |
| `WRITES_DISABLED` | Check the forced read-only environment setting and the selected profile's write opt-in |
| `CONFIG_MOVED` / `CONFIG_INVALID` | Follow the reported migration hint or inspect the [configuration reference](docs/configuration.md) |

## Contributing

Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm skill:check` locally.
GitHub test CI is not required by the local validation gate; no current CI status is claimed here. Release publishing runs its own validation and uses npm provenance.
See [CONTRIBUTING.md](CONTRIBUTING.md) for offline fixtures and release procedures, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

[MIT](LICENSE).
[NOTICE.md](NOTICE.md) and [UPSTREAM.md](UPSTREAM.md) credit ado-axi and Microsoft Azure CLI/SDK source excerpts.

If this project saved you time or helped your workflow, please consider giving it a ⭐ on GitHub to help others find it!
