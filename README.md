# Hermes

Hermes is a recursive self-learning orchestrator that routes tasks through an 8-step loop of retrieval, planning, governance, execution, optimization, and skill distillation. It combines a GNN-based routing optimizer (SONA), anti-forgetting mechanisms (EWC++), and automatic skill evolution to continuously improve its own task-solving capabilities while enforcing hard-coded safety kill switches.

## Architecture

```
                         ┌─────────────────┐
                         │   Telegram Bot   │
                         │  (Long-Polling)  │
                         └────────┬─────────┘
                                  │ HermesTask
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         HermesLoop (8 Steps)                         │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐ │
│  │ 1. Input │→ │ 2. Plan  │→ │ 2.5 Gov  │→ │ 3. Execution         │ │
│  │ Retrieval│  │ (gstack) │  │ Pre-Check│  │ VoltAgent│SkynetRust │ │
│  │ RuVector │  │ ruflo    │  │ SuperClaw│  │ DeerFlow │Ruflo      │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────────┘ │
│                                                      │               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────▼─────────────┐ │
│  │ 8. Conso-│← │ 7. Gov   │← │ 6. Skill │← │ 5. SONA             │ │
│  │ lidation │  │ Post-Rev │  │ Evolution│  │ Optimization         │ │
│  │ EWC++    │  │ SuperClaw│  │ RVF Dist │  │ GNN + Micro-LoRA     │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────────┘ │
│                                                                      │
│  ┌─────────────────────┐  ┌──────────────────────────────────────┐  │
│  │ 4. Observation      │  │  Trajectory → ReasoningBank          │  │
│  │ Trajectory Logging  │  │  Pattern distill → SKILL.md emit     │  │
│  └─────────────────────┘  └──────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
         │                          │                        │
         ▼                          ▼                        ▼
   ┌───────────┐            ┌──────────────┐         ┌─────────────┐
   │  RuVector  │            │ SONA Daemon  │         │ Rust Crates │
   │  Memory    │            │ :18805       │         │ skynet-rt   │
   │  (GNN)     │            │ GNN + EWC++  │         │ hermes-core │
   └───────────┘            └──────────────┘         └─────────────┘
```

## The 8 Steps

| Step | Name | Description |
|------|------|-------------|
| 1 | **Input & Retrieval** | Receive task, query RuVector hybrid search (vector + keyword + Cypher graph) |
| 2 | **Planning** | gstack gate checks, ruflo hive-mind spawn, deer-flow sub-agent decomposition |
| 2.5 | **Pre-Execution Governance** | SuperClaw PII detection, prompt injection scan, cost projection, capability proof |
| 3 | **Execution** | Dispatch to VoltAgent, SkynetRust (Blake3 proof), DeerFlow, Ruflo, or Internal |
| 4 | **Observation & Logging** | Form trajectory, compute reward signal (score, latency, cost efficiency) |
| 5 | **SONA Optimization** | Record trajectory, Micro-LoRA update, GNN routing table optimization (<1ms) |
| 6 | **Skill Evolution** | Pattern distillation via ReasoningBank; emit SKILL.md when success_rate > 85% |
| 7 | **Post-Execution Governance** | SuperClaw trajectory review, policy refinement, negative-reward Fisher lock |
| 8 | **Consolidation** | Deep EWC++ pass, RuVector graph edge writes, embedding updates |

## Kill Switches

Hard-coded safety limits that **cannot** be overridden at runtime:

| Switch | Value | Effect |
|--------|-------|--------|
| `MAX_RECURSION_DEPTH` | 5 | Rejects tasks exceeding recursion depth |
| `MAX_CONCURRENT_AGENTS` | 10 | Blocks new agent spawns at limit |
| `SPEND_GATE_USD` | $50 | Requires human approval above threshold |
| `MAX_LOOP_ITERATIONS_PER_HOUR` | 1000 | Rate-limits loop executions |

## Quick Start

