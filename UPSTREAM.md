# Upstream

Vendored from ado-axi (https://github.com/jeffreyhaen/ado-axi) at commit `1a381cbbafc5b9127e1381fbd2c404f591ada881`.

Update the row of a file in the same commit that changes it.
`NOTICE.md` carries the upstream MIT notice.

## Vendored source files

| File | Upstream path | Local changes |
|---|---|---|
| `src/lib/args.ts` | `src/lib/args.ts` | Global Azure selector flags and rename hints; strict leaf-schema parsing of short flags (including `-l` location), lists, booleans, conflicting repetitions and `--` before handler loading |
| `src/lib/argv.ts` | `src/lib/argv.ts` | Leading Azure selectors and display flags moved behind the command; subscription short flag `-s`; explicit boolean values preserved |
| `src/lib/auth.ts` | `src/lib/auth.ts` | Generalized: per-resource tokens (see `tokenEnv` in [Profiles](README.md#profiles)), `token` mode replaces PAT, expiry-aware cache, hardened `az` spawn environment, Azure error mapping, `identityOf`, exported `runAz`, optional `AbortSignal` for credential acquisition and the spawned `az` process; reviewed-read transport bounds and extension isolation, Windows cancellation handling (see the `runAz` contract in [auth.ts](src/lib/auth.ts) and [passthrough reference](README.md#pinned-azure-cli-read-catalogue)) |
| `src/lib/client.ts` | `src/lib/client.ts` | Rewritten for ARM, Log Analytics and Graph hosts: api-version handling, JSON serialization preserving request body value types, ARM error translation, TLS mapping, one retry on 429 or 503 only when Retry-After is at most 10 seconds (absent or unparseable is not retried), `nextLink` paging (default cap 10 pages), `{status,headers,body}` responses, correlation headers, policy and gate enforcement before every request including explicit execution and destructive confirmation, metadata-only request errors for write auditing, optional `AbortSignal` forwarded through credential acquisition, requests and retry waits |
| `src/lib/config.ts` | `src/lib/config.ts` | Azure profile fields, implicit `az` profile, `allowWrites` and `AZ_AXI_READ_ONLY` rules, scope overrides from flags and environment |
| `src/lib/context.ts` | `src/lib/context.ts` | Profile flags are the Azure selector set; `subcommandOf` throws a `VALIDATION_ERROR` instead of a plain `Error` |
| `src/lib/format.ts` | `src/lib/format.ts` | none |
| `src/lib/paths.ts` | `src/lib/paths.ts` | none |
| `src/lib/stdin.ts` | `src/lib/stdin.ts` | none |

## Copied tooling files

| File | Upstream path | Local changes |
|---|---|---|
| `tsconfig.json` | `tsconfig.json` | none |
| `.nvmrc` | `.nvmrc` | none |
| `pnpm-workspace.yaml` | `pnpm-workspace.yaml` | none |
| `.gitignore` | `.gitignore` | ado-axi names replaced with az-axi names, Azure benchmark comments |
| `.github/workflows/ci.yml` | `.github/workflows/ci.yml` | smoke test runs `dist/bin/az-axi.js` |
| `scripts/release-notes.mjs` | `scripts/release-notes.mjs` | Also recognizes unlinked release-please version headings |
| `test/release-notes.test.ts` | `test/release-notes.test.ts` | Coverage for unlinked release-please version headings |
| `package.json` | `package.json` | az-axi name, metadata, `files` and `bin`; no-emit `typecheck` script; read-catalogue maintenance scripts (see [README.md](README.md#pinned-azure-cli-read-catalogue)); benchmark scripts adapted for Azure (see [BENCHMARK.md](BENCHMARK.md)) |

The copied `.github/workflows/release.yml` was replaced by the local release workflow described in [README.md#releases](README.md#releases).

## Patterns reimplemented, not vendored

`src/bin/az-axi.ts`, `src/help.ts` and `src/commands/*.ts` follow the structure of their ado-axi counterparts and are written for az-axi.
The write-framework hooks (`policy.ts`, `gates.ts`, `registry.ts`, `redact.ts`) and `version.ts` have no ado-axi counterpart.
