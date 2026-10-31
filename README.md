# az-axi

Azure inspection and gated operations for agents and the humans running them, with compact TOON output.

[![npm version](https://img.shields.io/npm/v/%40knowttl%2Faz-axi)](https://www.npmjs.com/package/@knowttl/az-axi) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node.js](https://img.shields.io/badge/node-%3E%3D22.12.0-green)](package.json) [![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/@knowttl/az-axi#provenance) [![AXI](https://img.shields.io/badge/AXI-Agent%20eXperience%20Interface-blue)](https://github.com/knowttl)

[Why](#why-this-exists) · [Quickstart](#quickstart) · [Agent setup](#use-with-your-agent) · [Coverage](#what-it-covers) · [Safety](#safety) · [Configuration](#configuration) · [Output](#output-and-exit-codes) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing) · [Security](#security) · [License](#license)

## Why this exists

Azure CLI JSON and raw REST responses expose more fields than an agent usually needs to choose its next action.
az-axi provides bounded TOON metadata views, explicit empty states and scoped next-step hints through a shell interface.
Native commands call Azure REST APIs directly; Azure CLI supplies the default ambient authentication.
Writes require explicit gates, previews and verification so agents can inspect Azure before proposing a change.

## Quickstart

Requires Node.js 22.12 or later, npm, and Azure read access; use Azure CLI on PATH or a [token profile](docs/configuration.md#authentication).

```sh
npm install --global @knowttl/az-axi
az login
az-axi doctor
```

`doctor` checks sign-in, tokens, ARM reachability and write posture; see its [output contract](docs/commands.md#behavior).
One-off alternative: `npx -y @knowttl/az-axi doctor`.
With an existing Azure CLI sign-in, no configuration is required; optionally save a named profile, then run a read:

```sh
az-axi config init --name work --auth az
az-axi sub list --profile work
```

Synthetic subscription output (your identity determines the actual rows):

```toon
profile: work
count: 1 subscriptions
subscriptions[1]{name,id,state,inScope}:
  "Sandbox, demo",00000000-0000-0000-0000-000000000001,Enabled,yes
```

## Use with your agent

From a persistent global installation, install session context and Claude Code's Bash approval guard:

```sh
az-axi setup hooks
```

Restart the agent session after setup.
Claude Code, Codex and OpenCode receive local profile, scope, write posture and next-step context; only Claude Code receives the approval guard.
For on-demand discovery, install the skill: `npx skills add knowttl/az-axi --skill az-axi`.
The hooks and skill grant no Azure permissions.
Start investigations with the skill's [compact agent guide](skills/az-axi/SKILL.md#investigation-quickstart); its [command table](skills/az-axi/SKILL.md#commands) covers the full surface.
See [hook setup, limits and removal paths](docs/safety.md#agent-approval-hook) to repair or remove integrations while preserving unrelated settings.

<a id="features"></a>
<a id="commands"></a>
<a id="use"></a>

## What it covers

For community catalogs: az-axi is a shell CLI for inspecting Azure inventory, access, activity, security posture and service metadata, with Resource Graph and Log Analytics queries.
It uses the caller's Azure permissions and configured scope; it does not grant access or provide a comprehensive security audit.
Azure operations are read-only by default, with explicitly gated write operations as described below.
Data-plane commands inspect Blob, Key Vault and container registry metadata; they do not download blob contents, reveal secret values or pull images.

| Group | Purpose | Read/write | Reference |
| --- | --- | --- | --- |
| Orientation and profiles | Diagnose access, select profiles and install hooks | Reads; local setup writes | [Configuration](docs/configuration.md) |
| Inventory and access | Inspect subscriptions, resources, roles and activity | Read | [Commands](docs/commands.md#command-surface-and-subcommands) |
| Security and incidents | Inspect Defender, Sentinel and exposure; update alerts and incidents | Read/gated write | [Write families](docs/safety.md#writes) |
| Infrastructure and governance | Inspect compute, networks, DNS and policy; update tags or create Deny NSG rules | Read/gated write | [Commands](docs/commands.md#command-surface-and-subcommands) |
| Monitoring and queries | Query metrics, Resource Graph and Log Analytics | Read | [Query inputs](docs/commands.md#queries-and-request-bodies) |
| Data-plane metadata | Inspect Blob, Key Vault and ACR metadata | Read | [Security boundaries](docs/safety.md#metadata-reads-and-security-boundaries) |
| REST and operations | Preview permitted ARM writes, execute gated requests and check operations | Read/gated write | [REST gates](docs/safety.md#rest-previews-and-execution) |

Use a complete command path followed by `--help` when a command fails or its selectors, flags or defaults are unfamiliar.
The [command guide and generated exact leaf table](docs/commands.md#exact-command-reference) cover the full surface and compatibility aliases.

<a id="writes"></a>
<a id="metadata-reads-and-security-boundaries"></a>

## Safety

Azure operations are read-only by default; `config init` and `setup hooks` only write local settings.
Every Azure write requires a human-edited profile with `allowWrites: true` and a nonempty `subscriptions` allowlist; read-scope flags cannot widen it.
Permitted writes preview unless `--execute` is supplied; destructive execution also requires an exact `--confirm <resource-name>` match.
`AZ_AXI_READ_ONLY=1` blocks previews and execution; preview reads and deployment what-if may contact Azure.
Review previews and use the [least-privilege permissions](docs/safety.md#permissions) appropriate to each service.
See the [complete write matrix, verification limits and local audit log](docs/safety.md#writes).
The [Claude Bash guard](docs/safety.md#agent-approval-hook) asks for approval of recognized execution commands in interactive sessions with permission prompts enabled.
Credentials come from existing Azure CLI sign-in or private SecretRefs; az-axi does not persist acquired bearer tokens.
Recognized secrets are redacted, but arbitrary provider text may contain sensitive data; inspect output before sharing it.
See [credential protections](docs/configuration.md#authentication) and [metadata and data boundaries](docs/safety.md#metadata-reads-and-security-boundaries).

<a id="authentication"></a>

## Configuration

`az-axi config path` locates configuration; `az-axi config list` inspects profiles without printing tokens.
Select profiles with `--profile` or `AZ_AXI_PROFILE`; see [precedence, SecretRefs and migration](docs/configuration.md).

| Platform | Default config path |
| --- | --- |
| Linux/macOS | `~/.config/az-axi/config.json` (absolute `XDG_CONFIG_HOME` overrides the root) |
| Windows | `%APPDATA%\az-axi\config.json` (fallback: `~/AppData/Roaming/az-axi/config.json`) |

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `AZ_AXI_CONFIG`, `AZ_AXI_PROFILE` | Config path and profile selection | Platform path; profile selection rules |
| `AZ_AXI_TENANT_ID`, `AZ_AXI_SUBSCRIPTIONS`, `AZ_AXI_MANAGEMENT_GROUP` | Environment-profile tenant and read scope | Unset |
| `AZ_AXI_TENANT`, `AZ_AXI_SUBSCRIPTION` | Deprecated tenant/subscription aliases | Unset |
| `AZ_AXI_ARM_TOKEN`, `AZ_AXI_LOGS_TOKEN`, `AZ_AXI_GRAPH_TOKEN` | ARM, Log Analytics and Graph token SecretRefs | Unset |
| `AZ_AXI_STORAGE_TOKEN`, `AZ_AXI_VAULT_TOKEN`, `AZ_AXI_REGISTRY_TOKEN` | Native data-plane token SecretRefs | Unset |
| `AZ_AXI_READ_ONLY` | Force write protection (`1` or `true`) | Off |
| `AZ_AXI_WRITE_LOG` | Override dispatched-write journal path | Platform state directory + `writes.log` |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Absolute Unix config/state roots | `~/.config`, `~/.local/state` |
| `APPDATA`, `LOCALAPPDATA` | Windows config/state roots | `~/AppData/Roaming`, `~/AppData/Local` |
| `NODE_EXTRA_CA_CERTS` | Extra PEM root CA file for TLS | Unset |
| `AZURE_CONFIG_DIR` | Azure CLI authentication directory, retained for child processes | Azure CLI default |
| `CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `PI_CODING_AGENT`, `OPENCODE` | Host markers for skill-install hints | No detected host |
| `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` | Host skill lookup roots | `~/.claude`, `~/.pi/agent` |
| `AZ_AXI_PRIVATE_PATH`, `AZ_AXI_PRIVATE_ACTION`, `AZ_AXI_PRIVATE_DIRECTORY` | Internal Windows ACL subprocess transport | Tool-generated; not user overrides |

Custom SecretRefs read their named environment variables; Azure CLI uses its own authentication environment.
See [environment details](docs/configuration.md#environment-variables) for defaults and internal subprocess variables.

<a id="behavior"></a>

## Output and exit codes

Data and structured errors use TOON on stdout; diagnostics and deprecation notices use stderr.
Help is plain text; `--version` prints the bare version.

| Exit | Meaning |
| --- | --- |
| 0 | Success, including no-ops |
| 1 | Other failures; `doctor` required-check failures |
| 2 | Usage and access errors, including authentication and write-gate refusals |

`--fields a,b` selects supported fields; `--limit N` caps displayed rows.
`--full` expands fetched data without bypassing fetch budgets; incomplete counts are disclosed.
See [output and paging controls](docs/commands.md#behavior) for `--all`, `--max-rows` and command-specific limits, and the [TOON compatibility review](docs/toon-compatibility.md).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `AUTH_REQUIRED` / Conditional Access | Refresh Azure CLI sign-in or external tokens, then run `doctor` |
| `TLS_ERROR` | Set `NODE_EXTRA_CA_CERTS` to the required PEM root CA and rerun `doctor` |
| `PROVIDER_NOT_REGISTERED` | Ask an administrator to register the provider namespace named by Azure |
| Incomplete results | Narrow scope or increase `--max-rows`; `--full` only changes display |
| Write/config refusal | Review [write gates](docs/safety.md#writes) or follow the reported [config migration hint](docs/configuration.md) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for offline validation, generated references, development and releases.
Repository documentation ownership and validation policy live in [.no-mistakes.yaml](.no-mistakes.yaml).

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and security testing boundaries.

## License

[MIT](LICENSE).
[NOTICE.md](NOTICE.md) and [UPSTREAM.md](UPSTREAM.md) credit upstream source excerpts.
