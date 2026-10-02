# Upstream

Vendored from ado-axi (https://github.com/jeffreyhaen/ado-axi) at commit `1a381cbbafc5b9127e1381fbd2c404f591ada881`.

Update the row of a file in the same commit that changes it.
`NOTICE.md` carries the upstream MIT notice.

## Vendored source files

| File | Upstream path | Local changes |
|---|---|---|
| `src/lib/args.ts` | `src/lib/args.ts` | Global flags are the Azure selector set (`profile`, `tenant`, `subscription`, `management-group`, `config`, `limit`, ...); rename hints are Azure's (`sub`, `mg`, `ws`, ...) |
| `src/lib/argv.ts` | `src/lib/argv.ts` | Leading flags moved behind the command: value flags `profile`, `tenant`, `subscription`, `management-group`, `config`, `fields`, `limit`; boolean `full` does not consume the next token |
| `src/lib/auth.ts` | `src/lib/auth.ts` | Generalized: per-resource tokens (`arm`, `logs`, `graph`), `token` mode replaces PAT, expiry-aware cache, hardened `az` spawn environment, Azure error mapping, `identityOf`, exported `runAz` |
| `src/lib/client.ts` | `src/lib/client.ts` | Rewritten for ARM, Log Analytics and Graph hosts: api-version handling, ARM error translation, TLS mapping, one retry on 429 or 503 only when Retry-After is at most 10 seconds (absent or unparseable is not retried), `nextLink` paging (default cap 10 pages), `{status,headers,body}` responses, correlation headers, policy and gate enforcement before every request |
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
| `.github/workflows/release.yml` | `.github/workflows/release.yml` | none |
| `scripts/release-notes.mjs` | `scripts/release-notes.mjs` | none |
| `test/release-notes.test.ts` | `test/release-notes.test.ts` | none |
| `package.json` | `package.json` | az-axi name, metadata, `files` and `bin`; `bench`, `bench:capture`, and `bench:surface` removed; dependencies identical |

## Patterns reimplemented, not vendored

`src/bin/az-axi.ts`, `src/help.ts` and `src/commands/*.ts` follow the structure of their ado-axi counterparts and are written for az-axi.
The write-framework hooks (`policy.ts`, `gates.ts`, `registry.ts`, `redact.ts`) and `version.ts` have no ado-axi counterpart.
