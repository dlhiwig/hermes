# Hermes — Claude Code Configuration

## Superpowers Skills

Hermes uses the Superpowers workflow framework. Skills live in `.claude/skills/superpowers/skills/`.
Before any non-trivial task, check for a relevant skill and follow it as a mandatory workflow.

Available Superpowers skills:
- **brainstorming** — Before writing code, refine spec through questions
- **writing-plans** — Break work into bite-sized tasks with exact file paths
- **subagent-driven-development** — Dispatch fresh subagent per task with two-stage review
- **using-git-worktrees** — Isolated workspace for feature branches
- **test-driven-development** — RED-GREEN-REFACTOR enforcement
- **requesting-code-review** — Review against plan, severity reporting
- **writing-skills** — When creating new SONA-distilled skills (see format below)
- **systematic-debugging** — For diagnosis tasks before fixes
- **verification-before-completion** — Final check before marking done

## Auto-Generated Skills (SONA Output)

When SONA's ReasoningBank distills a pattern into a skill, it is written to `skills/auto/<skill-name>/SKILL.md`.
These skills are automatically available to Claude Code sessions in this project.
Always check `skills/auto/` for domain-specific patterns before implementing from scratch.

## Hermes Architecture (8-Step Loop)

1. **Input** — Task arrives via Telegram, API, or internal recursion
2. **Retrieval** — RuVector GNN memory search for relevant context
3. **Planning** — gstack /plan-eng-review + Superpowers writing-plans
4. **Governance (Pre)** — SuperClaw proof gate (non-negotiable)
5. **Execution** — ruflo swarm / deer-flow / VoltAgent subagents
6. **SONA Optimization** — Trajectory recording → Micro-LoRA → ReasoningBank
7. **Governance (Post)** — SuperClaw validation
8. **Memory** — RuVector graph edge write + skill distillation if threshold met

## Kill Switches (Hard-Coded, Never Bypass)

- MAX_RECURSION_DEPTH = 5
- MAX_CONCURRENT_AGENTS = 10
- SPEND_GATE_USD = 50 (human approval above this)
- MAX_LOOP_ITERATIONS_PER_HOUR = 1000

## Key Files

- `src/core/loop.ts` — Main 8-step HermesLoop class
- `src/brain/sona.ts` — SONA daemon (port 18804)
- `src/brain/ewc.ts` — EWC++ anti-forgetting engine
- `src/core/reasoning-bank.ts` — Pattern distillation
- `src/skills/evolution.ts` — Skill auto-creation
- `src/skills/ledger.ts` — Phase 1 proof-of-concept (financial trajectories)
- `src/governance/superclaw.ts` — SuperClaw governance bridge

## SKILL.md Format (for ReasoningBank output)

All auto-generated skills MUST follow this format:

```markdown
---
name: skill-name-with-hyphens
description: Use when [specific triggering conditions — NOT workflow summary]
---

# Skill Name

## Overview
Core principle in 1-2 sentences.

## When to Use
- Bullet list of symptoms/situations
- When NOT to use

## Core Pattern
Before/after or key code pattern (< 50 lines inline)

## Quick Reference
Scannable table or bullets

## Common Mistakes
What goes wrong + fixes
```

## Running Hermes

```bash
npm run dev          # TypeScript watch mode
npm run loop:run     # Start the 8-step recursive loop
npm run sona:daemon  # Start SONA background optimizer (port 18804)
npm run build        # Compile TypeScript
```

## Rust Crates

- `crates/skynet-runtime` — Critical-path GNN ops, EWC++ integration (napi-rs FFI)
- `crates/hermes-core` — SONA HTTP daemon (axum, port 18804)

Build: `~/.cargo/bin/cargo check --workspace`
