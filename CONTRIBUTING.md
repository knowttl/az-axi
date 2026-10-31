# Contributing

Use Node.js 22.12 or later and the pnpm version declared in `package.json`.
Keep changes focused and describe the problem, resulting behavior and validation in the pull request.
Use conventional commit titles.

## Local validation

From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm skill:check
node dist/bin/az-axi.js --help
```

`lint` and `typecheck` both run TypeScript without emitting files; no separate style linter is configured.
The local validation gate does not require GitHub test CI (`no_ci: true`).
The test suite uses offline fakes and synthetic fixtures, with discovery limited to `test/` so nested checkouts are not run.
Packaged CLI tests reuse the local pnpm store and cache, fetching missing dependencies or registry metadata from the public npm registry when needed.
Set `AZ_AXI_TEST_PNPM_STORE` and `AZ_AXI_TEST_PNPM_CACHE` to empty directories to verify a cold install.
The isolated runner resolves cached pnpm before replacing HOME and disables Corepack downloads; packaged installs use `--prefer-offline` with isolated npm configuration.
CLI requests to Azure still use offline fakes.
Vitest's default filename patterns and exclusions remain in effect within that directory.
The identifier guard rejects tenant identifiers and private domains in repository text.
Use synthetic identifiers and example domains when adding tests or documentation.

Canonical source: knowttl/bstack revision feeccb1e6f1ae119bf4c74277c8bad328b05afe8, skills/verification/references/testing.md.
<!-- BEGIN canonical test-quality rules -->
**Test quality.** Write and review every test against these rules.
Tests are never required first; a change is verified end to end against the behaviour the user expects.

1. Trust upstream invariants: do not test states that types, schemas or database constraints already rule out.
   Test invalid input only at the boundary that validates it.
2. Assert outcomes from an agreed source (spec, domain rule, ground-truth fixture), never values copied from what the code returns today.
3. Mock only true external boundaries, with schema-valid or recorded payloads.
   Never mock in-process code.
   Delete tests that only check how a mock was set up or called, unless that call is the requirement.
4. Test through the public interface: no private helpers, internal state or internal call counts.
5. Every assertion must be able to fail when the behaviour breaks: no existence-, type- or constant-only assertions.

Exempt: validation-boundary tests, contract tests against an agreed schema or recording, and regression tests that cite the bug they reproduce.
<!-- END canonical test-quality rules -->

The packaged skill is generated from [src/lib/skill.ts](src/lib/skill.ts) and the [leaf registry](src/lib/registry.ts).
Run `pnpm skill:generate` when changing that surface, then `pnpm skill:check` to check drift in the skill and the exact command table in [docs/commands.md](docs/commands.md#exact-command-reference).
`pnpm catalogue:generate` and `pnpm catalogue:check` maintain the pinned read catalogue from reviewed source snapshots without Azure access.
New passthrough commands require explicit provenance and code review; generation never discovers or promotes commands dynamically.
The README introduces implemented behavior; linked docs and leaf help provide the detailed reference.
Historical [design](https://github.com/knowttl/az-axi/blob/archive/internal-docs/PLAN.md) and [benchmark notes](https://github.com/knowttl/az-axi/blob/archive/internal-docs/BENCHMARK.md) are retained for reference and may contain superseded claims.
Session hooks, Key Vault metadata reads and Sentinel incident management are implemented; they are not deferred features.

## Benchmarks

Build first, then use `pnpm bench:surface` for offline skill and help token counts.
`pnpm bench` replays existing local captures without live requests.
The harness and source scripts are not packaged with the CLI.
The scenario inventory is [benchmark/scenarios.mjs](benchmark/scenarios.mjs); synthetic budget and harness tests run as part of `pnpm test`.

Only the owner runs `pnpm bench:capture`, which makes read-only Azure requests.
Agents and CI must never run capture or live-smoke commands.
For owner capture, copy `benchmark/targets.example.json` to the gitignored `benchmark/targets.json` and configure a usable profile, subscription, workspace customer GUID and nonempty `leakCheck` list of private strings.
Optional resource selectors and the full capture method are described in the archived benchmark notes.
Every capture child forces `AZ_AXI_READ_ONLY=1`.
The capture preload applies the strict allowlist scrubber to decoded responses and checks both scrubbed data and serialized output against `leakCheck` before writing.
Request URLs, bodies, credentials, CLI output and raw responses must never be saved.
Targets, `benchmark/fixtures/`, `benchmark/raw/` and results stay local and gitignored; never commit or upload recordings, even scrubbed.

Replay requires matching captures and targets from the same CLI build.
It uses a temporary token profile, dummy tokens and synthetic selectors, and fails on missing, mismatched, extra or unused responses without falling back to live fetch.
Token measurements compare complete TOON stdout with pretty-printed REST response bodies using `gpt-tokenizer` and `o200k_base`.
They measure output selection as well as encoding; scrubbing can affect counts, so they do not establish a fixed production saving.
Record the CLI commit, Node and tokenizer versions, capture date, and skipped or partial scenarios with any reported measurements.

## Live smoke checks

Only the owner runs [scripts/live-smoke.mjs](scripts/live-smoke.mjs) against explicitly selected sandbox resources.
Ordinary local validation uses synthetic Azure responses, including tests of the smoke-check logic, without Azure service calls.
Live reads use the owner's existing Azure sign-in or token profile.
Writes additionally require `--writes --subscription <id> --resource-group <name>` and the normal profile write gates.
Write checks modify sandbox tags and leave the test tag in place.
The optional deletion check requires `--delete-storage-account <pre-created-throwaway-name>` and destroys that account.
The smoke script writes a summary to the OS temporary directory without response bodies.
Review [SECURITY.md](SECURITY.md) before sharing diagnostics.

## Releases

The staging package `@knowttl/az-axi@0.0.0-stage` is retired and unsupported.
Use a supported release from the [npm package page](https://www.npmjs.com/package/@knowttl/az-axi) or [GitHub releases](https://github.com/knowttl/az-axi/releases).
Install the current release with `npm install -g @knowttl/az-axi@latest`, or run it with `npx -y @knowttl/az-axi@latest`.
Replace any dependency or automation pin to `0.0.0-stage` with a supported release version.

Retire staging versions with an npm deprecation notice directing users to supported releases.
Do not unpublish or attempt to recreate retired versions.
Registry deprecation is a separate maintainer operation; this policy does not assert that the live registry notice has been applied.

Conventional commits on `main` produce a release-please PR with the version and generated changelog changes.
Merging a release PR creates its tag and GitHub release, then builds, typechecks and tests that tag and publishes it to npm with OIDC provenance unless the version is already published.
Release validation is separate from the local gate's GitHub test-CI policy.
Do not hand-edit `CHANGELOG.md`; release-please owns it and GitHub release notes.
To extract a changelog section locally, run `node scripts/release-notes.mjs v<version>`.
