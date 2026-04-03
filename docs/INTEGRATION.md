# Integration Guide — Real vs Stubbed Dependencies

This document tracks which external packages are published on their respective
registries and which are stubbed pending publication. Update it whenever a new
package lands or an integration is wired.

---

## npm / Node.js Packages

| Package | Pinned version | Registry latest | Status | Integration state |
|---------|---------------|-----------------|--------|-------------------|
| `ruvector` | 0.1.38 | 0.2.19 | **REAL** (published) | Stubbed — `HermesMemory` in `src/brain/ruvector.ts` wraps it but all method bodies are TODO |
| `ruflo` | 3.5.51 | 3.5.51 | **REAL** (published) | Stubbed — `HermesPlanner.rufloSpawnHive()` in `src/orchestration/planner.ts` and `SkillEvolution.spawnPermanentAgent()` in `src/skills/evolution.ts` are TODO |
| `@ruvector/sona` | 0.1.4 | 0.1.5 | **REAL** (published) | Stubbed — `SonaDaemon` in `src/brain/sona.ts` has all `@ruvector/sona` calls commented out as TODO |
| `@ruvector/ruvllm` | 2.5.4 | 2.5.4 | **REAL** (published) | Not yet imported anywhere — no source file uses it yet |

### Notes

- `ruvector` is **pinned to 0.1.38** but the latest is 0.2.19. Before wiring the
  real calls, run `npm update ruvector` (or pin to 0.2.x) and check the changelog
  for breaking API changes in `HermesMemory`.
- `@ruvector/sona` is one minor behind (0.1.4 → 0.1.5). Upgrade before wiring.

---

## Rust Crates

| Crate | Workspace version | crates.io status | Status | Integration state |
|-------|------------------|------------------|--------|-------------------|
| `ruvector-sona` | 0.1.9 | Not found on public crates.io | **UNCLEAR** — may be a private registry or version not yet published | Listed in `[workspace.dependencies]` but **not imported** in any `use` statement in `crates/skynet-runtime/src/lib.rs`. Build passes because the crate is declared but unused. |

### When `ruvector-sona` lands publicly

1. Verify `cargo search ruvector-sona` returns 0.1.9 (or update the version pin in
   `Cargo.toml` workspace block).
2. Add `use ruvector_sona::...;` imports in `crates/skynet-runtime/src/lib.rs`.
3. Replace the stub implementations of `gnn_update_weights()` and
   `ewc_record_step()` with real crate calls.
4. Run `cargo test --workspace` to confirm green.

---

## Files to Edit When Each Integration Lands

### `ruvector` (real calls in `HermesMemory`)

**File:** `src/brain/ruvector.ts`

Uncomment / replace each `// TODO: ...` block:
- `hybridSearch()` — call `ruvector.search({ vector, keyword, cypher, ... })`
- `store()` — call `ruvector.upsert(rvfContainer)`
- `updateGraph()` — call `ruvector.mergeEdges(edges)`
- `cypher()` — call `ruvector.cypher(query, params)`
- `upsertEmbedding()` — call `ruvector.upsertEmbedding(id, vector, metadata)`
- `storeSkill()` / `findSkills()` — call `ruvector.upsert` / `ruvector.search`

### `@ruvector/sona` (real calls in `SonaDaemon`)

**File:** `src/brain/sona.ts`

Replace TODO comment blocks in:
- `recordTrajectory()` — `POST /trajectory` or direct `sona.record()`
- `optimizeRouter()` — `sona.optimize({ trajectories, hyperparams, algorithm })`
- `updateGNN()` — `sona.updateGNN({ algorithm, epochs, learningRate })`
- `getRoutingRecommendation()` — `sona.recommend(task, context)`
- `autoTuneHyperparams()` — `sona.tune(hyperparams)`

### `ruflo` (real calls in planner + skill evolution)

**Files:**
- `src/orchestration/planner.ts` — `rufloSpawnHive()`: instantiate `RufloClient`,
  call `ruflo.spawnHive({ roles, task, budget })`
- `src/skills/evolution.ts` — `spawnPermanentAgent()`: call
  `ruflo.registerPermanentAgent({ role, skillPath })`

### `@ruvector/ruvllm` (not yet integrated)

No source file imports this package yet. When integrating:
1. Identify which component handles LLM inference (likely `src/brain/` or a new
   `src/llm/` module).
2. Import `@ruvector/ruvllm` there and wire it to the task execution path.

### `ruvector-sona` Rust crate (in `skynet-runtime`)

**File:** `crates/skynet-runtime/src/lib.rs`

Add `use ruvector_sona::...;` and wire:
- `gnn_update_weights()` — delegate to `ruvector_sona::gnn::update_weights()`
- `ewc_record_step()` — delegate to `ruvector_sona::ewc::record_step()`

---

## How to verify a package is published

```bash
# npm
npm info <package-name> 2>/dev/null | grep -E 'latest|description'

# cargo
cargo search <crate-name>
```
