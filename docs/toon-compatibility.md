# TOON 2.3.1 to 4.4.0 output review

This review covers the dependency update in https://github.com/knowttl/az-axi/pull/89.
It uses synthetic data and offline service fakes only.
The dependency commit is reused from that pull request on main at `4838a04`.

## Retained corpus and method

`test/toonCompatibility.test.ts` exercises seven encoder cases and seven built entry-point cases.
The encoder corpus covers primitive tables, nested records, empty arrays, escaping, multiline values, error envelopes and redaction.
The entry-point corpus covers a subscription table, nested API response with redaction, empty subscription list, service error, usage error, configured session hook and hook usage error.
Every entry-point case checks stdout, empty stderr and the exit code.
Service calls are replaced by synthetic responses; no Azure credentials or services are used.
Only the package version line is normalized to `<version>` to keep the hook snapshot stable across releases.

The baseline snapshots were captured with TOON 2.3.1 in commit `f9e89bf` before applying the existing dependency commit.
The updated snapshots in `test/__snapshots__/toonCompatibility.test.ts.snap` retain the reviewed 4.4.0 output.
Comparing those snapshots yields exactly the two differences below; the other twelve snapshots are byte-identical, including final newlines.
The updated encoder corpus also verifies that decoding each encoded result preserves its redacted input data.

To rerun the current corpus after `pnpm install --frozen-lockfile` and `pnpm build`:

```sh
pnpm test test/toonCompatibility.test.ts
```

To inspect the complete old and new serialized outputs:

```sh
git show f9e89bf:test/__snapshots__/toonCompatibility.test.ts.snap
git diff f9e89bf -- test/__snapshots__/toonCompatibility.test.ts.snap
```

## Exact output differences

Nested rows now use a nested table header instead of list records:

```diff
-rows[2]:
-  - name: a
-    nested:
-      count: 2
-  - name: b
-    nested:
-      count: 0
+rows[2]{name,nested{count}}:
+  a,2
+  b,0
```

The escaping array changes the quoting of `# comment` and a BOM-prefixed string:

```diff
-values[13]: "a,b","say \"hello\"","C:\\demo","a:b","[item]","true","001",""," leading","trailing ",# comment,"---","﻿start"
+values[13]: "a,b","say \"hello\"","C:\\demo","a:b","[item]","true","001",""," leading","trailing ","# comment","---",﻿start
```

The invisible character immediately before `start` on both lines is U+FEFF.
Its bytes are preserved; only its surrounding quotes change in this array context.
Commas, quotes, backslashes, colons, brackets, numeric-looking strings, empty strings, surrounding spaces and multiline escapes otherwise remain unchanged in this corpus.

## Assessment and boundary

The nested header is a wire-format change, even though decoding with 4.4.0 preserves the same record structure and values.
Consumers of direct 4.4.0 encoder output must support that syntax rather than assuming the old list layout.
The quoting changes also preserve the tested string values with the 4.4.0 decoder.
No redacted value reappears, and no tested error or exit-code behavior changes.

`pnpm why @toon-format/toon` confirms two installed versions after the update.
The direct dependency is 4.4.0, used by the hook and custom CLI error renderers.
`axi-sdk-js` 0.1.13 still depends on 2.3.1 and renders successful CLI results with that version.
Therefore this update does not migrate every successful CLI response to the newer syntax.
All seven built CLI/hook corpus outputs remain byte-identical; unchanged CLI output alone would not establish encoder compatibility.

Recommendation: accept this dependency update with the reviewed golden changes.
The offline corpus finds no regression in the exercised application boundaries, but does not establish byte compatibility for arbitrary data or compatibility with a 2.x-only external decoder.
Changing the SDK dependency or unifying rendering is outside this review.

## Validation

On 2.3.1: build, typecheck, lint and skill check passed; the offline suite passed 88 files and 3389 tests, including the fourteen output captures.
On 4.4.0: build, typecheck, lint and skill check passed.
The offline suite passed 88 files and 3396 tests, including all fourteen output captures and seven semantic round-trip checks.
The first corpus run against the old goldens failed exactly the nested-record and escaping cases; the other twelve outputs passed unchanged.
The reviewed goldens and seven semantic round-trip checks are tested by the current offline suite.
Validation used Node.js 24.14.0 and pnpm 10.34.6.
