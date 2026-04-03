# Changelog

All notable changes to Hermes are documented in this file.

## [0.2.0] - 2026-04-03

### Added
- Phase 0-11 complete: Full 8-step recursive self-learning orchestrator
- SONA HTTP daemon on port 18805 (Rust/axum)
- RuVector GNN memory integration (Qdrant-compatible, port 18803)
- ruflo v3.5.51 swarm coordination (real CLI spawn)
- VoltAgent Ollama executor (5 roles, qwen3.5 + dolphin-llama3)
- SuperClaw governance bridge (SHA-256 proofs, audit log)
- Superpowers 14-skill integration (.claude/skills)
- ReasoningBank SKILL.md auto-generation (Superpowers format)
- MCP server (port 18806, 5 tools including /metrics)
- Telegram bot interface (/hermes, /hermes-status)
- Always-on mode (--always-on flag)
- Multi-turn demo (--mock, --fast flags)
- Per-step error boundaries with 30s timeout
- Metrics/observability layer
- 9/9 tests passing

## [0.1.0] - 2026-04-03 (initial)

### Added
- Phase 0 scaffold: 8-step loop, EWC++, SONA daemon, governance stubs
