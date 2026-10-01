# Upstream

Vendored from ado-axi (https://github.com/jeffreyhaen/ado-axi) at commit `1a381cbbafc5b9127e1381fbd2c404f591ada881`.

Update the row of a file in the same commit that changes it.
`NOTICE.md` carries the upstream MIT notice.

## Vendored source files

| File | Upstream path | Local changes |
|---|---|---|
| `src/lib/args.ts` | `src/lib/args.ts` | none |
| `src/lib/argv.ts` | `src/lib/argv.ts` | none |
| `src/lib/auth.ts` | `src/lib/auth.ts` | none |
| `src/lib/client.ts` | `src/lib/client.ts` | none |
| `src/lib/config.ts` | `src/lib/config.ts` | none |
| `src/lib/context.ts` | `src/lib/context.ts` | none |
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
| `package.json` | `package.json` | az-axi name, metadata, `files` and `bin`; dependencies identical |

## Patterns reimplemented, not vendored

`src/bin/az-axi.ts`, `src/help.ts` and `src/commands/home.ts` follow the structure of their ado-axi counterparts and are written for az-axi.
