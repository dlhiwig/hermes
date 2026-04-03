# Hermes Architecture

## What Is Hermes?

Hermes is the recursive self-learning meta-orchestrator that unifies the entire SWAI/SuperClaw stack into one closed-loop, self-improving system. It learns from every execution, spawns better sub-agents, refines its own governance, and evolves its architecture over time.

## Component Map

```
Hermes (Meta-Orchestrator)
├── RuVector + SONA (Brain + Self-Learning Memory)
│   ├── GNN Graph Store (vector + keyword + Cypher)
│   ├── EWC++ (anti-forgetting: Micro-LoRA rank 1-2 + Base LoRA rank 8)
│   ├── ReasoningBank (pattern distillation -> RVF skills)
│   └── 3-speed adaptation: <1ms / ~100ms / nightly
├── Orchestration Engine
│   ├── ruflo (Multi-Agent Hive-Mind + Byzantine consensus)
│   ├── deer-flow (SuperAgent Harness + Docker sandboxes)
│   └── VoltAgent (TypeScript Agents + Observability)
├── Structured Coding Layer
│   └── gstack (Plan -> Build -> QA -> Ship gates)
├── Runtime & Governance (NON-NEGOTIABLE)
│   ├── skynet-rust (Zero-copy GNN ops, Blake3 proofs)
│   └── SuperClaw (Step 2.5 pre + Step 7 post governance)
├── Interfaces
│   ├── Telegram (primary user channel)
│   ├── MCP + A2A (Alpha/Bravo/Charlie/VoltAgent)
│   └── SONA HTTP API (port 18804)
└── Recursive Output
    -> New RVF skills, evolved policies, permanent sub-agents
```

## Kill Switches (HARD-CODED)

| Switch | Value |
|--------|-------|
| MAX_RECURSION_DEPTH | 5 |
| MAX_CONCURRENT_AGENTS | 10 |
| SPEND_GATE_USD | $50 |
| MAX_LOOP_ITERATIONS_PER_HOUR | 1000 |

## Governance Position

SuperClaw runs at TWO mandatory checkpoints:
- Step 2.5 (pre-execution): BEFORE any executor runs
- Step 7 (post-execution): AFTER every trajectory, feeds into EWC++

## EWC++ Learning Loops

| Loop | Latency | Mechanism |
|------|---------|-----------|
| Instant | <1ms | Micro-LoRA + lightweight EWC++ penalty |
| Background | ~10-100ms | Online Fisher update + ReasoningBank |
| Deep | Nightly | Full EWC++ + Base LoRA + global GNN propagation |

## Measurable Self-Evolution

| Timeframe | Expected |
|-----------|----------|
| Week 1 | 15-25% token reduction, faster routing |
| Week 4 | New auto-generated skills appear |
| Month 2 | Swarm topology improves itself |
| Long-term | Hermes proposes own architecture changes |

## Jessie + Ledger First Pilot

Task: "Monthly spending summary + anomaly detection for B. Harris Financial"

1. RuVector pulls 30 days ledger + Jessie trajectories
2. gstack plans + ruflo/deer-flow spawn analyst + forecaster agents
3. SuperClaw: PII check + spend validation (GATE)
4. skynet-rust executes ledger query with Blake3 proof
5. SONA: "high accuracy on Food" -> strengthens routing weight
6. After 10+ runs: "MonthlyAnomalyDetector" RVF skill auto-created
7. SuperClaw: no PII leak -> positive reward into EWC++
8. Graph edge: financial-summary -> high-confidence -> Food-category

Next month: 40% faster, more accurate.
