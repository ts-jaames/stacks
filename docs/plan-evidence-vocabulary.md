# Plan: positioning Assumption and Slice in the lineage graph

**Status:** design sketch, no implementation.
**Scope:** where `Assumption` and `Slice` sit structurally. Deliberately excludes Risk, Decision, and Confidence.
**Decided already:** `signal` was added to `sourceTypes` in `fieldbook/config/catalog.json`. Signals are observations, and Sources are propagation origins, so a Signal arriving and reverberating downstream is behaviour the system already has.

---

## 1. Why this needs a decision rather than a catalog entry

The existing spine is **retrospective**. `Source → Synthesis → Artifact` flows one way, from evidence already captured toward conclusions drawn from it. The only edge the system ever actually writes is `derived_from` (`app/lib/lineage/walker.ts:119`, `:153`).

The evidence vocabulary is **prospective**. You state a claim, design a test, and the evidence arrives afterwards:

```
Assumption --tested_by--> Slice --produces--> Signal --confirms/refutes--> Assumption
```

Slice sits exactly where the arrow reverses. That is the whole problem, and it produces two hard blockers:

**Blocker A — `Source` has no upstream pointer.** `Source` (`app/lib/db/types.ts:126-143`) has no `derivedFrom` field at all. A Source can never declare provenance. So Signal-as-Source structurally cannot record "I was produced by Slice X."

**Blocker B — the walker de-dupes edges on `from→to` and ignores `rel`** (`walker.ts:203-207`). `LineageEdge.rel` declares `derived_from | informed_by | supersedes` but only `derived_from` is ever emitted. A distinct `tested_by` edge between an Assumption and a Slice would be **silently dropped** if a `derived_from` edge already joined that pair.

Both options below must confront A. Neither fixes B on its own.

---

## 2. Option 1 — a fourth node kind

Assumption and Slice become first-class node kinds with their own `Fieldbook` arrays, governance functions, and propagation stage.

### Cost against `governance.ts`

| # | Touch point | Cost |
|---|---|---|
| 1 | **Create path** — new `guardedCreateAssumption` / `guardedCreateSlice` mirroring `:141-220`, plus `dbCreate*` functions imported at `:14-24` | Mechanical, ~40 lines each |
| 2 | **Update path** — mirroring the user-edits-in-place / agent-creates-new-version fork at `:238-404` | ~50 lines each |
| 3 | **The hand-copy liability** — each agent-version branch hand-copies every field (`:267-277` Source, `:323-332` Synthesis, `:378-387` Artifact) | Already a latent bug source: any field added to a node type and *not* added to its version-copy is **silently dropped on agent edit**. Two new kinds = two more copies to keep in sync forever |
| 4 | **`guardedUpdateMetadata` node resolution** (`:489-541`) — the three-array scan at `:511-517` derives `nodeType`; the dispatch at `:520-526` picks the db writer | Must extend both. **Miss it and `status`/`visibility`/`tags`/`owner` can never be set on an Assumption** — fatal, since an Assumption's entire purpose is carrying a state |
| 5 | **`proposeRecalibration`** (`:430-472`) — types `nodeType: "synthesis" \| "artifact"` at `:414`, resolves only those two at `:443-448` | Needs widening — **but see below, this is not merely a branch** |
| 6 | `enforceSemanticRules` (`:50-71`) | **Free.** Field-level, not node-level |

**The non-mechanical part of #5.** `proposeRecalibration` proposes a *content rewrite*. What an agent should propose about an Assumption is a **state transition** (`under_test → invalidated`) justified by a Signal. That governance verb does not exist. Option 1 therefore needs a genuinely new primitive — call it `proposeStateTransition` — not an extra `||` in a lookup.

It also needs new `MovementEventType` members (`movement/types.ts:8-16`, a closed union of 8). Note that vocabulary is *already* strained: `guardedUpdateMetadata` emits `"node_created"` for a metadata update (`governance.ts:529`), which is simply wrong. Adding state transitions on top of that without extending the union makes the movement feed actively misleading.

### Cost against `reverberation.ts`

| # | Touch point | Cost |
|---|---|---|
| 1 | Mutable copy in `propagateFromSource` (`:281-287`) | Clone the new arrays |
| 2 | A new propagation stage alongside `:319` (syntheses) and `:367` (artifacts) | One new ~45-line stage with its own token path and decay |
| 3 | **The pairwise cascade check** — the artifact stage at `:367-380` tests `informedBy` against the source *or* against `affectedSynthesisSet` (`:368`) | **This is the real structural cost.** `propagateFromSource` is a fixed linear pass, not a graph walk. Each new tier must be added to the cascade check of *every* downstream tier. Three kinds needs 3 pairwise checks; five kinds needs 10. Hand-written, and wrong silently |
| 4 | `PropagationResult` (`:121-126`) | New `updatedAssumptionIds` etc., and every caller must handle them |
| 5 | `markCalibrated` (`:433`), `markIdle` (`:452`), `initializeRenderedContent` (`:471`), `updateFact` (`:519`) | **All four hardcode exactly three arrays.** Each needs a new branch. `updateFact` is worst: three near-identical 20-line map blocks, so a fourth and fifth are pure copy-paste |

