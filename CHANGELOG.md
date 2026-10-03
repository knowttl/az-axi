# Changelog

All notable changes to az-axi are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.1](https://github.com/knowttl/az-axi/compare/v0.1.0...v0.1.1) (2026-10-03)


### Features

* add agent approval hook for az-axi writes ([#32](https://github.com/knowttl/az-axi/issues/32)) ([b26d935](https://github.com/knowttl/az-axi/commit/b26d9355b9779923d24424c391b96d95f9697377))
* add append-only write log framework ([#18](https://github.com/knowttl/az-axi/issues/18)) ([dfcdfbc](https://github.com/knowttl/az-axi/commit/dfcdfbc04f16be57a40b3042120bbfc05ce3ecb2))
* add Azure auth, profiles, client, and doctor ([#8](https://github.com/knowttl/az-axi/issues/8)) ([279ee47](https://github.com/knowttl/az-axi/commit/279ee47f29a8597379056fefb56aef82fdc3bd2b))
* add benchmark scrubber and token counter ([#26](https://github.com/knowttl/az-axi/issues/26)) ([fa6ecd5](https://github.com/knowttl/az-axi/commit/fa6ecd5ad378d3642397d39f02c8d4ddf84ed3ec))
* add Defender for Cloud and exposure checks ([#12](https://github.com/knowttl/az-axi/issues/12)) ([deed8d2](https://github.com/knowttl/az-axi/commit/deed8d2295871bac0389be9292efceb22636fa9f))
* add gated API dry-run previews and operation status ([#23](https://github.com/knowttl/az-axi/issues/23)) ([0220287](https://github.com/knowttl/az-axi/commit/02202877280b9a4509714dde73a204ef1d222f0f))
* add Log Analytics KQL queries ([#13](https://github.com/knowttl/az-axi/issues/13)) ([f13b7a6](https://github.com/knowttl/az-axi/commit/f13b7a6801030ed2b71bb8c89b983602aaf60caa))
* add long-running operation polling and improve status reporting ([#20](https://github.com/knowttl/az-axi/issues/20)) ([2ec40d1](https://github.com/knowttl/az-axi/commit/2ec40d163ed7b407f1d28e23b595a7f3585b8a1d))
* add packaged Azure agent usage skill ([#21](https://github.com/knowttl/az-axi/issues/21)) ([4055e24](https://github.com/knowttl/az-axi/commit/4055e24f5ad67d1d164d4904a1a59bfc0c1b4dd0))
* add record/replay benchmark harness and token measurements ([#27](https://github.com/knowttl/az-axi/issues/27)) ([b2404d8](https://github.com/knowttl/az-axi/commit/b2404d8f4a6059422cffd5a1543996e9608a01e1))
* add resource diff computation for dry-run previews ([#15](https://github.com/knowttl/az-axi/issues/15)) ([911219a](https://github.com/knowttl/az-axi/commit/911219a114ac03de73cdbf048f37e6890bb0ba1f))
* add Resource Graph, RBAC, and activity log ([#9](https://github.com/knowttl/az-axi/issues/9)) ([b8c6f9b](https://github.com/knowttl/az-axi/commit/b8c6f9b9b19011137de4651b187f0fc143980f2d))
* automate npm releases for @knowttl/az-axi ([#33](https://github.com/knowttl/az-axi/issues/33)) ([6b18a2a](https://github.com/knowttl/az-axi/commit/6b18a2abc6335f30bc72a0607aec7258f00caa83))
* bootstrap the az-axi CLI ([#1](https://github.com/knowttl/az-axi/issues/1)) ([9e35dee](https://github.com/knowttl/az-axi/commit/9e35dee33d5605500c93f24597b20b3e94727067))
* enable gated API write execution ([#30](https://github.com/knowttl/az-axi/issues/30)) ([e6c874d](https://github.com/knowttl/az-axi/commit/e6c874d9c93621349595a364faf9e51f384eba06))
* expose write configuration and add opt-in write smoke checks ([#31](https://github.com/knowttl/az-axi/issues/31)) ([cefed20](https://github.com/knowttl/az-axi/commit/cefed201ad46e343025138859821e3ec368301f9))


### Bug Fixes

* clarify write restrictions in API help and README ([#14](https://github.com/knowttl/az-axi/issues/14)) ([49db9e0](https://github.com/knowttl/az-axi/commit/49db9e0125fd289b5dcc28aeb4df574866b68e48))
* make dependency preparation noninteractive ([#29](https://github.com/knowttl/az-axi/issues/29)) ([b29db0f](https://github.com/knowttl/az-axi/commit/b29db0f80efb801c4ede65077802264ebd8cf97a))
* terminate Azure CLI process tree on Windows cancellation ([#28](https://github.com/knowttl/az-axi/issues/28)) ([42849ea](https://github.com/knowttl/az-axi/commit/42849eabe9390fa5a78cdb93fc4b64a7b6b2ec94))

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
- `op status`: read-only check of a long-running operation URL on `management.azure.com`; anything else is rejected with `VALIDATION_ERROR`.
- `lro.ts`: long-running operation polling for the write framework (prefers `Azure-AsyncOperation`, else polls `Location` until not 202; honours `Retry-After`, defaults `--timeout` to 600s, maps `Failed`/`Canceled` to `OPERATION_FAILED`).