```bash
# Clone and install
git clone <repo-url> hermes
cd hermes
npm install

# Build TypeScript
npm run build

# Run the ledger PoC (Phase 1 demo)
npm run ledger:run

# Run one full loop transaction
npm run loop:test

# Start the full daemon (Telegram + SONA + Loop)
npm run dev
```

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `tsx watch src/main.ts` | Full daemon with hot-reload |
| `build` | `tsc --project tsconfig.json` | Compile TypeScript to `dist/` |
| `start` | `node dist/main.js` | Run compiled build |
| `loop:run` | `tsx src/core/loop.ts` | Run loop module directly |
| `loop:test` | `tsx scripts/run-one-loop.ts` | Run one test transaction through the full loop |
| `sona:daemon` | `tsx src/brain/sona.ts` | SONA optimizer standalone |
| `ledger:run` | `tsx src/skills/ledger.ts` | Phase 1 ledger PoC |
| `test` | `vitest run` | Run test suite |

## Integration Points

| System | Role | Status |
|--------|------|--------|
| **SuperClaw** | Pre/post governance gates, PII detection, prompt injection scanning | Integrated (`:18800`) |
| **ruflo** | Multi-agent hive-mind orchestration, agent pool dispatch | Integrated (CLI) |
| **RuVector** | Hybrid vector/keyword/graph memory, embedding storage | Integrated |
| **SONA** | GNN routing optimizer, trajectory recording, EWC++ anti-forgetting | Integrated (`:18805`) |
| **Superpowers** | Skill framework (.claude/skills/), workflow enforcement | Active |
| **gstack** | Planning gates, engineering review integration | Integrated (planner) |
| **deer-flow** | Long-horizon sub-agent decomposition (Ollama fallback) | Integrated |
| **Telegram** | Primary user interface, task ingestion | Live |

## Rust Crates

| Crate | Purpose |
|-------|---------|
| `skynet-runtime` | Blake3 proofs, EWC++ integration, GNN ops (napi-rs FFI) |
| `hermes-core` | SONA HTTP daemon (Axum on `:18805`), trajectory + EWC endpoints |

Build with: `~/.cargo/bin/cargo check --workspace`

## Project Structure

```
src/
  core/           loop.ts, reasoning-bank.ts, sona-adapter.ts
  brain/          sona.ts, ewc.ts, ruvector.ts
  orchestration/  planner.ts
  governance/     superclaw.ts
  interfaces/     telegram.ts
  skills/         evolution.ts, ledger.ts
  bridge/         mcp.ts
  __tests__/      loop.smoke.test.ts
scripts/          run-one-loop.ts
crates/           skynet-runtime/, hermes-core/
config/           Runtime configuration
data/             Governance audit logs, test trajectories
```

## Current Status

**Phase 5 complete.** The 8-step recursive loop runs end-to-end with:

- Full loop orchestration with kill switch enforcement
- SONA GNN optimization with Micro-LoRA and EWC++ anti-forgetting
- SuperClaw pre/post governance gates (PII, prompt injection, cost projection)
- Planner integration (gstack gates, ruflo swarm, deer-flow decomposition)
- Skill evolution with ReasoningBank distillation and SKILL.md emission
- Telegram bot interface with long-polling task ingestion
- SONA HTTP daemon on port 18805
- Rust crates for critical-path ops (Blake3 proofs, EWC++, GNN)
- Graceful shutdown (SIGINT/SIGTERM)

**Stubbed / TODO:**
- RuVector hybrid search (Step 1 returns empty results)
- Executor implementations (VoltAgent, SkynetRust FFI, DeerFlow, Ruflo dispatch)
- Real cost tracking in execution results
- Human escalation notification via Telegram
- Napi-rs FFI bridge to Rust crates
- Production SONA GNN training (Q-Learning/PPO/SARSA)

## Docs

- [Architecture](docs/ARCHITECTURE.md) — Component map, integration seams, EWC++ system
- [The Loop](docs/LOOP.md) — Full 8-step documentation with pseudocode

## Roadmap

1. **Phase 6** — Wire RuVector hybrid search (vector + keyword + Cypher) into Step 1
2. **Phase 7** — Napi-rs FFI bridge to `skynet-runtime` for real Blake3 proofs
3. **Phase 8** — Production executor implementations (VoltAgent workers, ruflo CLI dispatch)
4. **Phase 9** — Real SONA GNN training with PPO/SARSA algorithms
5. **Phase 10** — Multi-tenant API gateway, rate limiting, authentication
