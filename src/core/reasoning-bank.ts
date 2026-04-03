/**
 * ReasoningBank — Pattern Distillation & Skill Library
 *
 * SONA's background loop extracts successful patterns from trajectories and
 * distills them into the ReasoningBank as reusable graph nodes. When a pattern
 * exceeds the success threshold, a new RVF cognitive container or permanent
 * sub-agent is spawned.
 *
 * This is the "recursive self-improvement" core — new capabilities emerge from
 * usage without manual coding.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Trajectory, SkillCandidate } from "./loop.js";

export const DISTILL_SUCCESS_THRESHOLD = 0.85;   // 85% reward over N runs
export const DISTILL_MIN_SAMPLES = 10;            // Minimum trajectories before distillation
export const SPAWN_AGENT_THRESHOLD = 0.92;        // Threshold to spawn permanent sub-agent

export interface DistilledPattern {
  id: string;
  pattern: string;
  taskType: string;
  successRate: number;
  sampleCount: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  rvfContainerPath?: string;
  permanentAgentSpawned: boolean;
  createdAt: Date;
  lastUpdatedAt: Date;
  graphNodeId?: string;        // RuVector GNN node ID
}

export interface ReasoningBankStats {
  totalPatterns: number;
  distilledSkills: number;
  spawnedAgents: number;
  avgSuccessRate: number;
}

export class ReasoningBank {
  private patterns: Map<string, DistilledPattern>;
  private skillsDir: string;

  constructor(skillsDir = "./skills/auto") {
    this.patterns = new Map();
    this.skillsDir = skillsDir;
  }

  /**
   * Record outcome for a task pattern. Called after every trajectory.
   * Returns a SkillCandidate if distillation threshold is approaching.
   */
  recordOutcome(
    taskPattern: string,
    taskType: string,
    reward: number,
    latencyMs: number,
    costUsd: number
  ): SkillCandidate | null {
    const existing = this.patterns.get(taskPattern);

    if (existing) {
      // Exponential moving average for success rate
      const alpha = 1 / Math.min(existing.sampleCount + 1, 100);
      existing.successRate = (1 - alpha) * existing.successRate + alpha * reward;
      existing.avgLatencyMs = (1 - alpha) * existing.avgLatencyMs + alpha * latencyMs;
      existing.avgCostUsd = (1 - alpha) * existing.avgCostUsd + alpha * costUsd;
      existing.sampleCount++;
      existing.lastUpdatedAt = new Date();
      this.patterns.set(taskPattern, existing);
    } else {
      this.patterns.set(taskPattern, {
        id: `pattern_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        pattern: taskPattern,
        taskType,
        successRate: reward,
        sampleCount: 1,
        avgLatencyMs: latencyMs,
        avgCostUsd: costUsd,
        permanentAgentSpawned: false,
        createdAt: new Date(),
        lastUpdatedAt: new Date(),
      });
    }

    return this.shouldDistill(taskPattern) ? this.buildCandidate(taskPattern) : null;
  }

  shouldDistill(taskPattern: string): boolean {
    const p = this.patterns.get(taskPattern);
    if (!p) return false;
    return p.sampleCount >= DISTILL_MIN_SAMPLES && p.successRate >= DISTILL_SUCCESS_THRESHOLD;
  }

  shouldSpawnAgent(taskPattern: string): boolean {
    const p = this.patterns.get(taskPattern);
    if (!p) return false;
    return p.sampleCount >= DISTILL_MIN_SAMPLES && p.successRate >= SPAWN_AGENT_THRESHOLD;
  }

  /**
   * Generate a valid Superpowers SKILL.md from a distilled pattern.
   * Output follows the format required by .claude/skills/ auto-routing.
   */
  emitSkillMd(pattern: DistilledPattern): string {
    const kebabName = this.toSkillName(pattern.pattern);
    const humanName = kebabName
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    return `---
name: ${kebabName}
description: Use when handling ${pattern.taskType} tasks with input matching "${pattern.pattern.slice(0, 100)}"
---

# ${humanName}

## Overview
Auto-distilled skill encoding the "${pattern.pattern}" execution strategy.
Success rate ${(pattern.successRate * 100).toFixed(1)}% over ${pattern.sampleCount} samples.

## When to Use
- Task type is \`${pattern.taskType}\` and input matches "${pattern.pattern}"
- Historical success rate exceeds ${(DISTILL_SUCCESS_THRESHOLD * 100).toFixed(0)}%
- When NOT to use: tasks outside the \`${pattern.taskType}\` domain or with reward signals below 0.5

## Core Pattern
1. Classify incoming task against the "${pattern.pattern}" signature.
2. Route to the executor validated by this pattern's trajectory history.
3. Execute with SuperClaw pre-check governance gate.
4. Validate output via SuperClaw post-check.
5. Record trajectory back to SONA for continuous refinement.

## Quick Reference
| Metric | Value |
|--------|-------|
| Success Rate | ${(pattern.successRate * 100).toFixed(1)}% |
| Avg Latency | ${pattern.avgLatencyMs.toFixed(0)}ms |
| Avg Cost | $${pattern.avgCostUsd.toFixed(4)} |
| Samples | ${pattern.sampleCount} |

## Common Mistakes
- Don't use for tasks outside ${pattern.taskType} domain
- Reward signals below 0.5 indicate poor fit
`;
  }

  /**
   * Distill a pattern into a Superpowers-format SKILL.md + RVF container.
   * Writes to skills/auto/<skillName>/SKILL.md and is immediately available for routing.
   */
  async distillToSkill(
    taskPattern: string,
    representativeTrajectory: Trajectory
  ): Promise<DistilledPattern | null> {
    const p = this.patterns.get(taskPattern);
    if (!p) return null;

    const skillName = this.toSkillName(taskPattern);

    // Emit Superpowers SKILL.md when success threshold is met
    if (p.successRate >= DISTILL_SUCCESS_THRESHOLD) {
      const skillMd = this.emitSkillMd(p);
      const skillDir = path.join(this.skillsDir, skillName);
      await fs.mkdir(skillDir, { recursive: true });
      const skillMdPath = path.join(skillDir, "SKILL.md");
      await fs.writeFile(skillMdPath, skillMd);
      console.log(`[ReasoningBank] Wrote SKILL.md → ${skillMdPath}`);
    }

    // TODO: Package as RVF container (npx ruvector pack <skillName>)
    const rvfPath = path.join(this.skillsDir, skillName, `${skillName}.rvf`);

    p.rvfContainerPath = rvfPath;
    p.lastUpdatedAt = new Date();
    this.patterns.set(taskPattern, p);

    console.log(`[ReasoningBank] Distilled skill: ${skillName} (successRate=${p.successRate.toFixed(3)})`);

    return p;
  }

  private buildCandidate(taskPattern: string): SkillCandidate | null {
    const p = this.patterns.get(taskPattern);
    if (!p) return null;
    const skillName = this.toSkillName(taskPattern);
    const skillMdPath = p.successRate >= DISTILL_SUCCESS_THRESHOLD
      ? path.join(this.skillsDir, skillName, "SKILL.md")
      : undefined;
    return {
      pattern: taskPattern,
      successRate: p.successRate,
      sampleTrajectories: [],
      proposedSkillName: skillName,
      proposedExecutor: "voltAgent",
      ...(p.rvfContainerPath !== undefined && { rvfContainerPath: p.rvfContainerPath }),
      ...(skillMdPath !== undefined && { skillMdPath }),
    };
  }

  private toSkillName(pattern: string): string {
    return pattern
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 48);
  }

  getPattern(taskPattern: string): DistilledPattern | undefined {
    return this.patterns.get(taskPattern);
  }

  getStats(): ReasoningBankStats {
    const patterns = Array.from(this.patterns.values());
    return {
      totalPatterns: patterns.length,
      distilledSkills: patterns.filter((p) => p.rvfContainerPath).length,
      spawnedAgents: patterns.filter((p) => p.permanentAgentSpawned).length,
      avgSuccessRate: patterns.length > 0
        ? patterns.reduce((s, p) => s + p.successRate, 0) / patterns.length
        : 0,
    };
  }
}
