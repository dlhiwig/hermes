# 🧠 Hermes — Recursive Self-Learning Meta-Orchestrator

Hermes is the unified brain that turns your entire SWAI/SuperClaw stack into one closed-loop, self-improving system. It learns from every task execution, spawns better sub-agents, refines its own governance, and evolves its architecture over time.

## What It Does

Every task Hermes handles makes it measurably better at the next one. No manual tuning required.

```
Task → [RuVector retrieval] → [gstack plan] → [SuperClaw ✅] → [Swarm execution]
     → [Trajectory capture] → [SONA GNN update] → [Skill distillation]
     → [SuperClaw post-review] → [Memory consolidation] → Better next time
```

## Components

| Component | Role |
|-----------|------|
| RuVector + SONA | Self-learning GNN brain — stores trajectories, optimizes routing |
| EWC++ | Anti-forgetting — learns new patterns without erasing old ones |
| ReasoningBank | Distills successful patterns into reusable RVF skills automatically |
| ruflo | Multi-agent hive-mind orchestration (ex-Claude Flow) |
| deer-flow | SuperAgent harness for long-horizon sub-agent spawning |
| VoltAgent | TypeScript agents + observability layer |
| gstack | Structured Claude Code workflow (plan → build → QA → ship) |
| skynet-rust | Performance-critical Rust paths + Blake3 capability proofs |
| SuperClaw | Governance: pre-execution + post-execution proof gates |

## Quick Start

```bash
# Install dependencies
npm install

# Initialize RuVector + SONA
npx ruvector init --with-sona

# Start SONA daemon (port 18804)
npm run sona:daemon

# Run the loop (development)
npm run dev
```

## Kill Switches (Hard-Coded)

These cannot be changed at runtime. They are constants in `src/core/loop.ts`:

- `MAX_RECURSION_DEPTH = 5`
- `MAX_CONCURRENT_AGENTS = 10`
- `SPEND_GATE_USD = $50` (human approval required above this)
- `MAX_LOOP_ITERATIONS_PER_HOUR = 1000`

## Docs

- [Architecture](docs/ARCHITECTURE.md) — Component map, integration seams, EWC++ system
- [The Loop](docs/LOOP.md) — Full 8-step documentation with pseudocode
