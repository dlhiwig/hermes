---
name: hermes-writing-skills
description: Use when creating, emitting, or validating auto-generated SKILL.md files from Hermes ReasoningBank distillation
---

# Hermes Writing Skills

## Overview

Governs the exact format ReasoningBank uses when distilling SONA patterns into reusable skills. Every auto-generated skill must pass Claude Search Optimization (CSO) to be automatically discovered in future sessions.

## When to Use

- ReasoningBank.emitSkillMd() is being called or modified
- A new skill is being distilled from a high-success trajectory pattern
- Validating that a generated SKILL.md will be discoverable by Claude Code
- Adding skills to ~/.claude/skills/ or skills/auto/

## When NOT to Use

- Writing skills for human consumption only (use standard Superpowers format)
- Skills with fewer than 10 trajectory samples (below DISTILL_MIN_SAMPLES)

## Core Pattern — CSO Rules

```
frontmatter.description: "Use when [concrete trigger condition]"
  ✅ GOOD: "Use when handling financial tasks with input matching 'ledger:anomaly'"
  ❌ BAD:  "Analyzes ledger transactions and flags anomalies using SONA routing"

frontmatter.name: kebab-case-only (no spaces, parens, special chars)

Body: under 200 words for frequently-loaded skills
```

## Quick Reference

| Field | Rule |
|-------|------|
| `name` | kebab-case, letters/numbers/hyphens only |
| `description` | "Use when…" trigger only, <500 chars |
| Overview | 1-2 sentences, no workflow steps |
| When to Use | Symptoms + concrete situations |
| When NOT to Use | Explicit exclusions |
| Quick Reference | Table of metrics |
| Common Mistakes | What breaks + exact fix |

## Implementation

ReasoningBank.emitSkillMd() → writes to skills/auto/<name>/SKILL.md
Auto-registered in routing table on distillation.
Copy to ~/.claude/skills/ for Claude Code session discovery.

## Common Mistakes

- Putting workflow steps in `description` — Claude will shortcut and skip SKILL.md
- Using spaces or special chars in `name` — breaks filesystem routing
- Emitting skills with successRate < 85% — lowers routing confidence
