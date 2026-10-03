# az-axi

Agent-ergonomic CLI for Azure, read-only by default.
Resource inventory, RBAC, activity log, Defender for Cloud and Log Analytics through token-efficient TOON output.

This is not [`masyanru/az-axi`](https://github.com/masyanru/az-axi), an unrelated project that owns the unscoped npm package `az-axi`.
This package is [`@knowttl/az-axi`](https://www.npmjs.com/package/@knowttl/az-axi).
Never install both globally on one machine: the second install overwrites the `az-axi` binary.
`az-axi doctor` prints the package name and version it runs as.

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

az-axi works right after `az login`, before any config file exists.
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
| `tokenEnv` | Resource (`arm`, `logs`, `graph`) to environment variable name, for `token` mode |

Create a profile without editing JSON:

```
az-axi config init --name work --auth az --tenant 00000000-0000-0000-0000-000000000001
az-axi config list
az-axi config path
```

Every command accepts `--profile`, `--tenant`, `--subscription a,b`, `--management-group` and `--config`.
`$AZ_AXI_TENANT` and `$AZ_AXI_SUBSCRIPTION` set the same overrides from the environment.
`$AZ_AXI_READ_ONLY=1` forces the whole process read-only whatever a profile says.

### Signing in

Any identity that `az` understands works in `az` mode.

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
az-axi logs query --file hunt.kql --workspace sentinel --timespan P7D
```

The identity needs Log Analytics Reader on the workspace.
See the agent guide's [safe shell input rule](skills/az-axi/SKILL.md#safe-shell-input) for query input across shells.
Use `az-axi logs --help` for workspace IDs, query input handling, time windows and output limits.

## Use

One example per inspection command; see [Profiles](#profiles) for `config init` and `config path` examples.
Every command also accepts `--help` with its full reference.

The machine-readable exact leaf registry in [src/lib/registry.ts](src/lib/registry.ts) records 17 native leaves across 12 top-level handlers.
It owns dispatch metadata, Azure effects and the existing grouped help, and generates the [agent skill command list](skills/az-axi/SKILL.md#orientation).
Capability labels distinguish `native` implementations, `api-only` reviewed raw API operations, `blocked` policy exclusions and `unsupported` operations.
Only existing native leaves are catalogued here; this registry does not claim coverage for other Azure commands or add command paths.
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
az-axi defender assessments --severity High             # recommendations grouped with unhealthy counts
az-axi defender score                                   # secure score per subscription, lowest first
az-axi exposure --check mgmt-ports                      # NSGs exposing management ports
az-axi logs query --file hunt.kql --workspace sentinel   # Log Analytics KQL (see Query logs)
az-axi api /subscriptions --api-version 2022-12-01      # escape hatch for any read or query request
az-axi op status '<operation-url>' --profile work       # read the current result of a pending operation
```

See [Profiles](#profiles) for selector flags and environment overrides, and [Behavior](#behavior) for output controls.

## Behavior

Resource inspection commands bound rows and long cells by default, except `api` lists have no default row cap.
Use `--limit N` to cap rows and `--fields a,b` to select list columns.
`--full` expands truncated cells and removes display row limits for most inspection lists; `rg query` keeps its page cap, and `logs query` and `api` still honor `--limit`.
`api` follows additional pages only with `--all`, subject to a page cap.
Use each command's `--help` for its defaults and paging limits.

Command output replaces recognized secret fields and values with `***redacted***`, including nested objects and arrays.
Errors render as TOON with a `code` and `help[]` suggestions when available.
Unexpected errors use `UNKNOWN` with exit code 1 and no `help[]`.
Exit code 0 means successful completion; exit code 2 covers usage and access errors, and exit code 1 covers other failures, including network failures before a response is received.
See [Writes](#writes) for the read-only policy.

| Code | Exit | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 2 | Bad flag value, missing argument, unknown command |
| `UNKNOWN_FLAG` | 2 | Flag not accepted by this command; the error names a known replacement or lists valid flags |
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
| `CONFLICT` | 1 | HTTP 409 from ARM |
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
To permit `api` previews and execution, a human must hand-edit the selected profile with `"allowWrites": true` and a non-empty `subscriptions` list.
Find the selected configuration file with `az-axi config path`, then edit only the intended profile.
No az-axi command enables writes.
A profile with an invalid write configuration is rejected before it is used.
Writes are limited to ARM; Graph and Log Analytics accept only reads and supported queries.
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
For example, `az-axi api PATCH <resource-path> --api-version <version> --body '<json>' --profile <profile>` previews a field-level diff.
PUT and PATCH previews show `changes[]{path,from,to}`, capped at 20 rows with `remaining` for additional changes, and `noop: true` when nothing would change.
PUT also lists omitted fields as removals; PATCH normally compares supplied fields, but supplying `tags` replaces the tag set, so omitted tags appear as removals.
Preview output includes the request class, method, shortened target, subscription, redacted body and available ETag; `--full` expands a truncated body.
DELETE previews summarize the resource and warn about detected resource or resource-group locks; a failed lock check produces a hint.
Other POST actions show the body and execution command without a current-state diff.
Completed deployment what-if previews summarize change counts.
Pending deployment previews return an `az-axi op status` command without polling or an execution command.
Other previews include a shell-quoted execution command with an available ETag and destructive confirmation; redacted bodies use a `<json-body>` placeholder that must be replaced with the original body.

Add `--execute` to send the write after all gates pass.
Destructive execution requires `--confirm <resource-name>`, matching the percent-decoded resource name exactly; for destructive POST actions, use the name preceding the action segment.
DELETE, recognized disruptive POST actions, and PUT/PATCH on protected Microsoft.Authorization types require this confirmation; [policy.ts](src/lib/policy.ts) owns the lists.
Execution re-reads the resource, or the parent resource for POST actions, before sending.
Use `--if-match <etag>` from the reviewed preview for review-to-execute protection.
Without it, execution uses the fresh GET's ETag when available and reports that review-to-execute protection was not used.
An unchanged PUT/PATCH or DELETE of an already absent resource returns `result: already in desired state (no-op)` without sending or logging a write.

Async writes with HTTP 201/202 and an operation URL poll automatically, preferring `Azure-AsyncOperation` over `Location`.
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
