# az-axi

Agent-ergonomic CLI for Azure, read-only by default.
Resource inventory, RBAC, activity log, Defender for Cloud and Log Analytics through token-efficient TOON output.

This is not [`masyanru/az-axi`](https://github.com/masyanru/az-axi), an unrelated project that owns the unscoped npm package `az-axi`.
This package is `@knowttl/az-axi`.
Never install both globally on one machine: the second install overwrites the `az-axi` binary.
`az-axi doctor` prints the package name and version it runs as.

## Install

Requires Node.js 22.12 or later, and the Azure CLI for the default `az` profile mode.

```
npm install -g @knowttl/az-axi
az-axi --help
az-axi doctor
```

`az-axi doctor` checks the Azure CLI, sign-in, tokens, reachability and write status of every profile; see [Configure](#configure).

From source:

```
git clone https://github.com/knowttl/az-axi.git
cd az-axi
pnpm install --frozen-lockfile
pnpm run build
node dist/bin/az-axi.js --help
```

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
az-axi logs query "SigninLogs | take 5" --workspace sentinel
az-axi logs query --file hunt.kql --workspace sentinel --timespan P7D
```

The identity needs Log Analytics Reader on the workspace.
Use `az-axi logs --help` for workspace IDs, query input handling, time windows and output limits.

## Use

One example per command; every command also accepts `--help` with its full reference.

```
az-axi                                                  # dashboard: profile, identity, subscriptions, alerts, score, exposure
az-axi doctor                                           # check az, tokens, ARM reachability and write status per profile
az-axi config list                                      # profiles with scope, write status and description
az-axi sub list                                         # subscriptions visible to the identity
az-axi rg query "Resources | take 5"                     # Resource Graph query across subscriptions
az-axi rbac list --privileged                           # role assignments for privileged roles
az-axi activity list --since 24h --status Failed        # activity log across subscriptions, newest first
az-axi defender alerts --severity High                  # active Defender alerts
az-axi defender assessments --severity High             # recommendations grouped with unhealthy counts
az-axi defender score                                   # secure score per subscription, lowest first
az-axi exposure --check mgmt-ports                      # NSGs exposing management ports
az-axi logs query "SigninLogs | take 5" --workspace sentinel  # Log Analytics KQL (see Query logs)
az-axi api /subscriptions --api-version 2022-12-01      # escape hatch for any read or query request
```

Every command accepts `--profile`, `--tenant`, `--subscription a,b`, `--management-group` and `--config`.
List output honours `--fields a,b`, `--limit N` and `--full`.

## Behavior

Errors render as TOON with a `code` and at least one actionable `help[]` entry.
Exit code 2 covers usage and access errors; exit code 1 covers requests that were sent but failed.
Writes are currently blocked with `WRITES_DISABLED`; see Writes.

| Code | Exit | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 2 | Bad flag value, missing argument, unknown command |
| `UNKNOWN_FLAG` | 2 | Flag not accepted by this command; the error names the closest valid flags |
| `AUTH_REQUIRED` | 2 | Not signed in, token missing or expired |
| `FORBIDDEN` | 2 | Signed in, but RBAC denies access; the hint names the role needed |
| `NOT_FOUND` | 2 | Subscription, workspace or resource not found |
| `READ_ONLY` | 2 | Request class not permitted for this resource |
| `WRITES_DISABLED` | 2 | Write or destructive request blocked because writes are disabled |
| `SUBSCRIPTION_NOT_WRITABLE` | 2 | Write targets a subscription outside the writable scope (write framework) |
| `CONFIRM_REQUIRED` | 2 | Destructive request without `--confirm <resource-name>` (write framework) |
| `CONFIRM_MISMATCH` | 2 | `--confirm` value does not match the target resource name (write framework) |
| `PRECONDITION_FAILED` | 1 | HTTP 412: the resource changed since it was read |
| `CONFLICT` | 1 | HTTP 409 from ARM |
| `OPERATION_FAILED` | 1 | A long-running operation finished as Failed or Canceled (write framework) |
| `OPERATION_TIMEOUT` | 1 | Polling exceeded `--timeout` (write framework) |
| `TLS_ERROR` | 1 | Certificate trust failure; see TLS-inspecting proxies in Configure |
| `RATE_LIMITED` | 1 | HTTP 429 or throttled; the hint carries the retry delay |
| `NETWORK_ERROR` | 1 | The request could not be sent |
| `API_ERROR` | 1 | Anything else, with the HTTP status and ARM `error.code` |

## Writes

Writes are disabled.
Every write or destructive request is blocked with `WRITES_DISABLED`.
A profile with an invalid write configuration is rejected before it is used.
