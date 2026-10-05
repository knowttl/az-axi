# Changelog

All notable changes to az-axi are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.4](https://github.com/knowttl/az-axi/compare/v0.1.3...v0.1.4) (2026-10-05)


### Features

* add local-only session-start hook with setup installer ([#71](https://github.com/knowttl/az-axi/issues/71)) ([adbdd1a](https://github.com/knowttl/az-axi/commit/adbdd1a9d334600b4a6016ccce752392c6991220))


### Bug Fixes

* streamline az-axi agent skill and prevent documentation drift ([#67](https://github.com/knowttl/az-axi/issues/67)) ([53cb7d0](https://github.com/knowttl/az-axi/commit/53cb7d05909992f0cafcf3ce97080e6c26021958))


### Performance Improvements

* answer --version without loading the command catalogue ([#70](https://github.com/knowttl/az-axi/issues/70)) ([6bf7dc0](https://github.com/knowttl/az-axi/commit/6bf7dc0f18dbd2a522340af79eec4c69b2c068a1))

## [0.1.3](https://github.com/knowttl/az-axi/compare/v0.1.2...v0.1.3) (2026-10-04)


### Features

* add Entra-only storage container and blob metadata reads ([#48](https://github.com/knowttl/az-axi/issues/48)) ([43a9629](https://github.com/knowttl/az-axi/commit/43a96296d010e810ce52fa5606084835056781dc))
* add Key Vault metadata and expiry listings ([#51](https://github.com/knowttl/az-axi/issues/51)) ([84e96f9](https://github.com/knowttl/az-axi/commit/84e96f9468d1561d9df4651eaa5b3d216549a614))
* add native account and Log Analytics workspace discovery ([#49](https://github.com/knowttl/az-axi/issues/49)) ([919fc32](https://github.com/knowttl/az-axi/commit/919fc3295e04cec5877080cbe60b563f56e6ed16))
* add native ACR repository, tag, and manifest metadata reads ([#55](https://github.com/knowttl/az-axi/issues/55)) ([1517a14](https://github.com/knowttl/az-axi/commit/1517a143bb2dc5a46a277be06b6c95050be40437))
* add native Azure Monitor reads ([#65](https://github.com/knowttl/az-axi/issues/65)) ([6d5f347](https://github.com/knowttl/az-axi/commit/6d5f347bca8cda95032cf3b803a680704a073063))
* add native Azure policy inventory and compliance reads ([#60](https://github.com/knowttl/az-axi/issues/60)) ([c7701e0](https://github.com/knowttl/az-axi/commit/c7701e04eb334a071acbeeb5c1b3e7651a6e8159))
* add native Defender alert status updates ([#44](https://github.com/knowttl/az-axi/issues/44)) ([a7c1ca4](https://github.com/knowttl/az-axi/commit/a7c1ca4bb605f3835d1717dde553f349a81b646f))
* add native lock and deny-assignment reads ([#61](https://github.com/knowttl/az-axi/issues/61)) ([76602e0](https://github.com/knowttl/az-axi/commit/76602e03a7479e133769f80945a5abc1e34ca582))
* add native network and public DNS reads ([#58](https://github.com/knowttl/az-axi/issues/58)) ([ade415d](https://github.com/knowttl/az-axi/commit/ade415d36d92058562f8a47055f99aeb1b8cc85b))
* add native resource group and resource discovery ([#47](https://github.com/knowttl/az-axi/issues/47)) ([c8a130f](https://github.com/knowttl/az-axi/commit/c8a130f93f9998f7b43a5c0f81e7cde93dd7c948))
* add native resource tag merge and delete ([#57](https://github.com/knowttl/az-axi/issues/57)) ([6a26f66](https://github.com/knowttl/az-axi/commit/6a26f6682e4c95653e7a4e5c169e4f6b890d23c3))
* add native Sentinel incident list and show ([#52](https://github.com/knowttl/az-axi/issues/52)) ([6c94a2d](https://github.com/knowttl/az-axi/commit/6c94a2dbde4cf8ee624b4cfc4379850c3e16e2d9))
* add native Sentinel incident updates and comments ([#54](https://github.com/knowttl/az-axi/issues/54)) ([e5ad246](https://github.com/knowttl/az-axi/commit/e5ad24699151fff8a8ddda08a4e550fb12126d9c))
* add native VM, scale-set, and disk reads ([#66](https://github.com/knowttl/az-axi/issues/66)) ([73593e2](https://github.com/knowttl/az-axi/commit/73593e21ba41813eb5de416a62c73c1d6761d960))
* add reviewed Azure CLI read passthrough ([#46](https://github.com/knowttl/az-axi/issues/46)) ([d02a973](https://github.com/knowttl/az-axi/commit/d02a9739a50f35a2a69c340e4f8cbe724856fbdf))
* add role definition and Defender plan and finding reads ([#62](https://github.com/knowttl/az-axi/issues/62)) ([4db3ca2](https://github.com/knowttl/az-axi/commit/4db3ca2e5df4fb304cf53788cadb7fcde88a6621))
* add Sentinel analytics rule and data connector reads ([#56](https://github.com/knowttl/az-axi/issues/56)) ([16c4a89](https://github.com/knowttl/az-axi/commit/16c4a89dac99dd9d9b2cf4c2df24434cc8c619fa))
* add Sentinel incident related alerts and entities ([#53](https://github.com/knowttl/az-axi/issues/53)) ([1f9368c](https://github.com/knowttl/az-axi/commit/1f9368c5028bfc629ce2146fe2383e98418d55d2))
* **network:** add guarded NSG deny rule creation ([#63](https://github.com/knowttl/az-axi/issues/63)) ([6c453eb](https://github.com/knowttl/az-axi/commit/6c453ebeb6b64aef59e6c7f02404bfff634c4394))


### Bug Fixes

* correct network full-view help and DNS examples ([#59](https://github.com/knowttl/az-axi/issues/59)) ([e30a94b](https://github.com/knowttl/az-axi/commit/e30a94b14dd56efe4b4a5314327a7c33f2e3a608))
* refresh Azure read catalogue and refuse metadata drift ([#64](https://github.com/knowttl/az-axi/issues/64)) ([7c7dce0](https://github.com/knowttl/az-axi/commit/7c7dce0fb075964cbdd24daeb1c88b21d0fc1d14))

## [0.1.2](https://github.com/knowttl/az-axi/compare/v0.1.1...v0.1.2) (2026-10-03)


### Features

* accept API JSON bodies from files and stdin ([#39](https://github.com/knowttl/az-axi/issues/39)) ([0c84d29](https://github.com/knowttl/az-axi/commit/0c84d29fa2aac7f7aed7ee5e19b7d4ef5bb415fc))
* add az-compatible command routing and flag parsing ([#41](https://github.com/knowttl/az-axi/issues/41)) ([f3938b5](https://github.com/knowttl/az-axi/commit/f3938b5076f82dae0eaad7ff7b9e05784ae39b0a))
* add az-style Graph and Log Analytics query paths ([#42](https://github.com/knowttl/az-axi/issues/42)) ([f14a693](https://github.com/knowttl/az-axi/commit/f14a693fdf1c2ed036d92a206d5a058fbdef03b8))

## [0.1.1](https://github.com/knowttl/az-axi/compare/v0.1.0...v0.1.1) (2026-10-03)


### Features

* add command leaf registry with explicit capability contracts ([#36](https://github.com/knowttl/az-axi/issues/36)) ([7e4467a](https://github.com/knowttl/az-axi/commit/7e4467a6ca6418cb1c4a3cbcec53e6626ad202aa))

## [Unreleased]

- `policy assignment|definition|set-definition list|show`, `policy state list`, `lock list|show` and `deny-assignment list|show`: read-only governance inventory using az's own command spellings; assignments, definitions and initiatives resolve from plain ARM GETs with compact defaults, full views on request and bounded lower-bound paging, while compliance states query the latest states through a reviewed bodyless read POST with compliance summaries; assignment, lock and deny-assignment mutations stay destructive under policy with no governance write command, and scans, summaries, exemptions and remediations stay out of scope.
- README: `Install`, `Use` and `Behavior` sections (install, one example per command, error codes and exit codes).
- `network nsg|nic|vnet|public-ip|private-endpoint list|show` and `network dns zone|record-set list|show`: read-only network inventory using az's own command spellings; NSG rules, VNet subnets and peerings, NIC IP configurations, public-IP associations, private-endpoint connection state and DNS records resolve from plain ARM GETs with compact defaults, full views on request and bounded lower-bound paging; effective rules and routes, Network Watcher diagnostics, DNSSEC keys, private DNS zones and any mutation stay out of scope.

- `sentinel incident list|show|list-alert|list-entity`: Sentinel incident triage on one Log Analytics workspace, including related alerts and entities through reviewed bodyless read POSTs.
- `sentinel alert-rule list|show` and `sentinel data-connector list|show`: read-only Sentinel analytics rules and data connectors on one Log Analytics workspace using az's own command spellings; compact by default, full on request; connector views project safelisted metadata only and never print secrets, keys or credential fields; no rule or connector mutation.
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
