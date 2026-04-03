# Hermes — Morning SITREP

**Date**: 2026-04-03
**Build Status**: Clean (9/9 tests passing)

## What is Hermes?

Hermes is an 8-step recursive self-learning AI orchestration loop. It accepts tasks (via Telegram, API, or internal recursion), plans execution across multiple agent types (VoltAgent/Ollama, DeerFlow, Ruflo, Skynet-Rust), governs each step through SuperClaw proof gates, and feeds trajectory data back through SONA for continuous optimization and skill distillation.

## Phases Completed

| Phase | Description |
|-------|-------------|
| 0 | Initial scaffold — HermesLoop class, kill switches, core interfaces |
| 1 | LedgerSkill + Convoy SONA hooks + Superpowers skills + CLAUDE.md |
| 2 | ReasoningBank SKILL.md output + Rust `sona_record_trajectory` + ledger:run |
| 3 | Real planner + governance + SONA HTTP daemon + A2A bridge |
| 4 | Telegram bot + e2e tests + SONA HTTP live on :18805 + systemd units |
| 5 | main.ts entry point + live loop run + production README |
| 6 | Real skill evolution + SONA background flush loop + hermes.toml |
| 7 | Real RuVector memory + SuperClaw bridge + multi-turn demo |
| 8 | MCP server + gstack gate fix + .mcp.json |
| 9 | VoltAgent Ollama executor + CI integration test + badge |
| 10 | Error boundaries + metrics + SITREP (this phase) |

## Working vs Stubbed Matrix

| Component | Status | Notes |
|-----------|--------|-------|
| HermesLoop (8-step) | **Working** | Full pipeline with error boundaries + 30s step timeout |
| RuVector Memory | **Working** | Hybrid search (vector + keyword + graph) |
| SONA Daemon | **Working** | HTTP on :18805, trajectory recording, GNN update |
| SuperClaw Governance | **Working** | Pre/post execution checks, proof validation |
| Skill Evolution | **Working** | Auto-distills patterns into SKILL.md when threshold met |
| VoltAgent (Ollama) | **Working** | Requires local Ollama running; graceful fallback if down |
| MCP Server | **Working** | JSON-RPC 2.0 on :18806, tools/call + tools/list + /metrics |
| Metrics/Observability | **Working** | Counters, gauges, histogram; GET /metrics endpoint |
| Skynet-Rust FFI | **Stubbed** | Rust crate exists; napi-rs FFI not wired yet |
| DeerFlow Sub-agent | **Stubbed** | Recursion guard works; actual spawn is TODO |
| Ruflo Hive-mind | **Stubbed** | Dispatch logic is TODO |
| Telegram Bot | **Stubbed** | Bot scaffold exists; webhook handler needs deployment |
| Spend Gate (human-in-loop) | **Partial** | Kill switch works; Telegram notification is TODO |

## Live Endpoints

| Service | Port | Health Check |
|---------|------|-------------|
| SONA HTTP Daemon | 18805 | `curl http://127.0.0.1:18805/sona/stats` |
| RuVector Memory | 18803 | `curl http://127.0.0.1:18803/health` |
| MCP Server | 18806 | `curl http://127.0.0.1:18806/tools/list` |
| Metrics | 18806 | `curl http://127.0.0.1:18806/metrics` |

## Next Priorities (toward production-ready)

1. **Skynet-Rust FFI** — Wire napi-rs bindings so GNN ops run in Rust critical path
2. **DeerFlow / Ruflo execution** — Replace stubs with real sub-agent spawning
3. **Telegram webhook deployment** — Deploy bot handler, wire to Hermes loop
4. **Spend gate notification** — Human-in-the-loop approval via Telegram when cost > $50
5. **Persistent trajectory storage** — Currently in-memory; needs durable backend
6. **Production SONA LoRA** — EWC++ integration for anti-forgetting during fine-tuning
7. **CI hardening** — Integration tests for MCP server, metrics, error boundary paths

## Integration Dependencies

| Dependency | Package | Role |
|-----------|---------|------|
| SuperClaw | `@governance/superclaw` | Pre/post execution proof gates |
| Charlie | External service | Human escalation relay (Telegram) |
| Alpha | External service | Task submission API |
| ruflo | `ruflo@3.5.51` | Hive-mind agent pool |
| @ruvector/sona | `@ruvector/sona@0.1.4` | SonaEngine (trajectory tracking, GNN) |
| ruvector | `ruvector@0.1.38` | Vector memory backend |
| @ruvector/ruvllm | `@ruvector/ruvllm@2.5.4` | LLM routing integration |

## Known Issues

- VoltAgent tests require Ollama running locally; CI skips gracefully but no mock coverage
- SONA daemon port changed from 18804 to 18805 in Phase 4; some docs may reference old port
- `exactOptionalPropertyTypes: true` in tsconfig makes optional fields strict — watch for `undefined` vs missing
- Step 3 execution catch block now records a synthetic "execution-error" result; downstream consumers should handle this stepId
