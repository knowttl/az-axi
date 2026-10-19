# Configuration

[README](../README.md#configuration) · [Commands](commands.md)

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
| `allowWrites` | Human-edited write opt-in, requiring non-empty subscriptions; see [Writes](safety.md#writes) |

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
The package ships [axi-credential.schema.json](../axi-credential.schema.json), the strict schema for one profile, with `x-secret` on each secret field.
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
