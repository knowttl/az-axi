# Changelog

All notable changes to az-axi are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.2](https://github.com/knowttl/az-axi/compare/v0.1.1...v0.1.2) (2026-10-03)


### Features

* accept API JSON bodies from files and stdin ([#39](https://github.com/knowttl/az-axi/issues/39)) ([0c84d29](https://github.com/knowttl/az-axi/commit/0c84d29fa2aac7f7aed7ee5e19b7d4ef5bb415fc))
* add az-compatible command routing and flag parsing ([#41](https://github.com/knowttl/az-axi/issues/41)) ([f3938b5](https://github.com/knowttl/az-axi/commit/f3938b5076f82dae0eaad7ff7b9e05784ae39b0a))
* add az-style Graph and Log Analytics query paths ([#42](https://github.com/knowttl/az-axi/issues/42)) ([f14a693](https://github.com/knowttl/az-axi/commit/f14a693fdf1c2ed036d92a206d5a058fbdef03b8))

## [0.1.1](https://github.com/knowttl/az-axi/compare/v0.1.0...v0.1.1) (2026-10-03)


### Features

* add command leaf registry with explicit capability contracts ([#36](https://github.com/knowttl/az-axi/issues/36)) ([7e4467a](https://github.com/knowttl/az-axi/commit/7e4467a6ca6418cb1c4a3cbcec53e6626ad202aa))

## [Unreleased]

- README: `Install`, `Use` and `Behavior` sections (install, one example per command, error codes and exit codes).

- `sentinel incident list|show|list-alert|list-entity`: Sentinel incident triage on one Log Analytics workspace, including related alerts and entities through reviewed bodyless read POSTs; analytics rules, connectors and incident updates stay out of scope.
- `rg query`: Resource Graph queries with `--file`/stdin, skip-token paging, ID shortening and throttling hints.
- `api`: read/query escape hatch for any ARM, Log Analytics or Graph path; writes stay blocked with `WRITES_DISABLED`.
- Dashboard (`az-axi` with no arguments): profile, identity, subscriptions and write status.
- `defender alerts|assessments|score`: Defender for Cloud alerts (list and get), grouped recommendations and per-subscription secure scores.
- `exposure`: canned Resource Graph checks for attached public IPs, open management ports and any-any NSG rules, with `--show-query`.
- Dashboard (`az-axi` with no arguments): active alerts by severity, secure score average and lowest subscription, and exposure counts. A failed section degrades to a hint.
- `logs query`: Log Analytics KQL with workspace aliases, ISO timespans, `--file`/stdin, client-side row caps, multi-table counts and partial-error warnings.
- Write framework groundwork (still disabled): pure field-level diff for dry-run change previews.
- Token budgets: `test/samples.ts` holds a synthetic payload per command and `test/budget.test.ts` asserts each rendered TOON output stays under its measured-plus-20-percent ceiling.
- Write log (`src/lib/writeLog.ts`): append-only record of executed writes at `~/.az-axi/writes.log`; not yet wired into any command.
- `skills/az-axi/SKILL.md`: agent usage guide with every command, safe shell input, the naming notice, and the writes policy.
- `api` write dry runs replace the earlier unconditional write block: write-enabled profiles now receive a gated preview without `--execute`.
  Previews send only reads plus, for deployments, a what-if POST query that changes nothing.
  Execution remains unavailable: every passing `--execute` returns `API_ERROR`, with `--confirm` required first for destructive requests.
- `op status`: read-only check of a long-running operation URL on `management.azure.com`; anything else is rejected with `VALIDATION_ERROR`.
- `lro.ts`: long-running operation polling for the write framework (prefers `Azure-AsyncOperation`, else polls `Location` until not 202; honours `Retry-After`, defaults `--timeout` to 600s, maps `Failed`/`Canceled` to `OPERATION_FAILED`).
