# Edit tool reference (oh-my-pi)

## Correct usage pattern

### 1. Always read before you edit — on the exact lines you'll touch

Use a ranged read to display the lines you intend to modify. This mints a fresh snapshot tag and shows line numbers:

```
read path="src/foo.ts:50-60"
→ [src/foo.ts#A1B2]
→ 50:const old = thing();
→ 51:...
```

Then issue the edit anchored on that tag and those line numbers.

### 2. SWAP — replace lines N through M with new content

```
[src/foo.ts#A1B2]
SWAP 50.=51:
+const replaced = newThing();
+doMore();
```

- Range is INCLUSIVE on both ends: `50.=51` replaces lines 50 and 51.
- Body lists ONLY the new lines. Never restate keepers adjacent to the range.
- Body length doesn't matter — replacing 2 lines with 10 is still `SWAP 50.=51:`.

### 3. SWAP.BLK — replace a whole syntactic block

```
[src/foo.ts#A1B2]
SWAP.BLK 50:
+function foo() {
+    return "new";
+}
```

Anchors on the OPENING line of a multi-line construct (function, if, class, etc.). Tree-sitter resolves the closing line automatically.

### 4. DEL / DEL.BLK — delete lines or blocks

```
[src/foo.ts#A1B2]
DEL 50.=51          # delete lines 50-51
DEL.BLK 50          # delete the whole block starting at line 50
```

No body rows needed.

### 5. INS.PRE / INS.POST / INS.HEAD / INS.TAIL — pure insertions

```
[src/foo.ts#A1B2]
INS.PRE 50:         # insert before line 50
+// new comment
INS.POST 50:        # insert after line 50
+extra();
INS.HEAD:           # insert at file start
+#!/usr/bin/env node
INS.TAIL:           # insert at file end
+export default foo;
```

Never use a widened SWAP for a pure insertion — it retypes keepers and risks dropping lines.

### 6. Multiple non-adjacent changes = multiple hunks

```
[src/foo.ts#A1B2]
SWAP 10.=10:
+newLine10
SWAP 50.=52:
+replacement for 50-52
+two lines
INS.PRE 80:
+insert before 80
```

One edit call, multiple hunks. Untouched lines stay out of every range.

### 7. Re-read between edits

Every edit mints a fresh tag and renumbers. Your next edit MUST use the new tag and numbers. Do not chain edits from one snapshot.

---

## Failure modes

### F1. Stale-tag / line-not-displayed (most common)

```
This edit anchors to lines 366 of src/services/api/streamer.service.ts
that [src/services/api/streamer.service.ts#C3A8] never displayed
(it showed a partial range, a search hit, or a folded summary).
```

**Cause:** Previous `read` showed a structural summary with `..`/`…` elisions, or a search hit that didn't include the target line in `LINE:TEXT` form.

**Fix:** Ranged read on the exact line (`path:366`) to mint a fresh tag, then re-issue.

### F2. Line renumbering — edit lands on wrong line

Re-using old line numbers after a prior edit corrupts the file because the file renumbered.

**Example:** `SWAP 148.=148:` meant to replace `response.json()` but hit the wrong line 148 — the `return [...cache];` inside the cache-check block. This happened because a prior edit shifted lines and the old snapshot was stale.

**Fix:** Re-read the target area after EVERY edit. Never issue two edits from one snapshot.

### F3. Auto-repair — boundary echo

```
Auto-repaired a replacement boundary echo at line 214: dropped 1 trailing
payload line(s) identical to the surviving line(s) just below the range.
```

**Cause:** The replacement body included a line (usually a closing brace `}`) that already exists identically just outside the SWAP range. The tool auto-drops the duplicate.

**Fix:** Body should contain ONLY changed lines. Omit keepers adjacent to range boundaries.

### F4. Auto-repair — delimiter-balance mismatch

```
Auto-repaired a delimiter-balance mismatch in the replacement at line 276:
dropped 1 duplicated trailing payload line(s) already present below the range.
```