### Collateral

- **All five lineage adapters** re-normalise `informedBy → derivedFrom` by hand: `api/v2/.../lineage/[nodeId]/route.ts:38`, `api/v2/.../compile/route.ts:46`, `mcp/tools/read.ts:59`, `mcp/tools/compile.ts:55`, and `api/v2/.../lineage/route.ts:23-38` (which builds edges separately). A new kind missing from any one of them **silently vanishes from lineage in that surface only** — the worst failure mode, because the other four still work.
- `compileLineage` summary counts (`app/lib/compile/lineage.ts:96-101`) lump unknown types into `other` — degrades gracefully, but new kinds are invisible in summaries.
- The propagate route hardcodes `"synthesis" | "artifact"` in `generateAISuggestion` (`api/db/fieldbooks/[id]/propagate/route.ts:38`) and in two near-duplicate suggestion blocks (`:208-241`). Needs a third.
- `CreateFieldbook` (`db/types.ts:272`) and `UpdateFieldbook` (`:285`) both hardcode their `Omit` lists. **New arrays not added to both become settable through the fieldbook update endpoint, bypassing governance entirely.** Easy to miss, and it is a governance hole rather than a bug.

### Verdict

Expensive and repetitive — roughly 6 touch points in `governance.ts`, 5 in `reverberation.ts`, 5 lineage adapters, plus db CRUD, two `Omit` lists, the propagate route, and UI panels. It also *worsens* the pairwise cascade problem (#3 above).

But it is the **only option that models the domain honestly**: a distinct `tested_by` relation, and an Assumption carrying an epistemic state without overloading `status`.

---

## 3. Option 2 — add `derivedFrom` to `Source`

One optional field on `Source`. Assumption becomes a `synthesisType`; Slice becomes a Source (an activity record) and Signal a Source deriving from it. Source→Source edges become legal, and `Source` stops being a pure propagation origin.

### Cost against `governance.ts`

| # | Touch point | Cost |
|---|---|---|
| 1 | **`guardedUpdateSource` agent-version copy** (`:267-277`) hand-copies fields and would not include `derivedFrom` | One line — but **omit it and an agent editing a Signal silently orphans it from the Slice that produced it.** Invisible until someone inspects lineage |
| 2 | **`guardedUpdateSource` signature** (`:241`) is `Partial<Pick<Source, "title" \| "content" \| "url" \| "note">>` | `derivedFrom` is not editable through governance at all, unlike `guardedUpdateSynthesis` which permits it (`:299`). Needs widening |
| 3 | `guardedUpdateMetadata` (`:489-541`) | **Free.** Sources are already resolved and dispatched |
| 4 | `proposeRecalibration` (`:443-448`) still excludes sources | Same primitive gap as Option 1 — a Signal whose Slice changed cannot be proposed for recalibration. **Deferrable**, unlike Option 1 where it is load-bearing |
| 5 | `enforceSemanticRules` | **Free** |

**Governance cost ≈ two small edits plus one deferred gap.** Materially cheaper than Option 1.

### Cost against `reverberation.ts` — where this option actually bites

`propagateFromSource` has one assumption baked into its name and its shape: **the source is the origin.** Stage 1 (`:289-317`) only re-renders the source's *own* tokens. Nothing ever propagates *into* a Source.

| # | Problem | Severity |
|---|---|---|
| 1 | **Source→Source propagation does not exist.** Editing Slice-as-Source would not touch the Signals derived from it | Needs a new stage *before* `:319` that walks sources deriving from `sourceId` |
| 2 | **That stage cannot be a single pass.** Sources could chain arbitrarily (Slice → Signal → derived Signal), so it must **iterate to a fixpoint** | Converts a 3-stage linear pass into a graph traversal, in a function with no traversal machinery |
| 3 | **No cycle detection.** The walker has visited-sets (`walker.ts:106-107`); `propagateFromSource` has **none** — it does not need any today because the three tiers are acyclic *by construction* | Source→Source edges make cycles representable (A⇄B). A recursive source stage would **infinitely loop**. Cycle-safety must be imported into `reverberation.ts` |
| 4 | The synthesis check `synthesis.derivedFrom?.includes(sourceId)` (`:321`) must become "includes the source **or any transitively affected source**", and the cascade at `:368` needs an `affectedSourceSet` | Same pairwise problem as Option 1, now with transitivity |
| 5 | **`buildSourceChangeDiff` (`:157-215`) needs a second entry path.** `prevSourceContent` is caller-supplied — it comes from the request body (`propagate/route.ts:145`) because a human typed the edit. A Source that changed *because its upstream Slice changed* has no such caller-supplied prior content | The diff/banner machinery has no story for this |
| 6 | `markCalibrated`, `markIdle`, `initializeRenderedContent`, `updateFact` | **All free** — they already iterate sources. This is Option 2's genuine win |

### Collateral

- **All five lineage adapters work unchanged** — the walker already reads `derivedFrom`, and Sources would now simply have it. Big win over Option 1.
- No `Fieldbook` array changes, so both `Omit` lists (`db/types.ts:272`, `:285`) are untouched. No governance hole.
- `compileLineage` summary still counts correctly (Slice and Signal are both `source`).
- The `tested_by` relation is **not** expressible — an Assumption→Slice link would be just another `derived_from`, and Blocker B means it collides. Provenance becomes representable; *semantics* do not.

### Verdict

Cheap at the type, governance, and lineage layers; **expensive and risky in exactly one place** — it silently converts `propagateFromSource` from a linear pass into a cycle-prone graph traversal. Items 2 and 3 are not incremental work; they are a rewrite of that function's core.

---

## 4. Head to head

| | Option 1: fourth kind | Option 2: `derivedFrom` on Source |
|---|---|---|
| `governance.ts` | 6 touch points, incl. a **new primitive** | 2 small edits + 1 deferred gap |
| `reverberation.ts` | 5 touch points, all mechanical; worsens pairwise cascade | 1 touch point, but it is a **core rewrite** (fixpoint + cycle detection) |
| 5 lineage adapters | All five, per kind | **Free** |
| `Omit` lists / governance hole | Must extend both, or bypass | **Free** |
| Propagate route | Third suggestion block | Generalise the source path |
| Models `tested_by` | **Yes** | No — collides via Blocker B |
| Epistemic state without overloading `status` | **Yes** | No — inherits `synthesisType` + `status` |
| Cycle risk | None (acyclic by construction) | **Introduces it** |
| Failure mode if done wrong | Node vanishes from *one* lineage surface | Propagation **infinite-loops**, or provenance silently orphaned on agent edit |

---

## 5. Recommendation

**Neither, yet — and not because of cost.** Both options are blocked on the same two missing pieces, and doing either first means building on sand:

1. **No epistemic status axis.** `statuses` is `draft/proposed/canonical/superseded` — a *publication* lifecycle. Assumption needs `under_test / validated / invalidated`, which is orthogonal. Note also that every existing `synthesisType` (`pattern`, `theme`, `insight`) denotes a *settled* reading, whereas an Assumption is definitionally unsettled. Under Option 2 an Assumption would be a Synthesis whose status can only say whether it has been *published*, never whether it has been *borne out*. That is the wrong axis, and no amount of adapter plumbing fixes it.
2. **Blocker B (edge `rel` ignored in de-dup).** Until the walker de-dupes on `from→to→rel`, no new relationship kind is expressible under *either* option. This is a small, isolated, independently useful fix.

**Sequence:** fix Blocker B → add the epistemic status axis → *then* choose. Both prerequisites are cheap, independently valuable, and they change the comparison: with a real state axis, Option 2's "inherits `synthesisType` + `status`" objection largely dissolves, which would make it the clear winner on cost.

**If forced to choose today:** Option 1, despite costing several times more. Option 2's cheapness is concentrated in the layers that are easy to change anyway (types, adapters), while its one expensive item is a cycle-prone rewrite of the single function that every downstream banner and confidence score depends on. Option 1's costs are tedious but *local and visible*; Option 2's are subtle and load-bearing. A missing adapter shows up as a node absent from one view. A missing visited-set shows up as a hung request.

---

## 6. Follow-up debt noted (no action proposed)

- **`isValid*Type` validators are dead code.** `isValidSourceType`, `isValidSynthesisType`, `isValidArtifactType`, `isValidStatus`, `isValidVisibility` (`app/lib/catalog.ts:46-64`) are never called anywhere in `app/` or `mcp/`. `catalog.json` is dropdown vocabulary plus `/api/v2/catalog` disclosure; it enforces nothing.
- **The type enums are hand-duplicated.** `SourceType`, `SynthesisType`, `ArtifactType` (`app/lib/db/types.ts:15-17`) restate `catalog.json` verbatim, and `catalog.ts:5-6` claims enums extend "without code changes" — untrue at any use site that is not a cast. Adding `signal` to the catalog alone works only because every use site casts (`catalog.ts:36`) and nothing switches exhaustively on `SourceType`; the union is now knowingly incomplete.
- **`Catalog` omits `tags`.** The interface (`catalog.ts:22-28`) does not declare the `tags` key that `catalog.json` ships, so `catalog.tags` is unreachable through the typed export.
