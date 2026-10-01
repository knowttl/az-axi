# Phase 0 Gate Report

Phase 0 (bootstrap and verification) of `PLAN.md`, Section 9.
Phase 1 has not been started and waits for owner approval of this gate.

## What was built

- Tooling scaffold copied from ado-axi at commit `1a381cbbafc5b9127e1381fbd2c404f591ada881`: `tsconfig.json`, `.nvmrc`, `pnpm-workspace.yaml`, `.gitignore` (Azure names), `ci.yml`, `release.yml`, `scripts/release-notes.mjs`, `test/release-notes.test.ts`, and `package.json` (`@knowttl/az-axi`, same dependency majors as upstream).
- Vendored helpers: commit `chore: vendor ado-axi helpers at 1a381cb` holds nine `src/lib` files, byte-identical to upstream (`args`, `argv`, `auth`, `client`, `config`, `context`, `format`, `paths`, `stdin`).
- `LICENSE`, `NOTICE.md` (upstream MIT notice), `UPSTREAM.md`, `CHANGELOG.md` (`Unreleased` only), `.github/CODEOWNERS`, `.github/dependabot.yml`.
- `PLAN.md` at the repository root, with the owner's personal name replaced by `knowttl`.
- Minimal CLI: `src/bin/az-axi.ts`, `src/help.ts`, `src/commands/home.ts` with `--help`, `--version` and a placeholder home handler.
  Unknown commands and leading flags exit 2.
  The SDK's built-in `update` command is shadowed so the CLI has no self-update surface.
- `test/identifiers.test.ts`: the public-repo guard from Section 7.3.
  It audits every tracked text file and is itself tested with controlled allowed and prohibited fixtures.
- `src/lib/apiVersions.ts`: one constant per Section 6 endpoint with verified version, spec path, documentation URL, newer stable version, reason and date.

## Test results

Run on the final head, Node 24, pnpm 9.15.9 (the version CI uses):

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm run build` (tsc) | pass |
| `pnpm test` | pass (3 files, 12 tests: `test/cli.test.ts` 2, `test/identifiers.test.ts` 6, `test/release-notes.test.ts` 4) |
| `node dist/bin/az-axi.js --help` | prints help, exit 0 |
| `node dist/bin/az-axi.js --version` | prints the version, exit 0 |
| `node dist/bin/az-axi.js definitely-not-a-command` | exit 2 |
| `node dist/bin/az-axi.js update` | exit 2, unknown command |
| `actionlint` on the workflows | clean |

Identifier guard fail-then-revert: a throwaway test file containing a random GUID, an email on a non-example domain and a URL on that same non-public host made the GUID, email and hostname checks fail with file and line diagnostics.
Removing the file returned the suite to green.

## API version verification (Section 6, VERIFY)

Verified on 2026-10-01 against the stable folders of `Azure/azure-rest-api-specs` at commit `0447e91e` (tree-only clone), and against the Microsoft Learn reference pages.

| Endpoint | Chosen version | Note |
|---|---|---|
| Subscriptions list | `2022-12-01` | Newest stable |
| Resource Graph | `2024-04-01` | Request and response diffed against `2022-10-01`: same shape |
| Role assignments | `2022-04-01` | Newest stable |
| Activity log | `2015-04-01` | Only stable version with `activityLogs_API.json` |
| Defender alerts | `2022-01-01` | Newest |
| Defender assessments | `2025-05-04` | Adds `risk` only |
| Secure scores | `2020-01-01` | Only version |
| Management locks | `2020-05-01` | Spec lives under `Microsoft.Authorization/locks` |
| Deployments what-if | `2026-06-01` | Only optional fields added versus `2025-04-01` |
| Log Analytics query | `v1` | Path version |
| Graph getByIds | `v1.0` | Path version |

- The Learn supported-tables page confirms `authorizationresources` (roleassignments, roledefinitions) and `securityresources` (assessments, securescores).
- The plan's Log Analytics page `/rest/api/loganalytics/dataaccess/query/execute` now returns 404.
  It moved to `https://learn.microsoft.com/en-us/rest/api/logsquery/query/execute?view=rest-logsquery-v1`.
  Section 15.4 of the plan should be updated.

## Captain decisions applied

1. npm scope and owner handle: `@knowttl/az-axi` in `package.json` and `@knowttl` in `CODEOWNERS`.
2. `PLAN.md` is committed at the repository root, with the owner's personal name sanitized to `knowttl`.
3. Activity-log `--caller`: the documented `$filter` grammar for the activity-log list call has no `caller` clause ("No other syntax is allowed").
   `--caller` will therefore be applied as a client-side filter over retrieved events.
   Phase 3 qualifies this live.

## Deferred

- Activity-log `--caller` client-side filter and its live qualification: Phase 3.
- Owner live check that the service accepts what-if `2026-06-01`; fall back to `2025-04-01` if not.
- Owner live provider checks from Section 14.2 (`az provider show`) for Security and ResourceGraph.
- Benchmark scripts (`bench`, `bench:capture`, `bench:surface`) are not in `package.json` yet; they arrive with the benchmark harness in Phase 7.
- Plan Section 15.4 documentation link update for Log Analytics (see above).
- Everything in Phases 1 to 7.

## Live smoke commands for the owner

Phase 0 has no live behavior, so there are no `az-axi` live smoke commands.
The only live checks are the api-version confirmations above, run with a signed-in Azure CLI:

```
az provider show --namespace Microsoft.Resources --query "resourceTypes[?resourceType=='deployments'].apiVersions" --output tsv
az provider show --namespace Microsoft.Security --query "resourceTypes[?resourceType=='alerts'].apiVersions" --output tsv
az provider show --namespace Microsoft.ResourceGraph --query "resourceTypes[?resourceType=='resources'].apiVersions" --output tsv
```

Gate: the owner reviews `src/lib/apiVersions.ts` and the vendored commit.
