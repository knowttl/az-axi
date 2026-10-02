# Changelog

All notable changes to az-axi are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

- README: `Install`, `Use` and `Behavior` sections (install, one example per command, error codes and exit codes).

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
