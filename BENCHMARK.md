# Benchmark method

The harness compares pretty-printed REST JSON response bodies with the complete TOON stdout of the built az-axi CLI.
It uses the existing `gpt-tokenizer` development dependency with `o200k_base`; it adds no runtime dependencies or runtime capture switches.
Scenario results below are intentionally unfilled until the owner runs captures.

## Owner capture

Build with `pnpm install --frozen-lockfile` and `pnpm run build`.
Copy `benchmark/targets.example.json` to the gitignored `benchmark/targets.json` and enter a configured profile, one subscription GUID, one Log Analytics workspace customer GUID, and a nonempty `leakCheck` array of private organization names, domains, code names and other strings that must never survive scrubbing.
The profile must already be usable locally; this harness does not sign in or configure Azure access.
Only the owner runs `pnpm bench:capture`, which makes read-only Azure requests.
Agents and CI must never run capture or live smoke commands.

The owner capture/replay inventory and command arguments are defined by the `scenarios` export in [benchmark/scenarios.mjs](benchmark/scenarios.mjs).
The separate `offlineWritePreviews` export is measured only by [test/budget.test.ts](test/budget.test.ts), outside owner capture/replay.
The `offlinePassthroughReads` export is also measured only by that budget suite, using fake Azure CLI responses.
The fetch capture/replay transport cannot record or replay child-process reads.
Scenario argv contains no profile or subscription flags; capture injects the owner's selectors.
The logs workspace is supplied by targets rather than relying on an owner's workspace alias.
Optional `resourceGroup`, `resourceId` and `workspaceResourceId` targets select the group-show, resource-show and workspace-show captures.
`workspaceResourceId` is the full workspace ARM ID, distinct from the query workspace customer GUID.
Use a resource group name and a virtual machine ARM ID in the selected subscription; the VM scenario uses API version `2024-07-01`.
Unset targets skip those captures with a note, and replay skips their absent fixtures while retaining synthetic selectors for available captures.
Every child forces `AZ_AXI_READ_ONLY=1`.

The fetch preload keeps original responses and CLI output in memory only.
Before writing a fixture it applies the merged strict allowlist scrubber to every decoded JSON body and fails if any `leakCheck` string survives.
It also checks the serialized capture before writing.
Request URLs, request bodies, credentials and CLI stdout/stderr are never saved.
Response headers are omitted except for the numeric Retry-After value described below.
Only fixed method/host metadata, HTTP status and a numeric Retry-After value accompany scrubbed bodies.
No raw recording is written, even temporarily.
Non-JSON responses and failed scenarios produce a generic failure without printing private output.
Fixtures are owner-local, gitignored files with owner-only permissions where supported.
`benchmark/fixtures/`, `benchmark/raw/` and `benchmark/targets.json` must remain gitignored; never commit or upload recordings, even scrubbed.

## Offline replay

Run `pnpm bench` after owner captures exist.
Keep the matching `benchmark/targets.json` available so Sentinel replay can match its scrubbed workspace customer GUID and normalize that workspace in a temporary capture copy, including when no incidents were captured.
It launches each real CLI scenario under `node --import scripts/benchmark/fetch-hook.mjs` in replay mode.
Replay uses an isolated temporary token-mode profile with synthetic subscription/workspace identifiers and dummy ARM, Graph and Logs tokens, bypassing Azure CLI authentication.
For scoped account-list replay, a temporary copy aligns the first captured subscription's GUID and matching ARM ID with the synthetic selector across all captured pages.
This avoids display-name resolution, including duplicate names and capped pagination, while preserving production scope filtering and the persisted scrubbed capture.
It serves responses in fetch invocation order, checking method and public host; missing, mismatched, extra and unused responses fail the run, including errors swallowed by optional command enrichment.
Replay never calls the original fetch function and cannot fall back to live requests.
No request URL or body matching is performed because private request selectors differ in replay and the strict scrubber is not idempotent.
Use captures from the same CLI build; changes to scenario requests require fresh owner captures.
Temporary replay configuration is removed after success or failure.

The JSON baseline sums token counts of `JSON.stringify(body, null, 2)` for every captured response, including pagination and enrichment calls.
The TOON count includes the entire CLI stdout, including aggregates, count lines and hints.
Savings are `100 * (1 - TOON / JSON)`; negative savings are valid for small or empty responses.
These numbers measure both output selection and serialization, not an equivalent-schema encoding comparison.
Hashes from strict scrubbing can inflate token counts and change truncation, so these are reproducible scrubbed-data measurements rather than exact production costs.
Transport headers are excluded from the token baseline; numeric Retry-After seconds are replayed, while date-form Retry-After and other headers are omitted.
Recordings with behavior dependent on omitted headers require a new capture without that condition.

Use the following result format for each captured scenario in the [authoritative inventory](benchmark/scenarios.mjs).
Record skipped optional captures alongside the results.

| Scenario | REST JSON tokens | az-axi TOON tokens | Saved % |
|---|---:|---:|---:|
| Scenario name | Owner to fill | Owner to fill | Owner to fill |

## Skill and help surface

Run `pnpm bench:surface` after building.
It reads the real `skills/az-axi/SKILL.md`, counts its frontmatter including delimiters, body and complete file independently, then measures top-level help and every top-level command help through the built CLI.
The script writes `benchmark/tool-surface.json` and prints the same counts; it makes no Azure calls.
Token boundaries can make the complete skill count differ from the sum of its separately measured parts.
Help total is the sum of individual help invocations and does not imply every help page loads in each agent session.

See the generated [tool-surface.json](benchmark/tool-surface.json) for skill and help counts.

The owner should record CLI commit, Node version, capture date, tokenizer version and any empty or partial results alongside published numbers.
Only method documentation and reviewed result tables belong in this report; no captures or target identifiers belong here.
