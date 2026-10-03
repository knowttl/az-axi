# az-axi Implementation Plan

| Field | Value |
|---|---|
| Project | az-axi, an agent-ergonomic CLI for Azure, read-only by default |
| Owner and reviewer | knowttl |
| Implementer | Coding agent (Claude Code or equivalent), working phase by phase |
| Version | 1.3 (repository structure aligned with ado-axi; adds reference index, verification guide, maintenance design, ideas adopted from masyanru/az-axi) |
| Date | 2026-10-01 |
| Upstream reference | `jeffreyhaen/ado-axi` at commit `1a381cbbafc5b9127e1381fbd2c404f591ada881` |

---

## 0. How to use this plan (instructions for the agent)

1. Read this whole file before writing any code. It is self-contained: everything the implementing agent needs is here, including the working agreements in Section 10.4.
2. Work strictly one phase at a time, in order. Do not start a phase until the owner has approved the previous phase's gate.
3. At the end of each phase, stop and produce a short gate report: what was built, test results, anything deferred, and the exact live smoke commands the owner should run locally. Then wait.
4. When this plan and the upstream code disagree, this plan wins. When this plan is silent, follow ado-axi's existing pattern.
5. Every item marked **VERIFY** must be checked before it is coded, using the procedure in Section 14.2. Record the verified value, the source and the date in `src/lib/apiVersions.ts` (Section 14.2).
6. When you need information this plan does not contain, look it up in the Reference index (Section 15) before guessing. Each command in Section 6 also has a **Reference** line pointing at its primary documentation and specification file.
7. Before reporting a phase complete, run every check in the Verification guide (Section 14) that applies to that phase and paste the results into the gate report.
8. Never weaken an invariant in Section 7 to make a test pass. Stop and ask instead.
9. Documentation pages sometimes move. If a link in this plan is dead, search Microsoft Learn (or the named site) for the page title given next to it, and record the new URL in the gate report and in Section 15.

---

## 1. Executive summary

az-axi is a command-line tool designed for AI agents rather than humans, following the AXI (Agent eXperience Interface) principles: token-efficient TOON output, small default schemas, truncation with an explicit `--full` escape, pre-computed aggregates, definitive empty states, structured errors with next-step hints, and a content-first dashboard when run with no arguments.

It gives a security analyst's agent visibility into Azure: resource inventory through Azure Resource Graph, role assignments, the activity log, Microsoft Defender for Cloud alerts, assessments and secure score, internet exposure checks, and Log Analytics KQL queries. A guarded raw REST escape hatch covers everything else.

The tool is **read-only by default**. It also ships a complete write framework (request classification, dry-run previews with field-level diffs, compare-and-swap with ETags, idempotent no-ops, long-running operation polling, typed-name confirmation for destructive actions, request correlation and a local write log), but writes stay disabled unless the owner opts a profile in by hand, and even then every write needs `--execute`. In v1 the only write path is the `api` escape hatch; curated write commands come later, and each one plugs into the same framework.