Same cause as F3 — restating a brace/line that survives outside the range.

### F5. Leftover orphaned lines

After `SWAP 95.=106:` on a method, lines 112-115 from the old implementation survived as orphans beyond the edited region.

**Cause:** The SWAP range was too narrow — the old method had trailing lines beyond line 106.

**Fix:** Make the range wide enough to cover the entire construct. After editing, `read` the surrounding lines to check for orphans, then `DEL` them.

### F6. Auto-repair drops a structural delimiter silently

Example: `SWAP 43.=53` on a method triggered auto-repair "delimiter-balance mismatch" — dropped the `}`
closing `if (!this.defaultInit) {` inside the new body. The `}` was treated as a duplicated trailing payload
line. The build caught it only on the *next* method (`Expected ";" but found "async"`), off-by-one.

**Cause:** Replacement body restated a closing brace that the tool matched against a surviving delimiter below
the range. F3/F4 auto-repair kicks in and drops the duplicate — but the surviving one is a DIFFERENT
delimiter (e.g. the method's `}` vs the `if`'s `}`).

**Fix:** After ANY auto-repair warning (F3 or F4), immediately re-read the edited area to verify all
structural delimiters are intact. Do not proceed to another edit or build from that snapshot.

### F7. SWAP lands on wrong method (same line numbers, different context)

Example: `SWAP 198.=200:` meant to replace `_fetchRecommendator`'s catch block but hit
`fetchMultiBroadcastStreamers`'s if-block instead. Both had code at lines 198-200 — different
methods, different blocks, identical line numbers. No error from the tool — just silent corruption.

**Cause:** The read snapshot shows `LINE:TEXT` for each line. The edit anchors on line numbers
without verifying the text matches. If a prior edit shifted lines, or two methods happen to have
similar structure at the same line numbers, the edit corrupts the wrong method.

**Fix:** Before issuing, verify at least the first and last lines of your SWAP range by reading
their `LINE:TEXT` output. Does line 198 actually say `} catch (error) {`? If not, your snapshot
is stale or you're targeting the wrong method.

### F8. SWAP range starts after old content — creates duplicate

Example: `SWAP 109.=115:` replaced `next()` in `app.controller.ts`, but the old `next()` was on
lines 105-108. The SWAP started at 109, leaving the old copy intact and inserting a new one below.
Result: two `private next` methods, duplicate declaration.

**Cause:** The read showed a structural summary with `..` elisions. Line 105 was hidden inside
a collapsed block. The edit targeted what was visible (109) without realizing the method started
earlier.

**Fix:** Always ranged-read the full construct you're replacing — from its opening line
(`private next = () => {`) to its closing `};`. Then SWAP from the opening line number,
not from the interior.

### F9. Multi-hunk edits interact unexpectedly with DEL

Example: `DEL 105.=108` and `SWAP 109.=115` issued in the same call. The DEL removes lines, shifting
everything below. The SWAP also uses original-for-this-snapshot line numbers. The result depends on
apply order — the tool may resolve both against the original state, or one after the other.

**Cause:** Multiple hunks in one call all anchor on the SAME original line numbers from the
snapshot. The tool's resolution order is deterministic but unintuitive — each hunk applies
independently to the snapshot state, not sequentially.

**Fix:** Use separate edit calls for non-independent changes (especially DEL + SWAP on adjacent

### F10. File changed between read and edit (hash mismatch)

```
Edit rejected for src/foo.ts: file changed between read and edit.
Section is bound to #AAAA, but the current file hashes to #BBBB.
```

**Cause:** A prior edit in the same session modified this file. The snapshot tag (#AAAA) from
the read is now stale — the file has a new hash (#BBBB).

**Fix:** Re-read the file with `read` to mint a fresh tag, then re-issue the edit. Never reuse
a tag from a prior edit's response — always use a fresh `read`.