The tool is a standalone TypeScript repository that mirrors the structure of `ado-axi`. It reuses ado-axi's helper modules (authentication, profiles, argument parsing, formatting, HTTP client and error translation) by vendoring them with MIT attribution and generalizing them, rather than rewriting them. The shared runtime comes from `axi-sdk-js`, the same package ado-axi uses. Authentication matches ado-axi's two modes: `az` (the Azure CLI, which transparently covers user, service principal, managed identity and federated sign-in) and `token` (a pre-acquired bearer token read from an environment variable, the Azure equivalent of ado-axi's PAT mode).

The repository is public on the owner's personal GitHub account and published to npm. Because of that, no live tenant access exists in CI, and no real tenant, subscription or organization identifiers may ever enter the repository.

---

## 2. Background

### 2.1 AXI and TOON

AXI is a set of design principles for CLIs that agents use (see `axi.md` and `kunchenguid/axi`). TOON is a compact, table-friendly serialization of JSON-like data that typically uses far fewer tokens than JSON for lists of records. ado-axi and msgraph-axi both demonstrate the pattern.

### 2.2 What is reused from ado-axi

ado-axi (about 5,000 lines of TypeScript) is organized as:

| Path | Lines | Role | Reuse in az-axi |
|---|---|---|---|
| `src/bin/ado-axi.ts` | 162 | Entry point: `runAxiCli`, aliases, error formatter, exit codes | Copy pattern, rewrite command table |
| `src/lib/auth.ts` | 125 | `az account get-access-token` via `cross-spawn`, PAT from env var, in-memory cache, structured auth errors | Vendor and generalize (resource parameter, `token` mode) |
| `src/lib/config.ts` | 192 | Profiles in `~/.ado-axi/config.json`, resolution order, env overrides | Vendor and adapt fields (tenant, subscriptions, workspaces) |
| `src/lib/args.ts` | 96 | Flag parsing, unknown-flag rejection with rename hints | Vendor almost unchanged |
| `src/lib/argv.ts` | 32 | Moves leading selector flags behind the command | Vendor, change selector flag list |
| `src/lib/client.ts` | 184 | `fetch` wrapper, URL builder, HTTP status to `AxiError` translation | Vendor and rewrite for ARM, Log Analytics and Graph hosts |
| `src/lib/format.ts` | 73 | `truncate`, `shortDate`, `pickFields`, `countLine`, `emptyState` | Vendor, drop ADO-only helpers |
| `src/lib/paths.ts`, `stdin.ts`, `context.ts` | 49 | Home dir collapsing, piped stdin, profile from args | Vendor |
| `src/help.ts` | 207 | `TOP_LEVEL_HELP` and per-command help strings | Copy pattern |
| `src/commands/api.ts`, `doctor.ts`, `config.ts`, `home.ts` | ~460 | Escape hatch, auth check, profile management, dashboard | Copy pattern, rewrite |
| `.github/workflows/ci.yml`, `release.yml`, `scripts/release-notes.mjs` | | CI matrix (Ubuntu Node 22 and 24, Windows Node 22), tag-driven npm release | Copy nearly unchanged |
| `tsconfig.json`, `.nvmrc`, `.gitignore`, `pnpm-workspace.yaml`, vitest setup | | Tooling | Copy |
| `benchmark/`, `scripts/benchmark/*.mjs`, `BENCHMARK.md`, `test/benchmark.test.ts` | | Scenario list, fetch preload hook for record and replay, default-deny scrubber, token counter, published results | Copy pattern; adapt scenarios and the scrubber to Azure identifiers (Section 13.4) |
| `test/*.test.ts` | | Flat test folder, one file per area and aspect, inline payloads, `vi.mock("../src/lib/client.js")` | Copy pattern |
| `README.md`, `SKILL.md`, `CHANGELOG.md`, `assets/ado-axi-header.png` | | All user and agent documentation lives in root files; there is no `docs/` folder | Copy pattern, except the skill moves to `skills/az-axi/SKILL.md` (Section 4.5) |

Key runtime facts from the upstream code that az-axi must preserve:

- Handlers are `(args: string[]) => Promise<Record<string, unknown>>`. `runAxiCli` serializes the returned object to TOON. Handlers never print directly.
- Errors are thrown as `new AxiError(message, code, suggestions[])`. The entry point's `formatError` renders `{ error, code, help[] }` as TOON on stdout and maps a set of usage codes to exit code 2; everything else is exit code 1.
- `az` is spawned with `cross-spawn` (not `child_process.spawn`) because on Windows `az` is a `.cmd` shim. Arguments are passed as an array, never a shell string.
- Client tests stub `fetch` with `vi.stubGlobal("fetch", ...)`; command tests mock the client module with `vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }))` and feed inline payloads. Both assert on `AxiError` codes and suggestions.
- `pnpm run build` (plain `tsc`) is the type check. There is no separate `typecheck` script.

### 2.3 Azure APIs used

| Purpose | Host | Token resource |
|---|---|---|
| Resource Graph, RBAC, activity log, Defender for Cloud, subscriptions | `https://management.azure.com` | `https://management.azure.com/` |
| Log Analytics query | `https://api.loganalytics.io` | `https://api.loganalytics.io` |
| Principal name resolution only | `https://graph.microsoft.com` | `az` flag `--resource-type ms-graph` |

All authorization is Azure RBAC. The identity needs **Reader** and **Security Reader** at the management group (or subscription) scope, and **Log Analytics Reader** on any workspace it queries. Writes, when enabled, additionally need whatever write role the target operation requires; those should be PIM-eligible and scoped to the write-enabled subscriptions only.

### 2.4 Naming and the existing `az-axi` package

An unrelated project, `masyanru/az-axi`, already uses this name: it owns the unscoped npm package `az-axi`, installs a binary named `az-axi`, and publishes an agent skill named `az-axi`. This project keeps the name but must avoid colliding with it:

| Item | This project | Why |
|---|---|---|
| npm package | `@<npm-scope>/az-axi` (scoped) | The unscoped name is taken |
| Binary | `az-axi` | Matches the name; Section 16 next steps covers the global install clash |
| Skill name | `az-axi` in `skills/az-axi/SKILL.md`, installed from `<owner>/az-axi` | `npx skills add` is keyed by repository, so the source repo disambiguates |
| Config directory | `~/.az-axi/` | Not used by the other project (checked: it stores nothing under the home directory except reading `~/.azure`) |
| Environment variables | `AZ_AXI_*` | Not used by the other project |

Rules: never install both packages globally on the same machine (the second install overwrites the `az-axi` binary). README and `skills/az-axi/SKILL.md` must state that this is a different project from `masyanru/az-axi` and link the scoped npm package explicitly. `doctor` reports the package name and version it is running as, so a clash is visible.

### 2.5 Ideas adopted from `masyanru/az-axi`

A review of `masyanru/az-axi` (v0.1.4, MIT) found these ideas worth adopting. No code is copied; each is reimplemented here:

| Idea | Where it lands |
|---|---|
| Harden every `az` spawn with `AZURE_CORE_COLLECT_TELEMETRY=no`, `AZURE_CORE_ONLY_SHOW_ERRORS=true`, `AZURE_CORE_DISABLE_CONFIRM_PROMPT=1` | `runAz` in `auth.ts` (Section 5.2) |
| Token comparison of raw JSON versus TOON for any command | `pnpm bench` dev script (Section 13.4), kept out of the runtime so dependencies stay at three |
| Secret redaction, extended with value patterns because key-name matching alone missed storage keys, Cosmos DB keys and ACR passwords in that project | `redact.ts` (Section 6.13.8) |
| Treat unknown operations as writes, never as reads | `policy.ts` fall-through rule (Section 6.13.1) |

Problems found in that review that this plan deliberately avoids: spawning `az` with `execFile` (fails on Windows because `az` is a `.cmd` shim), Ubuntu-only CI, an `--execute` flag as the only write control, and unpinned `npx -y` in skill instructions.

---

## 3. Scope

### 3.1 In scope (v1)

| Area | Commands |
|---|---|
| Orientation | `az-axi` (dashboard), `doctor`, `config init`, `config list`, `config path`, `sub list` |
| Inventory | `rg query` (Resource Graph KQL) |
| Access and activity | `rbac list`, `activity list` |
| Security posture | `defender alerts`, `defender assessments`, `defender score`, `exposure` |
| Logs | `logs query` (Log Analytics KQL) |
| Escape hatch | `api` (reads and queries always; writes only through the gated write framework, Section 6.13) |
| Write framework | Policy classification, gates, dry-run and diff, ETag compare-and-swap, no-op detection, long-running operations, `op status`, write log, redaction, agent guard hook (all disabled by default) |

### 3.2 Out of scope (v1)

- Curated write commands (for example `tag set`, `lock add`). The framework supports them; each is added later with its own design and tests.
- Any write through the Graph or Log Analytics resources. az-axi only writes to ARM. Directory changes belong to entra-axi.
- Key Vault data plane (secrets, keys, certificates). Vault metadata is reachable through `rg query`.
- Microsoft Sentinel incident management (reachable read-only through `logs query` and `api`).
- Cost management.
- Session start hooks (`axi-sdk-js` `installSessionStartHooks`). Deferred because the dashboard contains security data that should not be injected into every agent session by default.

### 3.3 Deferred to later

- A shared package extracted from az-axi and ado-axi helpers, created when entra-axi starts.
- Curated write commands, added one at a time once a concrete need exists.
- entra-axi itself.
- An `@azure/identity` based provider. Not needed while `az` covers every identity type.

---

## 4. Repository layout

The layout mirrors ado-axi at commit `1a381cb` file for file. Paths marked **(addition)** have no ado-axi counterpart and exist for a reason given in the cited section. Do not add top-level folders beyond these.

### 4.1 Tree

```
az-axi/
  .claude/
    skills/                            (addition, Section 13.3)
      add-command/SKILL.md
      fix-drift/SKILL.md
      release/SKILL.md
      verify-api-version/SKILL.md
  .github/
    CODEOWNERS                         (addition, Section 10.2)
    dependabot.yml                     (addition, Section 10.2)
    workflows/
      ci.yml                           copied from ado-axi
      release.yml                      copied from ado-axi
  .gitignore                           copied, names changed (Section 4.2)
  .nvmrc                               22
  BENCHMARK.md                         published benchmark results (Section 13.4)
  CHANGELOG.md
  LICENSE                              MIT, owner's copyright
  NOTICE.md                            (addition) upstream MIT attribution (Section 7.5)
  PLAN.md                              (addition) this file
  README.md                            all human documentation (Section 4.3)
  UPSTREAM.md                          (addition) vendored files and source commit (Section 7.5)
  assets/
    az-axi-header.png                  optional README header image, as ado-axi has
  benchmark/
    scenarios.mjs                      az-axi invocations to benchmark
    targets.example.json               template; real targets.json is gitignored
    tool-surface.json                  skill and help surface token counts
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml                  packages: []
  scripts/
    benchmark/
      bench.mjs                        replays captures, compares raw JSON vs TOON
      capture-surface.mjs              measures skill and help token cost
      capture.mjs                      records live responses through the fetch hook (owner only)
      fetch-hook.mjs                   --import preload: record or replay fetch traffic
      scrub.mjs                        default-deny scrubber, adapted to Azure identifiers
      tokens.mjs                       o200k token counting
    check-links.mjs                    (addition, Section 14.7)
    claude-guard.mjs                   (addition, Section 6.13.10)
    live-smoke.mjs                     (addition, Section 13.2) owner only, never in CI
    release-notes.mjs                  copied from ado-axi
    upstream-diff.mjs                  (addition, Section 13.6)
  skills/                              (deviation from ado-axi, Section 4.5)
    az-axi/
      SKILL.md                         agent usage guide, published with the package
  src/
    bin/
      az-axi.ts                        entry point, command table, aliases, error formatter
    commands/
      activity.ts
      api.ts
      config.ts
      defender.ts
      doctor.ts
      exposure.ts
      home.ts
      logs.ts
      op.ts
      rbac.ts
      rg.ts
      sub.ts
    help.ts                            top-level and per-command help text
    lib/
      apiVersions.ts                   pinned api-versions with verification notes (Section 14.2)
      args.ts                          vendored
      argv.ts                          vendored
      auth.ts                          vendored and generalized (Section 5.2)
      client.ts                        vendored and rewritten for arm, logs, graph
      config.ts                        vendored and adapted (Section 5.4)
      context.ts                       vendored
      diff.ts                          field-level diff for dry runs
      dryRun.ts                        write previews (Section 6.13.3)
      format.ts                        vendored
      gates.ts                         write gate order (Section 6.13.2)
      kusto.ts                         Log Analytics tables to objects
      lro.ts                           long-running operation polling (Section 6.13.5)
      paths.ts                         vendored
      policy.ts                        request classification (Section 6.13.1)
      principals.ts                    Graph getByIds name resolution
      queries.ts                       canned Resource Graph KQL as named constants (Section 6.9)
      redact.ts                        secret redaction (Section 6.13.8)
      registry.ts                      command metadata and declared effects (Section 6.13.9)
      roles.ts                         built-in privileged role definition GUIDs
      scope.ts                         ARM resource ID shortening
      stdin.ts                         vendored
      time.ts                          24h, 7d, ISO 8601 parsing
      usageLog.ts                      opt-in usage log (Section 13.5)
      writeLog.ts                      local write log (Section 6.13.7)
  test/
    activityList.test.ts
    apiCommand.test.ts
    apiWrites.test.ts
    args.test.ts
    auth.test.ts
    benchmark.test.ts                  scrubber and token counter, as in ado-axi
    budget.test.ts                     token ceilings per command
    client.test.ts
    config.test.ts
    defenderAlerts.test.ts
    defenderAssessments.test.ts
    defenderScore.test.ts
    diff.test.ts
    doctor.test.ts
    dryRun.test.ts
    exposure.test.ts
    format.test.ts
    gates.test.ts
    home.test.ts
    identifiers.test.ts                public-repo guard (Section 7.3)
    kusto.test.ts
    logsQuery.test.ts
    lro.test.ts
    policy.test.ts                     policy and effect snapshot (Section 7.1)
    rbacList.test.ts
    redact.test.ts
    release-notes.test.ts              copied from ado-axi
    rgQuery.test.ts
    samples.ts                         shared synthetic payloads derived from spec examples (Section 14.3)
    scope.test.ts
    stdin.test.ts
    subList.test.ts
    time.test.ts
    writeLog.test.ts
  tsconfig.json                        copied from ado-axi
```

Naming conventions, as in ado-axi: one file per top-level command in `src/commands/`, lowerCamel file names in `src/lib/`, and flat test files named `<area><Aspect>.test.ts`. A new aspect gets a new test file rather than a subfolder.

### 4.2 `package.json` and `.gitignore`

`package.json` mirrors ado-axi's fields (`type: module`, `bin`, `files`, `publishConfig`, `engines`) with these scripts:

```json
{
  "build": "tsc -p tsconfig.json",
  "dev": "tsx src/bin/az-axi.ts",
  "test": "vitest run",
  "test:watch": "vitest",
  "bench": "node scripts/benchmark/bench.mjs",
  "bench:capture": "node scripts/benchmark/capture.mjs",
  "bench:surface": "node scripts/benchmark/capture-surface.mjs",
  "prepare": "npm run build",
  "prepublishOnly": "npm run build && npm test"
}
```

`files` is `["dist", "skills/az-axi", "README.md", "LICENSE", "NOTICE.md", "assets"]`.

`.gitignore` is ado-axi's with names changed, plus the local logs:

```
node_modules/
dist/
*.log
.DS_Store
.env
.env.local
*.tsbuildinfo

# Never commit local profile/auth configuration
az-axi.config.json
az-axi.config.local.json

# Benchmark capture targets name a real tenant and resources
benchmark/targets.json
benchmark/raw/
benchmark/fixtures/
benchmark/results.json

# Editor
.vscode/
.idea/
*.swp
```

### 4.3 Documentation lives in root files

ado-axi has no `docs/` folder, so neither does az-axi. Human documentation is a set of `README.md` sections, kept in this order to match ado-axi's README, with az-axi's extra sections inserted where they fit:

| README section | Contents |
|---|---|
| Title, badges, header image, one-paragraph intro | As ado-axi, plus a line stating this is not `masyanru/az-axi` (Section 2.4) |
| Why AXI: CLI vs MCP vs AXI | Table filled from `BENCHMARK.md` |
| Install | `npm install -g @<npm-scope>/az-axi` |
| Agent integration | `npx skills add <owner>/az-axi --skill az-axi -g`, plus the guard hook setup and `AZ_AXI_READ_ONLY=1` advice (Section 6.13.10) |
| Configure | Profiles, `az` and `token` modes, every sign-in path (user, `--tenant`, service principal with certificate, managed identity, federated token), TLS inspection note (Section 5.3) |
| Required Azure roles | Reader, Security Reader, Log Analytics Reader; write roles PIM-eligible |
| Use | One example per command |
| Behavior | Bounded output, redaction, error codes and exit codes, read-only default |
| Writes | How a human enables writes by hand-editing a profile, the subscription restriction, every gate, the write log location, recommended RBAC. Error hints point here as `README.md#writes` |
| API versions | Table generated from `src/lib/apiVersions.ts` |
| Design | The AXI principles applied |
| Development | Build, test, dev, benchmark commands |
| Maintaining | The routine from Section 13 |
| Releasing | As ado-axi |
| License, See also | As ado-axi, plus NOTICE.md |

### 4.4 Dependencies

| Package | Kind | Why |
|---|---|---|
| `axi-sdk-js` | runtime | `runAxiCli`, `AxiError`, TOON rendering (same as ado-axi) |
| `@toon-format/toon` | runtime | `encode` in the custom error formatter (same as ado-axi) |
| `cross-spawn` | runtime | Windows-safe `az` spawning (same as ado-axi) |
| `typescript`, `tsx`, `vitest`, `@types/node`, `@types/cross-spawn` | dev | Build, dev run, tests |
| `gpt-tokenizer` | dev | Token budget assertions and the benchmark harness, as in ado-axi |

No other runtime dependencies without the owner's approval. Pin the same major versions ado-axi uses at the upstream commit.

### 4.5 Skill location

ado-axi keeps its agent skill at the repository root (`SKILL.md`). az-axi deliberately places it at `skills/az-axi/SKILL.md` instead:

- A `skills/<name>/SKILL.md` folder keeps the root for project files and leaves room for more skills later (for example a separate write-operations skill) without restructuring.
- It is a common convention for published agent skills; `masyanru/az-axi` uses exactly this path with the same `npx skills add <repo> --skill <name>` install command.
- The frontmatter is unchanged from ado-axi's pattern: `name: az-axi`, a `description` with trigger words, and `user-invocable: false`.

Two skill locations exist in the repository, and they must not be confused:

| Path | Audience | Published |
|---|---|---|
| `skills/az-axi/SKILL.md` | Agents *using* az-axi | Yes, through `files` in `package.json` and `npx skills add` |
| `.claude/skills/*/SKILL.md` | Agents *maintaining* this repository (Section 13.3) | No |

**VERIFY** in Phase 7, before release, that `npx skills add <owner>/az-axi --skill az-axi -g` discovers the skill under `skills/az-axi/` from the pushed repository. If it does not, the fallback is a root `SKILL.md` as in ado-axi; record the outcome in the gate report.

---

## 5. Authentication design

### 5.1 Modes

| Mode | Source | Covers |
|---|---|---|
| `az` (default) | `az account get-access-token --resource <r> [--tenant <t>] --output json` | Whatever `az login` holds: interactive user, service principal (secret or certificate), managed identity (`az login --identity`), federated (`az login --service-principal --federated-token ...`) |
| `token` | One environment variable per resource, named in the profile | CI or any environment where a token is minted elsewhere. The Azure equivalent of ado-axi's `pat` mode |

There is deliberately no third mode in v1. Service principals and managed identities are handled by `az login`, which keeps secret handling out of az-axi entirely.

### 5.2 Generalizing `auth.ts`

Starting from the vendored ado-axi `auth.ts`:

1. Replace the hardcoded `ADO_RESOURCE` constant with a `Resource` type: `"arm" | "logs" | "graph"`.
2. Map resources to az arguments:
   - `arm` -> `--resource https://management.azure.com/`
   - `logs` -> `--resource https://api.loganalytics.io`
   - `graph` -> `--resource-type ms-graph`
3. Change the signature to `resolveCredential(profile, resource)` and include the resource in the cache key: `${profile.auth}:${resource}:${profile.tenant ?? ""}:${tokenEnvFor(resource) ?? ""}`.
4. Parse `expiresOn` (or `expires_on`) from the az JSON output and treat a cached token as missing if it expires within 5 minutes. A CLI process is short-lived, so this mostly matters for `doctor` and the dashboard, which make many calls.
5. Replace `patCredential` with `tokenCredential(profile, resource)`: read `process.env[profile.tokenEnv[resource]]`, return `Bearer <token>`. If missing, throw `AUTH_REQUIRED` with these suggestions:
   - `Set $<VAR> to an access token for <resource url>`
   - `Mint one with: az account get-access-token --resource <resource url> --query accessToken --output tsv`
   - `Or switch the profile to "auth": "az"`
6. Keep `runAz` as upstream (cross-spawn, 8 MB output cap, ENOENT detection, `windowsHide`), and add the environment hardening from Section 2.5: spawn with `{ ...process.env, AZURE_CORE_COLLECT_TELEMETRY: "no", AZURE_CORE_ONLY_SHOW_ERRORS: "true", AZURE_CORE_DISABLE_CONFIRM_PROMPT: "1" }`. Reference: Azure CLI configuration (https://learn.microsoft.com/en-us/cli/azure/azure-cli-configuration); Node.js note on spawning `.cmd` files on Windows (https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
7. Rewrite the az error mapping messages for Azure:
   - Not installed: link to the Azure CLI install page.
   - Not logged in: `Run \`az login\`` (with `--tenant <id>` when the profile has a tenant).
   - Conditional Access or MFA claims errors (`AADSTS50076`, `AADSTS50079`, `AADSTS53003`, or text containing `claims`): `Run \`az logout\` then \`az login --tenant <id>\` to satisfy Conditional Access`.
8. Add `identityOf(profile)`: runs `az account show --output json` (az mode only) and returns `{ name, type, tenantId }` where `type` is `user` or `servicePrincipal`. Managed identities report as `servicePrincipal` with a name of `systemAssignedIdentity` or `userAssignedIdentity`; display them as `managedIdentity`.
9. Tokens are never logged, never written to disk, never included in output or errors. Add a test that runs every error path and asserts the token string does not appear in the rendered output.

### 5.3 TLS inspection

Corporate networks often re-sign TLS traffic. Node does not use the operating system trust store by default, while `az` (Python) has its own CA handling. In `client.ts`, map the fetch errors `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` to code `TLS_ERROR` with these suggestions:

- `A TLS-inspecting proxy is likely re-signing traffic`
- `Set NODE_EXTRA_CA_CERTS to the path of your organization's root CA (PEM)`
- `Run \`az-axi doctor\` to re-check`

Document this generically in the README "Configure" section. Do not name any specific organization or CA.

### 5.4 Profiles (`config.ts`)

Config file resolution follows upstream: `--config`, then `$AZ_AXI_CONFIG`, then `./az-axi.config.json`, then `~/.az-axi/config.json`.

```json
{
  "defaultProfile": "work",
  "profiles": {
    "work": {
      "auth": "az",
      "tenant": "00000000-0000-0000-0000-000000000001",
      "managementGroup": "contoso-root",
      "subscriptions": [],
      "workspaces": {
        "sentinel": "00000000-0000-0000-0000-000000000010"
      },
      "description": "Daily analyst profile",
      "allowWrites": false
    },
    "sandbox-ops": {
      "auth": "az",
      "tenant": "00000000-0000-0000-0000-000000000001",
      "subscriptions": ["00000000-0000-0000-0000-000000000020"],
      "allowWrites": true,
      "description": "Writes enabled, sandbox subscription only"
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

Fields:

| Field | Required | Meaning |
|---|---|---|
| `auth` | yes | `az` or `token` |
| `tenant` | no | Passed as `--tenant` to az |
| `managementGroup` | no | Default scope for Resource Graph queries |
| `subscriptions` | no | Default subscription IDs. Empty or missing means "all subscriptions visible to the identity" |
| `workspaces` | no | Alias -> Log Analytics workspace ID (the workspace GUID, not the ARM resource ID) |
| `tokenEnv` | for `token` | Resource -> env var name |
| `description` | no | Shown in `config list` |
| `allowWrites` | no | Default `false`. When `true`, writes become possible through the gates in Section 6.13. Only settable by hand-editing the config file |

Resolution order: `--profile`, then `$AZ_AXI_PROFILE`, then `defaultProfile`, then the only profile. With no config at all, fall back to an implicit `{ auth: "az" }` profile named `az` so the tool works immediately after `az login`.

Write enablement rules:

- `allowWrites` defaults to `false` and a missing field means `false`.
- `config init` and any other az-axi command can never set `allowWrites` to `true`. Enabling writes is a deliberate human edit of the config file, documented in the README "Writes" section.
- `$AZ_AXI_READ_ONLY=1` forces read-only for the whole process regardless of profile. Agent sessions should set it unless writes are intended.
- A profile with `allowWrites: true` and no `subscriptions` list is rejected with `VALIDATION_ERROR`. Write-enabled profiles must name the subscriptions they may write to, and writes to any other subscription are blocked.

Selector flags accepted by every command and never reported as unknown: `--profile`, `--tenant`, `--subscription` (comma-separated), `--management-group`, `--config`, `--help`, `--full`, `--fields`, `--limit`. Environment overrides: `$AZ_AXI_SUBSCRIPTION`, `$AZ_AXI_TENANT`. Update `argv.ts` `VALUE_FLAGS` to this selector set.

The example values above are the synthetic identifiers mandated in Section 7.3. Real values live only in the owner's home directory config, which `.gitignore` already covers through `az-axi.config.json`.

---

## 6. Command specifications

Conventions for every command:

- Default output is a list with 3 to 5 fields per row. `--fields a,b,c` overrides. `--full` disables truncation (default cell truncation is 200 characters; long text blocks use upstream's 1,200).
- Every list includes a count line using `countLine` (for example `12 of 340 alerts`).
- Empty results return an explicit sentence using `emptyState`, for example `0 alerts found for 3 subscriptions in the last 24h`, never an empty array alone.
- Every response that could lead somewhere includes `help[]` with 1 to 3 next-step commands that would actually work.
- Resource IDs are shortened by `scope.ts` for display: `/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Compute/virtualMachines/<name>` -> `<sub-name>/<rg>/vm/<name>`. The full ID is shown with `--full` or `--fields id`.
- Times are shown with upstream's `shortDate`.
- Time flags (`--since`, `--timespan`) accept `30m`, `24h`, `7d`, ISO 8601 durations (`P1D`) and ISO dates, parsed by `time.ts`.

API versions below are starting points, checked against the stable folders of `Azure/azure-rest-api-specs` on 2026-10-01. Where a newer stable version exists, it is listed as the candidate. **VERIFY** each one in Phase 0 using Section 14.2: prefer the newest stable version whose response shape matches what the command needs, and record the choice and reason in `src/lib/apiVersions.ts`.

| Endpoint | Starting value | Newer stable in specs | Spec folder (under `specification/`) |
|---|---|---|---|
| Subscriptions list | `2022-12-01` | none | `resources/resource-manager/Microsoft.Resources/subscriptions/stable/` |
| Resource Graph resources | `2022-10-01` (used in Microsoft's quickstart) | `2024-04-01` | `resourcegraph/resource-manager/Microsoft.ResourceGraph/ResourceGraph/stable/` |
| Role assignments (only if ARM fallback is needed) | `2022-04-01` | none | `authorization/resource-manager/Microsoft.Authorization/Authorization/stable/` |
| Activity log | `2015-04-01` | none (only stable version with `activityLogs.json`) | `monitor/resource-manager/Microsoft.Insights/Insights/stable/2015-04-01/` |
| Defender alerts | `2022-01-01` | none | `security/resource-manager/Microsoft.Security/Security/stable/2022-01-01/alerts.json` |
| Defender assessments (ARM fallback) | `2021-06-01` | `2025-05-04` (`security-Assessment.json`) | `security/resource-manager/Microsoft.Security/Security/stable/` |
| Defender secure scores (ARM fallback) | `2020-01-01` | none | `security/resource-manager/Microsoft.Security/Security/stable/2020-01-01/secureScore.json` |
| Management locks | `2020-05-01` | none | search the `resources/resource-manager/` tree for `locks.json` |
| Deployments what-if | latest stable | `2026-06-01` is the newest folder | `resources/resource-manager/Microsoft.Resources/deployments/stable/` |
| Log Analytics query | `v1` (path version) | n/a | data plane; use the REST reference page |
| Graph getByIds | `v1.0` (path version) | n/a | Microsoft Graph reference page |

### 6.1 `az-axi` (dashboard, no arguments)

Shows, with `Promise.allSettled` so one failing section degrades with a hint instead of failing the whole view:

- Profile name, identity name and type, tenant, number of subscriptions in scope, and write status (`writes: disabled (default)`, `writes: disabled (AZ_AXI_READ_ONLY)` or `writes: ENABLED for <n> subscriptions`).
- Configured write subscriptions, whether `AZ_AXI_READ_ONLY` is set and forces read-only, and the resolved write log path.
- Defender for Cloud: active alerts by severity (counts only).
- Secure score: average percentage across subscriptions in scope, and the lowest subscription.
- Exposure: counts for each canned exposure check.
- `help[]`: the three most useful next commands given what was found (for example, if high-severity alerts exist, suggest `az-axi defender alerts --severity High`).

Without a working profile, mirror upstream `home.ts`: show config path, known profiles, the error, and setup hints.

### 6.2 `doctor`

For each configured profile (or the implicit `az` profile):

| Check | How |
|---|---|
| az installed | Spawn `az version` |
| Signed in | `identityOf(profile)` |
| ARM token | `resolveCredential(profile, "arm")` |
| Logs token | `resolveCredential(profile, "logs")` |
| Graph token | `resolveCredential(profile, "graph")`, reported as optional |
| ARM reachable | `GET /subscriptions?api-version=2022-12-01` (**VERIFY**), report count |
| TLS | Any `TLS_ERROR` from the above |
| Writes | Report the effective write status per profile, and warn when a write-enabled profile's identity holds standing (non-PIM) Owner or Contributor at management group scope (best effort, via `rbac list`) |

Output: one row per profile with `name, auth, identity, type, subscriptions, writes, status, writeSubscriptions`, plus a `help[]` aggregated from failures (prefixed with the profile name, as upstream does).
`writeSubscriptions` is the profile's configured write scope as comma-separated IDs, or `(none)`; read-scope overrides cannot change it.
Also report the package name and version (Section 2.4), whether `AZ_AXI_READ_ONLY` is set and forces read-only, and the resolved write log path.

**Reference:** `az account get-access-token` (https://learn.microsoft.com/en-us/cli/azure/account#az-account-get-access-token); `az account show` (same page); upstream pattern in ado-axi `src/commands/doctor.ts`.

### 6.3 `config init | list | path`

Port upstream `commands/config.ts`. `config init` flags: `--name`, `--auth az|token`, `--tenant`, `--management-group`, `--subscription`, `--workspace alias=guid` (repeatable via comma), `--token-env arm=VAR,logs=VAR,graph=VAR`, `--default`. There is deliberately no flag for `allowWrites`. `config list` shows each profile's write status.

### 6.4 `sub list`

`GET /subscriptions?api-version=2022-12-01` (**VERIFY**). Fields: `name, id, state`. Follow `nextLink`. Mark subscriptions that are in the active profile's scope.

**Reference:** Subscriptions - List (https://learn.microsoft.com/en-us/rest/api/resources/subscriptions/list).

### 6.5 `rg query`

Canonical path: `graph query --graph-query <kql>` / `-q <kql>`, retaining `rg query` as the legacy alias.
The canonical path accepts plural subscription/management-group lists, `--first` (alias of `--limit`), and `--skip-token`; `--skip` and partial scopes are rejected.
Profile scope and the default 50-row page remain unchanged; explicit scope families are mutually exclusive on the canonical path.
**Reference:** Azure CLI Graph query flags and all-accessible default scope (https://learn.microsoft.com/en-us/cli/azure/graph#az-graph-query).

```
az-axi rg query "<kql>" [--subscription a,b] [--management-group mg] [--limit 50] [--skip-token <t>]
az-axi rg query --file query.kql
cat query.kql | az-axi rg query
```

- `POST /providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01` (**VERIFY**; candidate `2024-04-01`).
- **Reference:** Quickstart: Run Resource Graph query using REST API (https://learn.microsoft.com/en-us/azure/governance/resource-graph/first-query-rest-api); Resource Graph query language (https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/query-language); Guidance for throttled requests (https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/guidance-for-throttled-requests); paging with skip tokens (https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/work-with-data); spec examples `ResourcesBasicQuery.json` and `ResourcesComplexQuery.json` in the Resource Graph stable folder.
- Body: `{ query, subscriptions?, managementGroups?, options: { $top, $skipToken?, resultFormat: "objectArray" } }`.
- Scope precedence: flags, then profile `managementGroup`, then profile `subscriptions`, then none (the API defaults to all accessible subscriptions).
- `--limit` maps to `$top` (default 50, maximum 1000).
- Output: `total` (from `totalRecords`), `count`, `rows`, and when `$skipToken` is returned, a `help[]` entry with the exact command to fetch the next page.
- Rows pass through `pickFields` and cell truncation. Nested objects are rendered as compact JSON strings truncated at 200 characters unless `--full`.
- The query is sent unchanged. Never rewrite user KQL.
- Map Resource Graph throttling (HTTP 429, and the `x-ms-user-quota-remaining` header reaching 0) to `RATE_LIMITED` with the `x-ms-user-quota-resets-after` value in the hint.
- Multi-line KQL must come from `--file` or stdin. Reuse upstream's piped stdin helper, and copy the safe shell input guidance from ado-axi's SKILL.md.

### 6.6 `rbac list`

```
az-axi rbac list [--principal <upn|objectId>] [--role <name>] [--scope <armId>] [--privileged] [--limit 50]
```

- Source: Resource Graph `authorizationresources`, joining role assignments to role definitions in one query (`RBAC_ASSIGNMENTS` in `src/lib/queries.ts`). This returns assignments across every subscription in scope in a single call.
- `--privileged` filters to Owner, Contributor, User Access Administrator and Role Based Access Control Administrator (match by the public built-in role definition GUIDs, kept in `src/lib/roles.ts`).
- `--principal` accepts an object ID directly. A UPN is resolved to an object ID through Graph (`principals.ts`); if Graph is unavailable, return `VALIDATION_ERROR` asking for the object ID.
- Default fields: `principal, type, role, scope, created`.
- Principal names: collect distinct `principalId` values and resolve them in batches with Graph `POST /v1.0/directoryObjects/getByIds` (**VERIFY**) using the `graph` token. On any Graph failure, show the raw object ID and add one `help[]` note explaining names could not be resolved. This is best effort and must never fail the command.
- Aggregate: `byRole` counts above the rows.
- **Reference:** Resource Graph table reference for `authorizationresources` (https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources); Azure built-in roles, for the privileged role GUIDs (https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles); directoryObject: getByIds (https://learn.microsoft.com/en-us/graph/api/directoryobject-getbyids); cross-check against `az role assignment list --all` (Section 14.4).

### 6.7 `activity list`

```
az-axi activity list [--subscription <id>] [--since 24h] [--caller <upn|appId>] [--resource-group <rg>] [--status Failed] [--operation <text>] [--limit 50]
```

- `GET /subscriptions/{id}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01` (**VERIFY**) with a required `$filter` of `eventTimestamp ge '<start>' and eventTimestamp le '<end>'`, plus `and caller eq '...'` and `and resourceGroupName eq '...'` when given. Use `$select` to request only the fields displayed.
- The API retains 90 days. Reject `--since` older than 90 days with `VALIDATION_ERROR` and suggest `logs query` against the `AzureActivity` table instead.
- If no `--subscription` is given and the profile scope has more than one subscription, query them in parallel (concurrency 4) and merge by time, newest first.
- `--status` and `--operation` filter client-side (the API filter grammar does not support them).
- Default fields: `time, caller, operation, status, resource`.
- Aggregate: top 5 callers by event count.
- Follow `nextLink` until `--limit` rows are collected.
- **Reference:** Activity Logs - List (https://learn.microsoft.com/en-us/rest/api/monitor/activity-logs/list), which documents the required `$filter` grammar and the 90-day limit; spec `activityLogs_API.json` in the Insights `2015-04-01` stable folder.

### 6.8 `defender alerts | assessments | score`

Native write: `security alert update --subscription <id> --location <location> --name <name> --status dismiss|resolve|activate`, with alias `defender alerts update` and optional `--resource-group`.
Exactly one explicit subscription ID is required; names and implicit env/profile scope are not accepted.
It uses the shared write gates, current-status preview, no-op detection, execution log and LRO handling.
The action is a bodyless POST; no ETag/If-Match concurrency guarantee is documented.
**Reference:** [Azure CLI alert update](https://learn.microsoft.com/en-us/cli/azure/security/alert#az-security-alert-update) and [ARM alert activate](https://learn.microsoft.com/en-us/rest/api/defenderforcloud/alerts/update-subscription-level-state-to-activate?view=rest-defenderforcloud-2022-01-01).

**alerts**

```
az-axi defender alerts [--severity High,Medium] [--status Active] [--since 7d] [--limit 50]
```

- `GET /subscriptions/{id}/providers/Microsoft.Security/alerts?api-version=2022-01-01` (**VERIFY**), parallel across subscriptions in scope.
- Default `--status Active`.
- Default fields: `time, severity, alert, resource, status`.
- Aggregate: count by severity.
- `az-axi defender alerts get <alert-resource-id>` returns the detail view: description, remediation steps (truncated unless `--full`), entities summary. Alerts live under a location (`.../providers/Microsoft.Security/locations/{ascLocation}/alerts/{name}`), so accept the full resource ID from the list output rather than a bare name.
- **Reference:** Alerts - List (https://learn.microsoft.com/en-us/rest/api/defenderforcloud/alerts/list); Alerts - Get Subscription Level (https://learn.microsoft.com/en-us/rest/api/defenderforcloud/alerts/get-subscription-level). Note that Microsoft's examples contain real-looking GUIDs: never copy them into test payloads (Section 7.3).

**assessments**

```
az-axi defender assessments [--severity High] [--status Unhealthy] [--limit 25]
```

- Source: Resource Graph `securityresources` where `type == "microsoft.security/assessments"` (`DEFENDER_ASSESSMENTS` in `src/lib/queries.ts`), **grouped by recommendation**, so each row is one recommendation with `severity, unhealthyCount, recommendation`, sorted by severity then count. This pre-computed aggregate is the main value of the command.
- `--resource <name>` switches to per-resource rows for one resource.
- **Reference:** Resource Graph table reference for `securityresources` (https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources); Defender for Cloud Resource Graph samples (search Microsoft Learn for "Azure Resource Graph sample queries for Microsoft Defender for Cloud"); Assessments - List REST page as the ARM fallback (https://learn.microsoft.com/en-us/rest/api/defenderforcloud/assessments/list).

**score**

- Source: Resource Graph `securityresources` where `type == "microsoft.security/securescores"` (**VERIFY** the type name and properties), one row per subscription: `subscription, current, max, percent`. Sort ascending by percent.
- **Reference:** Secure Scores - List (https://learn.microsoft.com/en-us/rest/api/defenderforcloud/secure-scores/list) for property names; verify the Resource Graph type name with `securityresources | distinct type` (Section 14.4).

### 6.9 `exposure`

```
az-axi exposure [--check public-ips|mgmt-ports|any-any|all] [--limit 50]
```

Runs canned Resource Graph queries defined as named constants in `src/lib/queries.ts` (`EXPOSURE_PUBLIC_IPS`, `EXPOSURE_MGMT_PORTS`, `EXPOSURE_ANY_ANY`):

| Check | Finds |
|---|---|
| `public-ips` | Public IP addresses attached to a resource, with the attached resource |
| `mgmt-ports` | NSG inbound Allow rules from `*`, `Internet` or `0.0.0.0/0` covering 22, 3389, 5985 or 5986 |
| `any-any` | NSG inbound Allow rules from any source to any port |

Default `--check all` returns a summary with counts per check and the first 10 rows of each. Default fields: `resource, resourceGroup, subscription, detail`. Keeping queries as TypeScript constants (rather than `.kql` files) means `tsc` ships them in `dist/` with no extra build step, as in ado-axi. `--show-query` on `exposure`, `rbac list` and `defender assessments` prints the exact KQL instead of running it, so an agent or human can inspect or rerun it.

**Reference:** Resource Graph sample queries (https://learn.microsoft.com/en-us/azure/governance/resource-graph/samples/starter); network security group rule properties (search Microsoft Learn for "Network Security Groups - Get REST API"). Validate each query (via `--show-query`) in the portal's Resource Graph Explorer before committing (Section 14.4).

### 6.10 `logs query`

Canonical path: `monitor log-analytics query --analytics-query <kql> --workspace <alias|guid>`, retaining `logs query` as the legacy alias.
File/stdin input, workspace aliases, display limits and TOON output remain unchanged.
`-w` / `-t` select workspace/timespan, and the default timespan remains P1D instead of Azure CLI's all-available default.
**Reference:** Azure CLI Log Analytics query flags and default timespan (https://learn.microsoft.com/en-us/cli/azure/monitor/log-analytics#az-monitor-log-analytics-query).

```
az-axi logs query "<kql>" --workspace <alias|guid> [--timespan P1D] [--limit 50]
az-axi logs query --file hunt.kql --workspace sentinel
```

- `POST https://api.loganalytics.io/v1/workspaces/{workspaceId}/query` with body `{ query, timespan }` and the `logs` token (**VERIFY** the path and body shape).
- `--workspace` resolves through profile `workspaces` aliases, otherwise must be a GUID. If the value looks like an ARM resource ID, return `VALIDATION_ERROR` explaining that the workspace ID (customer ID GUID) is required, with the `rg query` command that finds it.
- `--timespan` default `P1D`.
- `kusto.ts` converts `tables[0].columns` and `rows` into an array of objects. If more than one table is returned, include the others with their row counts only.
- `--limit` caps rows shown client-side (default 50). Report `rows: <shown> of <total>` and, when truncated, a `help[]` hint to add `| summarize` or `| take` to the query.
  Do not add row limits or time filters to the query.
  See `az-axi logs --help` for query input handling.
- Map partial errors (HTTP 200 with an `error` object) to output with a `warning` field rather than failing.
- **Reference:** Query - Execute (https://learn.microsoft.com/en-us/rest/api/loganalytics/dataaccess/query/execute); Log Analytics API overview and limits (search Microsoft Learn for "Azure Monitor Log Analytics API overview").

### 6.11 `api`

```
az-axi api [GET|POST|PUT|PATCH|DELETE] <path> [--resource arm|logs|graph] [--api-version <v>] [--query 'k=v&k2=v2'] [--body '<json>'] [--raw]
az-axi api PATCH <path> --api-version <v> --body '<json>' [--if-match <etag>] [--execute] [--no-wait]
az-axi api DELETE <path> --api-version <v> --execute --confirm <resource-name>
```

- Port upstream `commands/api.ts`. `--resource` selects host and token (default `arm`). Paths are relative to the host root.
- `--api-version` is required for `arm` when the path has no `api-version` query parameter, with a helpful error.
- Every request is classified by `policy.ts` and gated by `gates.ts` (Section 6.13). The command never makes its own allow or deny decision.
- Read and query responses: as upstream, `value` arrays become `count` plus `value`; strings truncate at 4,000 characters unless `--full`. Follow ARM `nextLink` only when `--all` is passed, capped at 10 pages.
- Write and destructive requests follow the dry-run, execute and outcome flow in Section 6.13.
- All output passes through `redact.ts`.
- **Reference:** Azure REST API reference landing page (https://learn.microsoft.com/en-us/rest/api/azure/); upstream pattern in ado-axi `src/commands/api.ts`.

### 6.12 Error codes and exit codes

Keep upstream's `formatError`. Codes:

| Code | Exit | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 2 | Bad flag value, missing argument |
| `UNKNOWN_FLAG` | 2 | Flag not accepted by this command |
| `AUTH_REQUIRED` | 2 | Not signed in, token missing or expired |
| `FORBIDDEN` | 2 | Signed in, but RBAC denies access. Suggest the role required (Reader, Security Reader, Log Analytics Reader) |
| `NOT_FOUND` | 2 | Subscription, workspace or resource not found |
| `READ_ONLY` | 2 | Request class not permitted for this resource (for example any write to Graph or Log Analytics) |
| `WRITES_DISABLED` | 2 | Write blocked because the profile has `allowWrites: false` or `AZ_AXI_READ_ONLY=1` is set |
| `SUBSCRIPTION_NOT_WRITABLE` | 2 | Write targets a subscription outside the write-enabled profile's `subscriptions` |
| `CONFIRM_REQUIRED` | 2 | Destructive request without `--confirm <resource-name>` |
| `CONFIRM_MISMATCH` | 2 | `--confirm` value does not match the target resource name |
| `PRECONDITION_FAILED` | 1 | HTTP 412: the resource changed since the dry run (ETag mismatch) |
| `CONFLICT` | 1 | HTTP 409 from ARM |
| `OPERATION_FAILED` | 1 | A long-running operation finished as Failed or Canceled |
| `OPERATION_TIMEOUT` | 1 | Polling exceeded `--timeout`; includes the `op status` command to resume |
| `TLS_ERROR` | 1 | Certificate trust failure (Section 5.3) |
| `RATE_LIMITED` | 1 | HTTP 429, include Retry-After |
| `NETWORK_ERROR` | 1 | fetch failed |
| `API_ERROR` | 1 | Anything else, with HTTP status and ARM `error.code` |

ARM error bodies are `{ "error": { "code", "message" } }`. Reference: Resource Manager throttling and request limits (https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/request-limits-and-throttling); Azure REST API guidelines on errors and headers (https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md). Use `error.code` (for example `AuthorizationFailed`, `SubscriptionNotFound`, `InvalidQuery`) to choose the AXI code and hint. Retry once automatically on 429 or 503 when `Retry-After` is 10 seconds or less; otherwise return `RATE_LIMITED`.

Unknown flag rename hints (`args.ts` `RENAMED`): `sub` -> `subscription`, `subscriptions` -> `subscription`, `mg` -> `management-group`, `top` -> `limit`, `count` -> `limit`, `max` -> `limit`, `ws` -> `workspace`.

### 6.13 Write framework (disabled by default)

The framework is built and tested in v1, but every layer defaults to read-only. In v1 its only entry point is `api`; curated write commands added later reuse it unchanged.

#### 6.13.1 Request classification (`policy.ts`)

Every request, from every command, is classified before it is sent:

| Class | Rule | Allowed when |
|---|---|---|
| `read` | GET or HEAD | Always |
| `query` | POST to exactly these paths: Resource Graph `/providers/Microsoft.ResourceGraph/resources` (arm); deployment `.../providers/Microsoft.Resources/deployments/{name}/whatIf` at resource group and subscription scope (arm, used by dry runs, **VERIFY** paths); `/v1/workspaces/{id}/query` (logs); `/v1.0/directoryObjects/getByIds` (graph) | Always |
| `secret` | Credential-returning POST actions recognized by the authoritative lists and path rules in [policy.ts](src/lib/policy.ts) | **Never** in v1, in any mode (`READ_ONLY`) |
| `destructive` | DELETE; POST actions and protected Microsoft.Authorization types recognized by [policy.ts](src/lib/policy.ts) | Gates pass, plus `--confirm` |
| `write` | Any other PUT, PATCH or POST on arm | Gates pass |

Any non-read, non-query request to `graph` or `logs` is `READ_ONLY`: az-axi writes only to ARM. Anything the rules do not recognize falls through to `write`, never to `read`. Security-sensitive resource types are always `destructive`, even when creating, so a new role assignment needs the stronger gate.

#### 6.13.2 Gate order (`gates.ts`)

Applied to `write` and `destructive` requests, in this order, stopping at the first failure:

1. `$AZ_AXI_READ_ONLY=1` -> `WRITES_DISABLED`.
2. Profile `allowWrites` is not `true` -> `WRITES_DISABLED`.
3. The subscription parsed from the path is not in the profile's `subscriptions` -> `SUBSCRIPTION_NOT_WRITABLE`. Paths with no subscription segment (management group or tenant scope) are always blocked in v1.
4. No `--execute` -> dry run (Section 6.13.3), exit 0.
5. `destructive` without `--confirm` -> `CONFIRM_REQUIRED`; a value that is not the target resource's name -> `CONFIRM_MISMATCH`.
   The name is the percent-decoded final name segment, or the preceding segment for a destructive POST action such as `.../vm1/restart`.
6. Execute (Section 6.13.4).

Hints for gates 1 to 3 must not tell an agent how to enable writes. They say writes are disabled for this profile and point the human to `README.md#writes`.

#### 6.13.3 Dry run (`dryRun.ts`, `diff.ts`)

Without `--execute`, nothing is sent except reads and deployment what-if queries needed for the preview.
Output:

- `dryRun: true`, `class`, `method`, shortened `target`, `subscription`, the request body (redacted, truncated unless `--full`).
- PUT or PATCH on an existing resource: see [README.md#writes](README.md#writes) for the current diff contract, including tag replacement and no-op behavior.
- PUT on a resource that does not exist: `creates: true` with the body summary.
- DELETE: current resource summary (name, type, location, tag count) and a warning if a resource lock exists on it or its resource group (GET `.../providers/Microsoft.Authorization/locks`). Reference: Lock your resources (https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/lock-resources).
- Deployment PUT: call `whatIf` and summarize completed results as `whatIf` counts keyed by lower-cased change type.
  Failed or Canceled status, or an error object, returns `OPERATION_FAILED`.
  HTTP 202 or another nonterminal status returns `pending: true`, `operationUrl` from the Location header, and a shell-quoted `az-axi op status <operation-url>` command with the original selectors in `help[]`; no execute command or counts are emitted and no polling occurs.
  A pending result without Location or a completed result without `properties.changes[]` returns `API_ERROR`.
  Reference: Deployments - What If (https://learn.microsoft.com/en-us/rest/api/resources/deployments/what-if).
- `etag` of the current state when present, preferring the response header over the top-level string body field.
- `help[]`: except for pending deployment results, a shell-quoted command including `--execute`, `--if-match <etag>` when an ETag exists, and `--confirm <name>` for every destructive class.
  Bodies containing secrets use a `<json-body>` placeholder that must be replaced with the original body before use; secrets are also redacted in displayed diff values.

#### 6.13.4 Execute

- With `--if-match <etag>`, send `If-Match`. HTTP 412 -> `PRECONDITION_FAILED` with a hint to re-run the dry run. Without it, send the ETag from a fresh GET (protects only against races within the call) and note in the output that review-to-execute protection was not used.
- No-op: re-check the diff immediately before sending; if nothing would change, return `result: already in desired state (no-op)`, exit 0, and send nothing. DELETE of a resource that is already gone is also a no-op.
- 200 or 201 without async headers -> done. 201 or 202 with `Azure-AsyncOperation` or `Location` -> Section 6.13.5.
- Output: `result`, `status`, `target`, `requestId`, `correlationId`, `durationSec`, and a `help[]` entry with the GET command to verify the new state.
- Every executed write, successful or not, is appended to the write log (Section 6.13.7).

#### 6.13.5 Long-running operations (`lro.ts`)

- Prefer `Azure-AsyncOperation`: poll until `status` is `Succeeded`, `Failed` or `Canceled`. Otherwise poll `Location` until it stops returning 202.
- Honour `Retry-After` (default 10 seconds). `--timeout` defaults to 600 seconds. On timeout, return `OPERATION_TIMEOUT` with the `op status` command to resume.
- `--no-wait` returns immediately with the operation URL and the `op status` command.
- `Failed` or `Canceled` -> `OPERATION_FAILED` with the operation's error code and message.
- `az-axi op status <operation-url>`: a read-only GET of the operation URL. Validate that the URL host is `management.azure.com`; reject anything else with `VALIDATION_ERROR`.
- **Reference:** Track asynchronous Azure operations (https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/async-operations).

#### 6.13.6 Request correlation (`client.ts`, every request)

- Send `x-ms-client-request-id` with a fresh UUID and `User-Agent: az-axi/<version>` on every request, reads included.
- Capture `x-ms-request-id` and `x-ms-correlation-request-id` from responses. Reference: Azure REST API guidelines, request and correlation headers (https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md). Include `requestId` in every error and every write result, so any action can be traced in the Azure activity log.
- Internally `client.ts` returns `{ status, headers, body }`; helpers unwrap the body for read commands. This is what makes the long-running operation and ETag handling possible without a client rewrite.

#### 6.13.7 Write log (`writeLog.ts`)

- Append-only JSON Lines at `~/.az-axi/writes.log` (override with `$AZ_AXI_WRITE_LOG`).
- Fields: `time`, `profile`, `identity`, `class`, `method`, `url`, `requestId`, `correlationId`, `httpStatus`, `outcome`. Never request or response bodies, never headers.
- Written for executed writes only, not dry runs. Create the file with user-only permissions where the OS supports it. Never committed (it lives outside the repo).

#### 6.13.8 Redaction (`redact.ts`, all output)

Applied to every command's output before rendering, reads included:

- Key-name rule (case-insensitive): `password`, `secret`, `token`, `connectionString`, `sas`, `*key` and `*keys` when the value is a string (for example `primaryKey`, `primaryMasterKey`, `accountKey`), `credential`, `clientSecret`.
- Value rule: strings containing `AccountKey=`, `SharedAccessKey=`, `SharedAccessSignature`, a `sig=` query parameter, `-----BEGIN`, or a JWT shape (three base64url segments starting `eyJ`).
- Array rule: objects with `keyName` plus `value`, or `name` plus `value` inside a `passwords` or `keys` array, have `value` redacted.
- Replacement text: `***redacted***`. There is no `--reveal` flag in v1.
- Tests use synthetic versions of these shapes: storage account keys list, Cosmos DB keys, ACR credentials, connection strings, SAS URLs.

#### 6.13.9 Command effect metadata (`registry.ts`)

- Each command module exports `meta: { name, effect }` where `effect` is `read`, `write`, `destructive` or `dynamic`. All curated v1 commands are `read`; `api` is `dynamic` (classified per request).
- The core enforces it: a command declared `read` that issues anything other than a `read` or `query` request throws `READ_ONLY`. This guards against bugs, not just agents.
- `test/policy.test.ts` snapshots the registry and the policy rules. Any change to either is a reviewable diff routed to the owner by CODEOWNERS.

#### 6.13.10 Agent guard hook (`scripts/claude-guard.mjs`, README "Agent integration")

The flags above are supplied by the agent, so they are not an approval control. The control is the agent harness:

- `scripts/claude-guard.mjs` is a Claude Code PreToolUse hook for the Bash tool. When a command invokes `az-axi` and contains `--execute`, it returns a permission decision of `ask` with the full command as the reason, so a human approves each write. **VERIFY** the hook input and output schema against current Claude Code documentation: Hooks reference (https://code.claude.com/docs/en/hooks), Hooks guide (https://code.claude.com/docs/en/hooks-guide), Permissions (https://code.claude.com/docs/en/permissions). At the time of writing, a PreToolUse hook reads JSON from stdin (with `tool_input.command` for Bash) and can print `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"..."}}`.
- The README "Agent integration" section explains installing it, recommends setting `AZ_AXI_READ_ONLY=1` in agent sessions that should never write, and recommends PIM-eligible (not standing) write roles.

---

## 7. Invariants

These are non-negotiable. The agent must not weaken them; if one blocks progress, stop and ask the owner.

### 7.1 Read-only by default, writes only through the gates

- `src/lib/policy.ts` is the only place requests are classified, and `src/lib/gates.ts` is the only place write decisions are made. `client.ts` calls both before every request. No command may send a request any other way.
- Defaults are read-only at every layer: `allowWrites` is `false` unless hand-edited, `AZ_AXI_READ_ONLY=1` overrides every profile, and `--execute` is required for every write.
- No az-axi command can enable writes, and no error hint may tell an agent how to.
- `secret` class requests are blocked in all modes. Writes to `graph` and `logs` are blocked in all modes.
- The gate order is defined in Section 6.13.2; current build availability is documented in [README.md#writes](README.md#writes).
- `test/policy.test.ts` snapshots the policy rules and every command's declared effect. Changing either requires updating the snapshot, which CODEOWNERS routes to the owner.

### 7.2 No secrets or tokens in output, logs or repo

- Tokens exist only in memory. No debug flag prints them.
- All output passes through `redact.ts` (Section 6.13.8), and the write log never contains bodies or headers.
- Enable GitHub secret scanning and push protection on the repository.

### 7.3 No real identifiers in the repository

This repository is public. It must never contain the owner's tenant, subscription, workspace, object or application IDs, organization domain names, or internal hostnames.

- All GUIDs in test payloads, tests, README, `skills/az-axi/SKILL.md` and examples use the synthetic pattern `00000000-0000-0000-0000-0000000000NN`.
- Domains in test payloads and documentation use `contoso.com`, `fabrikam.com` or `example.com` only.
- Public, Microsoft-wide GUIDs that are required for function (built-in role definition IDs in `src/lib/roles.ts`) are allowed by importing them from `roles.ts`; any other required public GUID goes in a short, commented `PUBLIC_GUIDS` array at the top of `test/identifiers.test.ts`.
- `test/identifiers.test.ts` scans every tracked text file and fails on any GUID that is neither synthetic nor allowed above, and on any email address or hostname outside the allowed domains.
- Test payloads are hand-written or derived from Microsoft's published specification examples (Section 14.3), with every identifier replaced. Never commit a recording of a real response from any tenant, even scrubbed; benchmark captures stay in gitignored folders (Section 13.4).
- `scripts/live-smoke.mjs` writes its output to the OS temp directory only and prints pass or fail per check, never response bodies.

### 7.4 AXI output rules

- Handlers return objects; `runAxiCli` renders TOON. No `console.log` in commands.
- Every list has a count, an explicit empty state, and default fields of 5 or fewer.
- Every error has a code and at least one actionable `help[]` entry.
- Unknown flags are rejected by name with valid alternatives.

### 7.5 Vendored code hygiene

- Phase 0 commits the vendored upstream files unmodified first, so later diffs show exactly what changed.
- `UPSTREAM.md` lists each vendored file, the upstream commit, and a one-line summary of local changes. Update it in the same commit as any change to a vendored file.
- `NOTICE.md` reproduces the upstream MIT copyright notice (`Copyright (c) 2025 Jeffrey Haen`) for the vendored portions.

---

## 8. Testing strategy

| Layer | What | Where |
|---|---|---|
| Unit | `time.ts`, `scope.ts`, `kusto.ts`, `args.ts`, `config.ts` resolution (including `allowWrites` rules), `policy.ts` classification table, `redact.ts` | `test/*.test.ts` |
| Auth | az spawn mocked: success, not installed, not logged in, CA claims error, expiry; token mode present and missing; token never in output | `test/auth.test.ts` |
| Client | `fetch` stubbed (upstream pattern): every status code mapping, ARM error codes, TLS errors, retry on 429, `nextLink` paging, policy enforcement, request ID header on every call, headers returned internally | `test/client.test.ts` |
| Write framework | Gate order (env beats profile, profile beats flags), subscription restriction, dry-run output and diff, PUT removal listing, no-op detection, `--if-match` and 412, destructive `--confirm`, long-running operations with fake timers (async header, location header, failure, timeout, `--no-wait`), `op status` host validation, write log contents (no bodies), hints never reveal how to enable writes | `test/gates.test.ts`, `dryRun.test.ts`, `diff.test.ts`, `lro.test.ts`, `writeLog.test.ts`, `apiWrites.test.ts` |
| Commands | Each command with `vi.mock("../src/lib/client.js")` and inline or `test/samples.ts` payloads: default fields, `--fields`, `--full`, empty state, aggregates, `help[]` hints | `test/<command><Aspect>.test.ts`, for example `rgQuery.test.ts`, `defenderAlerts.test.ts` |
| Guards | Identifiers, policy and effect snapshot | `test/identifiers.test.ts`, `test/policy.test.ts` |
| Token budgets | Rendered TOON for each `test/samples.ts` payload stays under a ceiling (measured with `gpt-tokenizer`) | `test/budget.test.ts` |
| Benchmark harness | Scrubber and token counter contracts: [README benchmark utilities](README.md#benchmark-utilities) | `test/benchmark.test.ts` |
| CLI smoke (CI) | `--version`, `--help`, unknown command exits 2, unknown flag exits 2 | `.github/workflows/ci.yml` |
| Live smoke (local only) | Real read-only calls with the owner's `az login`; in Phase 6, a write round trip against a sandbox resource group | `scripts/live-smoke.mjs` |

CI runs on Ubuntu 24.04 with Node 22 and 24, and on Windows Server 2025 with Node 22. Windows matters because of the az `.cmd` shim. CI steps match ado-axi's `ci.yml`: install with `--frozen-lockfile`, build, test, then the CLI smoke checks.

---

## 9. Phases

Each phase ends with a gate. The agent stops, reports, and waits for owner approval.

### Phase 0: Bootstrap and verification

Tasks:

1. Create the repository skeleton from Section 4.1. Copy `tsconfig.json`, `.nvmrc`, `pnpm-workspace.yaml`, `.gitignore` (adapted per Section 4.2), `ci.yml`, `release.yml`, `scripts/release-notes.mjs` and `test/release-notes.test.ts` from upstream.
2. Write `package.json` per Section 4.2: name per the owner's npm scope, `bin` `az-axi` -> `dist/bin/az-axi.js`, `type: module`, `engines.node >= 20`, the scripts in Section 4.2 matching upstream.
3. Copy the vendored `src/lib` files listed in Section 2.2 unmodified. Commit as `chore: vendor ado-axi helpers at 1a381cb`.
4. Write `LICENSE`, `NOTICE.md`, `UPSTREAM.md`, and an initial `CHANGELOG.md` with an `Unreleased` section.
5. Write a minimal `src/bin/az-axi.ts` and `src/help.ts` with only `--help`, `--version` and a placeholder home handler.
6. Add `test/identifiers.test.ts` now, so the guard is active from the first commit. Seed its `PUBLIC_GUIDS` array with the Azure DevOps resource ID `499b84ac-1321-427f-aa17-267ca6975798` that appears in the unmodified vendored `auth.ts` (it is a public Microsoft constant and is removed in Phase 1).
7. Verify every **VERIFY** item in Section 6 using the procedure in Section 14.2 and write `src/lib/apiVersions.ts`: one exported constant per endpoint, each with a doc comment giving the newer stable version available (if any), spec path, documentation URL, date verified and reason for the choice.
8. Add `.github/CODEOWNERS` (Section 10) and `.github/dependabot.yml` (npm and GitHub Actions, weekly).

Acceptance criteria:

- `pnpm install --frozen-lockfile`, `pnpm run build` and `pnpm test` pass.
- `node dist/bin/az-axi.js --help` prints help; an unknown command exits 2.
- The identifier guard passes and fails correctly when a real-looking GUID is added to a test file (demonstrate, then revert).
- `src/lib/apiVersions.ts` covers every endpoint in Section 6 with a verified version.

Gate: owner reviews `src/lib/apiVersions.ts` and the vendored commit.

### Phase 1: Authentication, profiles, client, doctor

Tasks:

1. Generalize `auth.ts` per Section 5.2.
2. Adapt `config.ts` per Section 5.4, including the implicit `az` profile.
3. Rewrite `client.ts`: hosts for `arm`, `logs`, `graph`; `api-version` handling for `arm`; ARM error translation (Section 6.12); TLS mapping (Section 5.3); single retry on 429 or 503; `nextLink` helper; internal `{ status, headers, body }` responses; request correlation headers (Section 6.13.6).
4. Implement the write framework hooks now, so later phases are additive: `policy.ts` (full classification table, Section 6.13.1), `gates.ts` as a stub that blocks every write with `WRITES_DISABLED` (Section 7.1), `registry.ts` with effect metadata (Section 6.13.9), `redact.ts` (Section 6.13.8), and `allowWrites` and `AZ_AXI_READ_ONLY` parsing in `config.ts`. Add `test/policy.test.ts`.
5. Update `args.ts` global flags and rename hints, and `argv.ts` selector flags.
6. Implement `doctor` (including write status), `config init|list|path`, `sub list`.
7. Write the README "Configure" section covering: user `az login`, `az login --tenant`, service principal with certificate, managed identity, federated token, and `token` mode with the mint command. Generic examples only.
8. Write `scripts/live-smoke.mjs` with the Phase 1 checks.

Acceptance criteria:

- Tests cover every auth and client error path listed in Section 8.
- The token never appears in any rendered output (test).
- `policy.ts` classifies every row of the Section 6.13.1 table correctly, and every `write`, `destructive` and `secret` request is blocked (tests).
- Every request carries `x-ms-client-request-id`, and `requestId` appears in errors (test).
- `config init` cannot set `allowWrites` (test).

Gate, owner runs locally:

```
az-axi doctor
az-axi sub list
az-axi config init --name work --auth az --tenant <your tenant>
az-axi doctor
node scripts/live-smoke.mjs
```

Optionally also with `az login --service-principal` to confirm identity type reporting.

### Phase 2: Resource Graph, escape hatch, dashboard skeleton

Tasks:

1. Implement `rg query` per Section 6.5, including `--file`, stdin and skip-token paging hints.
2. Implement `scope.ts` ID shortening (with a subscription name lookup cached per process).
3. Implement `api` per Section 6.11 for read and query requests. Write and destructive requests reach the Phase 1 gate stub and return `WRITES_DISABLED`; the full write flow arrives in Phase 6.
4. Implement the dashboard with the profile and identity section only; other sections are added in later phases.

Acceptance criteria:

- `test/rgQuery.test.ts` covers paging, empty state, nested object truncation, `--fields`, `--full`, throttling.
- `api` refuses a DELETE with `WRITES_DISABLED` (the Phase 1 gate stub), and a `listKeys` POST with `READ_ONLY`.

Gate, owner runs locally:

```
az-axi
az-axi rg query "Resources | summarize count() by type | top 10 by count_"
az-axi api /subscriptions --api-version 2022-12-01
```

### Phase 3: RBAC and activity log

Tasks:

1. Add `RBAC_ASSIGNMENTS` to `src/lib/queries.ts` and write `src/lib/roles.ts` (built-in privileged role GUIDs, which the identifier guard allows by importing `roles.ts`).
2. Implement `principals.ts` (Graph `getByIds`, batching, best-effort fallback).
3. Implement `rbac list` per Section 6.6.
4. Implement `time.ts` and `activity list` per Section 6.7.

Acceptance criteria:

- `rbac list` still succeeds with IDs when Graph is stubbed to return 403 (test).
- `activity list --since 120d` returns `VALIDATION_ERROR` suggesting `logs query` (test).
- Multi-subscription merge sorts newest first (test).

Gate, owner runs locally:

```
az-axi rbac list --privileged
az-axi rbac list --principal <your UPN>
az-axi activity list --since 24h --status Failed
```

### Phase 4: Defender for Cloud and exposure

Tasks:

1. Implement `defender alerts` (list and `get`), `defender assessments` (grouped), `defender score` per Section 6.8.
2. Add the three exposure queries to `src/lib/queries.ts`, implement `--show-query`, and implement `exposure` per Section 6.9.
3. Add the Defender and exposure sections to the dashboard.

Acceptance criteria:

- Assessments output is one row per recommendation with counts (test).
- `exposure --check all` returns per-check counts plus the first 10 rows each (test).
- Dashboard degrades a section with a hint when its call fails (test).

Gate, owner runs locally:

```
az-axi
az-axi defender alerts --severity High
az-axi defender assessments --severity High
az-axi defender score
az-axi exposure
```

The owner compares a sample of results against the Defender for Cloud portal.

### Phase 5: Log Analytics

Tasks:

1. Implement `kusto.ts` and `logs query` per Section 6.10.
2. Add workspace alias support to `config init`.

Acceptance criteria:

- Multi-table responses, partial errors, ARM-ID-instead-of-GUID detection, and client-side row capping are tested.

Gate, owner runs locally:

```
az-axi logs query "SigninLogs | summarize count() by ResultType | top 5 by count_" --workspace <alias>
az-axi logs query --file <a local hunting query> --workspace <alias> --timespan P7D
```

### Phase 6: Write framework (disabled by default)

Tasks:

1. Replace the `gates.ts` stub with the full gate order (Section 6.13.2).
2. Implement `dryRun.ts` and `diff.ts` (Section 6.13.3), including lock detection for DELETE and `whatIf` summaries for deployments.
3. Implement execute handling (Section 6.13.4): `--if-match`, fresh-ETag fallback, no-op detection, outcome mapping.
4. Implement `lro.ts` and the `op status` command (Section 6.13.5).
5. Implement `writeLog.ts` (Section 6.13.7).
6. Extend `api` to the full write flow (Section 6.11).
7. Write `scripts/claude-guard.mjs` and the README "Agent integration" and "Writes" sections (Section 4.3 and 6.13.10). The "Writes" section covers enabling writes by hand-editing a profile, the subscription restriction, every gate, the write log location, and recommended RBAC (PIM-eligible write roles scoped to the write-enabled subscriptions only).
8. Add the write status to the dashboard and `doctor`, and add write round-trip checks to `scripts/live-smoke.mjs` that run only when `--writes --subscription <id> --resource-group <rg>` is passed explicitly.

See [README.md#writes](README.md#writes) for the implemented owner-only smoke prerequisites, destructive opt-in and conditional ETag checks.

Acceptance criteria:

- Every row of the write framework test layer in Section 8 is covered.
- With a default profile, every write and destructive request returns `WRITES_DISABLED` and nothing is sent (test asserts `fetch` was never called with a non-GET method).
- `AZ_AXI_READ_ONLY=1` blocks writes on a write-enabled profile (test).
- No error hint, help text or skill line explains how to set `allowWrites` (test greps rendered hints and `skills/az-axi/SKILL.md`).

Gate, owner runs locally against a disposable sandbox resource group, with a hand-edited write-enabled profile limited to the sandbox subscription:

```
az-axi doctor
az-axi api PATCH /subscriptions/<sub>/resourceGroups/<sandbox-rg> --api-version <v> --body '{"tags":{"axi-test":"1"}}'
az-axi api PATCH ... --execute --if-match <etag from dry run>
az-axi api PATCH ... --execute                 # expect no-op
az-axi api DELETE /subscriptions/<sub>/resourceGroups/<sandbox-rg>/providers/Microsoft.Storage/storageAccounts/<throwaway-account> --api-version <v>   # create the account first
az-axi api DELETE ... --execute --confirm <throwaway-account>
AZ_AXI_READ_ONLY=1 az-axi api PATCH ... --execute   # expect WRITES_DISABLED
```

The owner also confirms the guard hook prompts for approval when an agent runs a command with `--execute`, and checks that `~/.az-axi/writes.log` and the Azure activity log both show the request IDs.

### Phase 7: Hardening, documentation, first release

Tasks:

1. Write `skills/az-axi/SKILL.md`: frontmatter under 100 tokens (name, description with trigger words such as Azure, subscription, Resource Graph, RBAC, role assignment, activity log, Defender for Cloud, secure score, NSG, public IP, Log Analytics, KQL), then orientation, profiles, every command with one example, the safe shell input section adapted from ado-axi, and a "writes" section stating that writes are disabled by default, always need `--execute`, show a dry run first, and must be approved by the human.
   It must not explain how to enable writes; it points to `README.md#writes` for the human.
2. Complete `README.md` with every section in Section 4.3, in that order.
3. Add `test/budget.test.ts` with a token ceiling per `test/samples.ts` payload (set each ceiling at measured size plus 20 percent).
4. Review every `help[]` hint for accuracy against the final command surface.
5. Configure npm trusted publishing (OIDC) for the release workflow, matching upstream's `id-token: write` permission, and publish as `@<npm-scope>/az-axi` (Section 2.4).
6. Add the maintenance assets from Section 13: the four repo-local skills under `.claude/skills/`, the benchmark harness (`benchmark/`, `scripts/benchmark/`, `test/benchmark.test.ts`), `scripts/check-links.mjs`, `scripts/upstream-diff.mjs`, `usageLog.ts`, and the README "Maintaining" section. The owner runs `pnpm bench:capture` and `pnpm bench`, and `BENCHMARK.md` plus the README "Why AXI" table are filled from the results.
7. Add the naming notice from Section 2.4 to README.md and `skills/az-axi/SKILL.md`. The skill tells agents to call the globally installed, pinned `az-axi` binary, never unpinned `npx -y`.
8. Run the full Verification guide (Section 14) and attach the results to the release PR.
9. Move `Unreleased` to `0.1.0`, bump version, tag `v0.1.0`.

Acceptance criteria:

- All tests pass on the CI matrix.
- `skills/az-axi/SKILL.md` frontmatter measured under 100 tokens.
- A fresh `npm install -g @<npm-scope>/az-axi@0.1.0` followed by `az-axi --help` works after release.
- `npm pack --dry-run` lists only `dist/`, `skills/az-axi/SKILL.md`, `README.md`, `LICENSE`, `NOTICE.md`, `assets/` and `package.json` (Section 14.6).
- `npx skills add <owner>/az-axi --skill az-axi` run against the pushed repository installs the skill from `skills/az-axi/` (Section 4.5).
- `node scripts/check-links.mjs` reports no dead links, or each dead link is replaced (Section 14.7).

Gate: owner installs from npm on the work machine, runs `scripts/live-smoke.mjs` against the published build, and uses the tool through an agent for one real investigation before declaring v0.1.0 done.

---

## 10. Operational design

### 10.1 Roles

| Role | Who | Responsibility |
|---|---|---|
| Owner, approver | knowttl | Approves each phase gate, runs live smoke tests, reviews and merges every PR, owns releases |
| Implementer | Coding agent | Implements one phase at a time on a branch, opens a PR per phase (or per task for large phases), writes the gate report |

### 10.2 Repository protection

- Branch protection on `main`: PR required, 1 approving review (the owner), CI must pass, no force pushes.
- `CODEOWNERS` routes these paths to the owner (replace `@<owner>` with the owner's GitHub handle) and requires their review:

```
/src/lib/auth.ts           @<owner>
/src/lib/policy.ts         @<owner>
/src/lib/gates.ts          @<owner>
/src/lib/redact.ts         @<owner>
/src/lib/registry.ts       @<owner>
/scripts/claude-guard.mjs  @<owner>
/src/lib/client.ts         @<owner>
/test/identifiers.test.ts  @<owner>
/test/policy.test.ts       @<owner>
/.github/                  @<owner>
/package.json              @<owner>
```

- Secret scanning and push protection enabled.
- Dependabot weekly for npm and GitHub Actions. Patch updates may be merged when CI passes; minor and major updates get owner review.

### 10.3 Monitoring and audit

- az-axi's calls appear in Azure as normal requests under the signed-in identity, each with an `x-ms-client-request-id` (Section 6.13.6).
- Executed writes are recorded locally in `~/.az-axi/writes.log` (Section 6.13.7).
- No telemetry is sent anywhere by az-axi.
- Optional usage insight comes from the opt-in usage log (Section 13.5), never enabled by default.

### 10.4 Working agreements for the implementing agent

**Commands**

```
pnpm install
pnpm run build       # tsc -> dist/, also the type check
pnpm test            # vitest, offline only
pnpm dev -- <args>   # run from source with tsx, e.g. pnpm dev -- rg query "Resources | take 1"
pnpm bench           # replay benchmark captures (Section 13.4); captures are owner-made
```

**Rules**

- Never run `scripts/live-smoke.mjs`, never add live tests to CI, and never execute a write against a real environment. Live checks belong to the owner.
- When this plan is silent, follow the existing ado-axi pattern in the vendored code.
- Never reference, import or copy code from `masyanru/az-axi` (Section 2.4 and 2.5).
- Every request goes through `client.ts`; never call `fetch` directly. Spawn `az` only through `runAz` in `auth.ts`.
- When you change a vendored file, update its row in `UPSTREAM.md` in the same commit. Keep `NOTICE.md` intact.
- Ask before adding any runtime dependency beyond the three in Section 4.4.

**Adding or changing a command**

1. Add or update the help text in `src/help.ts` first.
2. Declare the command's known flags and call `assertKnownFlags`, and declare its `effect` in `meta` (Section 6.13.9).
3. Use `client.ts` for every request.
4. Return default fields of 5 or fewer, a count line, an explicit empty state, and `help[]` hints that are exact, runnable commands.
5. Add a test file named `test/<command><Aspect>.test.ts` that mocks the client module and uses synthetic payloads derived from spec examples (Section 14.3), covering: default output, `--fields`, `--full`, empty state, aggregates, and each error path.
6. Add the payload to `test/samples.ts` and its ceiling to `test/budget.test.ts`; update the ceiling if the output shape changes, and justify any increase in the PR description.
7. Add a **Reference** line for the command in Section 6, a row in Section 15 if it uses a new API, and a cross-check row in Section 14.4.
8. Add a scenario to `benchmark/scenarios.mjs`, and update `skills/az-axi/SKILL.md`, the README "Use" section and the `Unreleased` section of `CHANGELOG.md`.

**Commits and pull requests**

- Conventional commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`. Releases use `chore: release vX.Y.Z`.
- One PR per phase, or per task within a large phase. The description lists what changed, tests added, anything deferred, and the Section 14.1 results.
- Call out any change to a CODEOWNERS path (Section 10.2) explicitly in the PR description.
- Never merge your own PR, and never push tags.

**Platform notes**

- Keep path handling and process spawning Windows-safe; CI runs Windows as well as Ubuntu.
- Behind TLS-inspecting proxies Node needs `NODE_EXTRA_CA_CERTS` (Section 5.3). Document this generically and never name a specific organization or CA.

---

## 11. Best practices

| # | Practice | Rationale |
|---|---|---|
| 1 | Prefer Resource Graph over per-subscription ARM calls wherever the data exists there | One call across every subscription, server-side aggregation, far fewer tokens |
| 2 | Keep canned queries as named constants in one module, printable with `--show-query` | Reviewable, testable, shipped by `tsc` with no extra build step, and inspectable by the agent and the owner |
| 3 | Pre-compute aggregates (by severity, by role, by recommendation) above the rows | The agent answers most questions without a second call |
| 4 | Never rewrite user KQL | Predictable behavior; the agent stays in control of its query |
| 5 | Pin every ARM `api-version` in `src/lib/apiVersions.ts` with its verification notes | ARM versions stay supported for years, so pinning removes most churn |
| 6 | Classify and gate every request in one place, with a snapshot test | A single, owner-reviewed choke point instead of per-command discipline |
| 7 | Keep committed test payloads synthetic from day one, and keep benchmark captures local | Scrubbing recordings can fail; synthetic data cannot leak, and gitignored captures never leave the machine |
| 8 | Degrade, do not fail, on optional enrichment (principal names, dashboard sections) | Partial answers with a hint are more useful to an agent than an error |
| 9 | Commit vendored code unmodified before changing it | Clean diffs against upstream and easy future syncs |
| 10 | Keep runtime dependencies to the three upstream ones | Smaller attack surface and less maintenance on a public package |
| 11 | Test on Windows in CI | The az `.cmd` shim and path handling break silently otherwise |
| 12 | Write `help[]` hints as exact, runnable commands | Agents follow hints literally |
| 13 | Default to read-only at every layer, and make enabling writes a manual human edit | An agent cannot talk itself into write access through the tool |
| 14 | Dry run by default, with a diff and the exact execute command | The human reviews what will change, not just what was requested |
| 15 | Require the resource name for destructive actions | Typing the name back catches wrong-target mistakes that a bare flag does not |
| 16 | Put approval in the harness, not in flags | The agent supplies every flag; only the harness can make a human approve |
| 17 | Send a client request ID on every call and log writes locally | Any agent action can be traced end to end in the Azure activity log |

---

## 12. Phase gates

| Phase | Activity | Success criteria (gate) |
|---|---|---|
| 0 | Bootstrap, vendor upstream, verify API versions | Builds and tests pass; identifier guard active; `src/lib/apiVersions.ts` approved |
| 1 | Auth, profiles, client, doctor, sub list | `doctor` and `sub list` work against the owner's tenant; all auth error paths tested |
| 2 | Resource Graph, api, dashboard skeleton | Live `rg query` and `api` succeed; `api` blocks writes |
| 3 | RBAC, activity log | Privileged assignments listed with names; activity filters work live |
| 4 | Defender for Cloud, exposure, dashboard | Results match the portal for a sampled subscription |
| 5 | Log Analytics | Live SigninLogs query through a workspace alias |
| 6 | Write framework, disabled by default | Sandbox round trip works through every gate; default profile provably sends no writes; guard hook prompts |
| 7 | Hardening, docs, v0.1.0 release | Published to npm; one real investigation completed through an agent |

---

## 13. Maintenance and agent-assisted upkeep

### 13.1 What drives maintenance

| Source of change | How often | Handled by |
|---|---|---|
| Dependency updates (`axi-sdk-js`, `@toon-format/toon`, `cross-spawn`, dev tools, GitHub Actions) | Weekly | Dependabot PRs (Section 10.2) |
| A newer stable ARM `api-version` worth adopting | Occasional | `verify-api-version` skill (Section 13.3) |
| Azure response shape drift (a renamed or removed field) | Rare on stable versions | Weekly local live smoke (Section 13.2), then the `fix-drift` skill |
| Azure CLI output change for `get-access-token` or `account show` | Rare | Auth tests plus live smoke |
| Claude Code hook schema change | Rare | `claude-guard.mjs` test plus Section 14.5 check |
| New commands requested from real use | As needed | Usage log (Section 13.5), then the `add-command` skill |

### 13.2 Scheduled checks (owner-run, never in CI)

- Run `node scripts/live-smoke.mjs` weekly on the owner's machine, through Windows Task Scheduler, cron, or a scheduled Claude Code task. It writes pass or fail per check to the OS temp directory and prints no response bodies.
- On a failure, the owner opens a GitHub issue labelled `drift` containing only the check name, the error code and a sanitized description of the response shape. Never paste real responses or identifiers into an issue (the repository is public).
- Run `node scripts/check-links.mjs` monthly and `node scripts/upstream-diff.mjs` quarterly.

### 13.3 Repo-local agent skills (`.claude/skills/`)

Each skill is a short `SKILL.md` encoding a repeatable procedure, so any agent session performs it the same way. Reference: Claude Code skills (https://code.claude.com/docs/en/skills).

| Skill | Procedure |
|---|---|
| `add-command` | The "Adding or changing a command" checklist in Section 10.4 |
| `fix-drift` | Given a `drift` issue: locate the spec example for the endpoint (Section 14.3), update the synthetic payload in the test or `test/samples.ts`, adjust fields and schema, update `src/lib/apiVersions.ts`, and list the live check the owner must re-run |
| `verify-api-version` | The Section 14.2 procedure for one endpoint, ending with an updated constant and doc comment in `src/lib/apiVersions.ts` |
| `release` | Changelog move, version bump, `chore: release vX.Y.Z` commit, tag instructions for the owner (the agent never pushes tags) |

Optionally, the Claude Code GitHub Action (https://code.claude.com/docs/en/github-actions) can turn an `@claude` mention on an issue into a PR. If enabled: it must not run on pull requests from forks, it has no Azure credentials, its PRs need owner review, and CODEOWNERS still applies.

### 13.4 Benchmark harness (`benchmark/`, `scripts/benchmark/`, `BENCHMARK.md`)

Mirror ado-axi's harness, which replaced the earlier idea of a capture switch inside `client.ts`, so no benchmark code ships in the runtime:

- `benchmark/scenarios.mjs` lists real az-axi invocations (for example `rg query` at 1, 10 and 50 rows, `rbac list --privileged`, `defender alerts`, `exposure`, `logs query`). Scenario `argv` never contains profile or subscription flags; the harness injects them.
- `scripts/benchmark/fetch-hook.mjs` is a `node --import` preload that wraps `fetch`. With `AZ_AXI_BENCH_MODE=record` it records every response to `$AZ_AXI_BENCH_FILE`; with `replay` it serves them back with no network. Replay runs use a `token` mode profile with a dummy token, because token acquisition happens through `az`, outside `fetch`.
- `scripts/benchmark/capture.mjs` (owner only) runs each scenario in record mode against the targets in the gitignored `benchmark/targets.json`, then scrubs before anything touches disk.
- `scripts/benchmark/scrub.mjs` and `scripts/benchmark/tokens.mjs` are implemented; see [README benchmark utilities](README.md#benchmark-utilities) for their contracts.
  The planned `targets.json` carries the owner's private strings (organization name, domains, internal code names) for the scrubber's `leakCheck` option.
- `scripts/benchmark/bench.mjs` replays the scrubbed captures and compares raw REST JSON tokens against az-axi's TOON tokens; `capture-surface.mjs` measures the `skills/az-axi/SKILL.md` frontmatter, body and help surface, as ado-axi does in `tool-surface.json`.
- Only `BENCHMARK.md` (numbers and method) is published. Captures stay in the gitignored `benchmark/fixtures/` and `benchmark/raw/`.
- `test/benchmark.test.ts` tests the scrubber and token counter with synthetic inputs, as in ado-axi.
- Reference: ado-axi `BENCHMARK.md` and `scripts/benchmark/` at commit `1a381cb`; gpt-tokenizer (https://github.com/niieani/gpt-tokenizer).

### 13.5 Opt-in usage log (`usageLog.ts`)

- Enabled only by `AZ_AXI_USAGE_LOG=1`. Writes JSON Lines to `~/.az-axi/usage.log`.
- Records time, command, subcommand, flag **names** (never values), error code, and for `api` the path as a template with every GUID and resource name replaced by a placeholder (for example `/subscriptions/{id}/resourceGroups/{name}/providers/Microsoft.Network/networkSecurityGroups/{name}`).
- Purpose: the owner periodically asks an agent to summarize which `api` templates recur, which become candidates for first-class commands.
- Never committed, never uploaded, never enabled by default.

### 13.6 Upstream sync

`node scripts/upstream-diff.mjs <ado-axi-commit>` clones ado-axi at the given commit into a temp directory and diffs each vendored file listed in `UPSTREAM.md` against its upstream counterpart. The owner decides which upstream fixes to port; the agent ports them and updates `UPSTREAM.md`.

---

## 14. Verification guide

### 14.1 Every PR (agent runs, CI enforces)

```
pnpm install --frozen-lockfile
pnpm run build                   # tsc, also the type check
pnpm test                        # includes guards, policy snapshot, token budgets, scrubber
node dist/bin/az-axi.js --help
node dist/bin/az-axi.js definitely-not-a-command; echo "exit=$?"   # expect exit=2
```

CI repeats these on Ubuntu (Node 22 and 24) and Windows (Node 22). A PR is not ready until all pass on all three.

### 14.2 Verifying an API version

Use these sources in order, and record which one confirmed the value:

1. **Specification repository.** Microsoft publishes every ARM API as OpenAPI or TypeSpec in `Azure/azure-rest-api-specs`. A tree-only clone is fast and avoids GitHub API rate limits:
   ```
   git clone --filter=blob:none --no-checkout --depth 1 https://github.com/Azure/azure-rest-api-specs.git specs
   cd specs
   git ls-tree --name-only HEAD specification/<folder from Section 6 table>/
   git show HEAD:specification/<path>/stable/<version>/examples/<Example>.json   # response shape
   ```
   Only `stable/` folders qualify; never use `preview/` versions.
2. **REST reference page** on Microsoft Learn (links in Section 6 and Section 15). Many pages have a version selector (`?view=`); confirm the request path, required parameters and response properties for the chosen version.
3. **Live provider check (owner runs).** Lists the versions the live endpoint accepts:
   ```
   az provider show --namespace Microsoft.Security --query "resourceTypes[?resourceType=='alerts'].apiVersions" --output tsv
   az provider show --namespace Microsoft.ResourceGraph --query "resourceTypes[?resourceType=='resources'].apiVersions" --output tsv
   ```
   Reference: az provider show (https://learn.microsoft.com/en-us/cli/azure/provider#az-provider-show).

Data-plane APIs (Log Analytics query, Microsoft Graph) are versioned in the path (`v1`, `v1.0`); verify them on their reference pages only.

### 14.3 Test payload fidelity

- Following ado-axi, tests use inline payloads (or shared ones in `test/samples.ts`), never a fixtures folder. Build them from the `examples/*.json` files in the specification repository for the chosen version. These are Microsoft's published sample payloads, so their shape is authoritative.
- Replace every identifier (subscription IDs, tenant IDs, object IDs, resource names, hostnames, email addresses) with the synthetic values from Section 7.3 before committing. Microsoft's examples contain real-looking GUIDs that the identifier guard will reject.
- Put a `// source: <spec path>@<version>` comment above each payload so drift fixes can find the origin.
- Benchmark captures are a separate, owner-only artifact and are never committed (Section 13.4).

### 14.4 Live cross-checks (owner runs at each gate)

Compare az-axi output against an independent source. Counts and key fields should match; ordering may differ.

| az-axi command | Independent check |
|---|---|
| `doctor` (identity) | `az account show --query "{name:user.name,type:user.type,tenant:tenantId}"` |
| `sub list` | `az account list --query "length(@)"` |
| `rg query "<kql>"` | Same query in the portal's Resource Graph Explorer, or `az graph query -q "<kql>"` (resource-graph extension) |
| `rbac list --privileged` | `az role assignment list --all --query "[?roleDefinitionName=='Owner'] \| length(@)"` and the same for the other privileged roles |
| `activity list --since 24h --status Failed` | `az monitor activity-log list --offset 24h --status Failed --query "length(@)"` |
| `defender alerts` | Defender for Cloud portal, Security alerts blade, same filters; or `az security alert list` |
| `security alert update` | Owner only in a disposable sandbox: compare the selected alert's status before/after in the Defender portal; repeat the action to verify a no-op |
| `defender assessments` | Defender for Cloud portal, Recommendations blade, unhealthy counts per recommendation |
| `defender score` | `az security secure-scores list` |
| `exposure` | Each query from `--show-query` pasted into Resource Graph Explorer |
| `logs query` | Same query in the workspace's Logs blade, or `az monitor log-analytics query -w <workspace-guid> --analytics-query "<kql>"` |
| `graph query -q "<kql>"` | Compare with `az graph query -q "<kql>"` using the same explicit scope and `--first 50`; az-axi retains profile scope |
| `monitor log-analytics query --analytics-query "<kql>"` | Compare with Azure CLI using explicit `--timespan P1D`; az-axi retains P1D instead of all available data |
| Request correlation | `az monitor activity-log list --correlation-id <correlationId from az-axi output>` returns the matching event (writes only; reads are not in the activity log) |

Reference for the Azure CLI commands: Azure CLI reference index (https://learn.microsoft.com/en-us/cli/azure/reference-index).

### 14.5 Write framework (Phase 6 gate and any change to Section 6.13)

- Run the Phase 6 gate script against the sandbox.
- Concurrency check: run a dry run, change the same tag in the portal, then execute with the dry run's `--if-match`; expect `PRECONDITION_FAILED`.
- Confirm every executed write appears in `~/.az-axi/writes.log` with no bodies, and in the activity log via its correlation ID.
- Confirm the guard hook prompts: start an agent session with `scripts/claude-guard.mjs` installed, ask it to run a command with `--execute`, and check that Claude Code asks for approval. Repeat after any Claude Code upgrade that mentions hooks in its changelog.
- Confirm `AZ_AXI_READ_ONLY=1` blocks the same command.

### 14.6 Release and supply chain

- `npm pack --dry-run` shows only the allowed files (Phase 7 acceptance criteria).
- After publishing, `npm view @<npm-scope>/az-axi dist.attestations` shows a provenance attestation. Reference: npm trusted publishing (https://docs.npmjs.com/trusted-publishers) and provenance (https://docs.npmjs.com/generating-provenance-statements).
- Grep the rendered output of every `test/samples.ts` payload for `eyJ`, `AccountKey=`, `SharedAccessSignature` and `-----BEGIN`; expect no matches (also covered by tests).

### 14.7 Reference links

`node scripts/check-links.mjs` sends a request to every URL in PLAN.md, README.md, `skills/az-axi/SKILL.md` and `src/lib/apiVersions.ts` and lists failures. The owner runs it (it needs open internet access). Replace dead links using the page titles given in this plan, and update Section 15.

---

## 15. Reference index

Where to look, by topic. Links were current on 2026-10-01; if one has moved, search for its title (Section 0, rule 9).

### 15.1 Project, upstream and format

| Topic | Reference |
|---|---|
| Upstream for structure and vendored modules | ado-axi: https://github.com/jeffreyhaen/ado-axi (commit `1a381cb`) |
| Sibling AXI and design reference | msgraph-axi: https://github.com/jeffreyhaen/msgraph-axi |
| Same-name project reviewed in Section 2.4 and 2.5 | masyanru/az-axi: https://github.com/masyanru/az-axi |
| AXI principles | https://axi.md/ and https://github.com/kunchenguid/axi |
| AXI runtime | axi-sdk-js: https://www.npmjs.com/package/axi-sdk-js |
| TOON format | https://toonformat.dev/ and https://github.com/toon-format/toon |

### 15.2 Azure Resource Manager and specifications

| Topic | Reference |
|---|---|
| All ARM API specifications and examples | https://github.com/Azure/azure-rest-api-specs (Section 14.2) |
| Azure REST API reference landing page | https://learn.microsoft.com/en-us/rest/api/azure/ |
| Azure REST API guidelines (errors, headers, ETags, long-running operations) | https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md |
| Throttling and request limits | https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/request-limits-and-throttling |
| Asynchronous operations | https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/async-operations |
| Subscriptions - List | https://learn.microsoft.com/en-us/rest/api/resources/subscriptions/list |
| Deployments - What If | https://learn.microsoft.com/en-us/rest/api/resources/deployments/what-if |
| Resource locks | https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/lock-resources |

### 15.3 Resource Graph

| Topic | Reference |
|---|---|
| REST quickstart (endpoint, body, api-version) | https://learn.microsoft.com/en-us/azure/governance/resource-graph/first-query-rest-api |
| Query language | https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/query-language |
| Tables and resource types (`authorizationresources`, `securityresources`) | https://learn.microsoft.com/en-us/azure/governance/resource-graph/reference/supported-tables-resources |
| Paging large result sets | https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/work-with-data |
| Throttling guidance | https://learn.microsoft.com/en-us/azure/governance/resource-graph/concepts/guidance-for-throttled-requests |
| Sample queries | https://learn.microsoft.com/en-us/azure/governance/resource-graph/samples/starter |

### 15.4 Access, activity, Defender, logs

| Topic | Reference |
|---|---|
| Built-in roles and their GUIDs | https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles |
| Role Assignments - List For Scope (ARM fallback) | https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/list-for-scope |
| Graph directoryObject: getByIds | https://learn.microsoft.com/en-us/graph/api/directoryobject-getbyids |
| Activity Logs - List | https://learn.microsoft.com/en-us/rest/api/monitor/activity-logs/list |
| Defender alerts | https://learn.microsoft.com/en-us/rest/api/defenderforcloud/alerts/list and https://learn.microsoft.com/en-us/rest/api/defenderforcloud/alerts/get-subscription-level |
| Defender alert status actions | https://learn.microsoft.com/en-us/rest/api/defenderforcloud/alerts/update-subscription-level-state-to-activate?view=rest-defenderforcloud-2022-01-01 (same stable contract for dismiss/resolve and resource-group scope) |
| Defender assessments | https://learn.microsoft.com/en-us/rest/api/defenderforcloud/assessments/list |
| Defender secure scores | https://learn.microsoft.com/en-us/rest/api/defenderforcloud/secure-scores/list |
| Log Analytics query | https://learn.microsoft.com/en-us/rest/api/loganalytics/dataaccess/query/execute |

### 15.5 Azure CLI

| Topic | Reference |
|---|---|
| `az account get-access-token` and `az account show` | https://learn.microsoft.com/en-us/cli/azure/account |
| Sign-in methods (user, service principal, managed identity, federated) | https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli |
| CLI configuration and `AZURE_CORE_*` variables | https://learn.microsoft.com/en-us/cli/azure/azure-cli-configuration |
| `az provider show` (live api-version check) | https://learn.microsoft.com/en-us/cli/azure/provider |
| CLI reference index (cross-check commands) | https://learn.microsoft.com/en-us/cli/azure/reference-index |

### 15.6 Node.js, TypeScript and libraries

| Topic | Reference |
|---|---|
| `NODE_EXTRA_CA_CERTS` (TLS inspection) | https://nodejs.org/api/cli.html#node_extra_ca_certsfile |
| Spawning `.cmd` files on Windows | https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows |
| Built-in `fetch` | https://nodejs.org/api/globals.html#fetch |
| cross-spawn | https://github.com/moxystudio/node-cross-spawn |
| Vitest mocking and fake timers | https://vitest.dev/guide/mocking and https://vitest.dev/api/vi |
| gpt-tokenizer | https://github.com/niieani/gpt-tokenizer |
| tsconfig reference | https://www.typescriptlang.org/tsconfig |

### 15.7 GitHub, npm and Claude Code

| Topic | Reference |
|---|---|
| CODEOWNERS | https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners |
| Protected branches | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches |
| Secret scanning push protection | https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection |
| Dependabot configuration options | https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference |
| npm trusted publishing and provenance | https://docs.npmjs.com/trusted-publishers and https://docs.npmjs.com/generating-provenance-statements |
| Claude Code hooks | https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/hooks-guide |
| Claude Code permissions and settings | https://code.claude.com/docs/en/permissions and https://code.claude.com/docs/en/settings |
| Claude Code skills | https://code.claude.com/docs/en/skills |
| Claude Code memory files (for a repository instructions file, if one is added later) | https://code.claude.com/docs/en/memory |
| Claude Code GitHub Actions | https://code.claude.com/docs/en/github-actions |

---

## 16. Next steps before Phase 0

1. Confirm with your manager, or against your employer's IP and open-source policy, that publishing this tool from a personal public repository is acceptable.
2. Create the public GitHub repository `az-axi` and enable secret scanning and push protection.
3. Choose the npm scope, confirm `@<npm-scope>/az-axi` is free, and set up npm trusted publishing for the repository.
4. Check for the other project on your machine with `npm ls -g az-axi`. If it is installed, uninstall it before installing this one, because both install an `az-axi` binary (Section 2.4).
5. Confirm the identity used for daily work holds Reader, Security Reader and Log Analytics Reader at the intended scope (eligible through PIM if preferred).
6. Identify a disposable sandbox subscription or resource group for the Phase 6 write tests, and decide which write roles (if any) to make PIM-eligible there.
7. Copy `PLAN.md` into the new repository and start the agent on Phase 0.
