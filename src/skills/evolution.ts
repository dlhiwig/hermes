/**
 * Skill Evolution Engine
 *
 * Evaluates completed trajectories to determine whether a successful pattern
 * has been repeated enough to be distilled into a permanent RVF skill or
 * spawned as a permanent sub-agent via ruflo.
 *
 * Thresholds:
 *   DISTILL_SUCCESS_RATE    = 0.85  (85% success rate triggers distillation)
 *   DISTILL_MIN_SAMPLES     = 10    (minimum trajectories before evaluation)
 *   SPAWN_AGENT_SUCCESS_RATE = 0.95 (95% triggers permanent sub-agent spawn)
 */

import * as fs from "fs/promises";
import * as path from "path";
import { HermesMemory } from "../brain/ruvector.js";
import type { Trajectory, SkillCandidate } from "../core/loop.js";

const DISTILL_SUCCESS_RATE = 0.85;
const DISTILL_MIN_SAMPLES = 10;
const SPAWN_AGENT_SUCCESS_RATE = 0.95;
const SKILLS_DIR = path.resolve("skills");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PatternMetrics {
  pattern: string;
  totalSamples: number;
  successCount: number;
  successRate: number;
  trajectoryIds: string[];
  lastUpdated: Date;
}

export interface RVFSkillManifest {
  id: string;
  name: string;
  pattern: string;
  executor: string;
  successRate: number;
  createdAt: string;
  rvfContainerPath: string;
  skillMdPath: string;
}

// ── SkillEvolution ────────────────────────────────────────────────────────────

export class SkillEvolution {
  private memory: HermesMemory;
  private patternMetrics: Map<string, PatternMetrics>;

  constructor(memory: HermesMemory) {
    this.memory = memory;
    this.patternMetrics = new Map();
    console.log("[SkillEvolution] Initialized");
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  /**
   * Evaluate a completed trajectory to extract its task pattern and update
   * per-pattern success metrics. Returns a SkillCandidate if metrics exist,
   * or null if insufficient data.
   */
  async evaluate(trajectory: Trajectory): Promise<SkillCandidate | null> {
    const pattern = this.extractPattern(trajectory.input);
    const success =
      trajectory.rewardSignal?.score !== undefined
        ? trajectory.rewardSignal.score > 0.5
        : trajectory.executionResults.every((r) => r.success);

    // Update in-memory metrics
    let metrics = this.patternMetrics.get(pattern);
    if (!metrics) {
      metrics = {
        pattern,
        totalSamples: 0,
        successCount: 0,
        successRate: 0,
        trajectoryIds: [],
        lastUpdated: new Date(),
      };
      this.patternMetrics.set(pattern, metrics);
    }

    metrics.totalSamples++;
    if (success) metrics.successCount++;
    metrics.successRate = metrics.successCount / metrics.totalSamples;
    metrics.trajectoryIds.push(trajectory.taskId);
    metrics.lastUpdated = new Date();

    // TODO: Also persist metrics to RuVector graph for cross-session retention
    // await this.memory.cypher(
    //   "MERGE (p:Pattern {name: $pattern}) SET p.successRate = $rate, p.samples = $samples",
    //   { pattern, rate: metrics.successRate, samples: metrics.totalSamples }
    // );

    if (metrics.totalSamples < DISTILL_MIN_SAMPLES) {
      console.log(
        `[SkillEvolution] Pattern "${pattern.slice(0, 40)}" — samples=${metrics.totalSamples}/${DISTILL_MIN_SAMPLES} (not enough data yet)`
      );
      return null;
    }

    return {
      pattern,
      successRate: metrics.successRate,
      sampleTrajectories: metrics.trajectoryIds.slice(-20),
      proposedSkillName: this.deriveSkillName(pattern),
      proposedExecutor: this.selectBestExecutor(metrics),
    };
  }

  // ── Threshold Checks ──────────────────────────────────────────────────────

  shouldDistill(successRate: number): boolean {
    return successRate >= DISTILL_SUCCESS_RATE;
  }

  shouldSpawnAgent(successRate: number): boolean {
    return successRate >= SPAWN_AGENT_SUCCESS_RATE;
  }

  async getSuccessRate(pattern: string): Promise<number> {
    const metrics = this.patternMetrics.get(pattern);
    if (metrics) return metrics.successRate;

    // TODO: Fall back to RuVector graph query
    // const rows = await this.memory.cypher(
    //   "MATCH (p:Pattern {name: $pattern}) RETURN p.successRate",
    //   { pattern }
    // );
    return 0;
  }

  // ── Skill Distillation ────────────────────────────────────────────────────

  /**
   * Distill a successful pattern into an RVF skill:
   *  1. Write SKILL.md (human-readable description)
   *  2. Write <skillName>.rvf (serialized RVF container)
   *  3. Register the skill in RuVector
   */
  async createRVFSkill(pattern: string, trajectory: Trajectory): Promise<RVFSkillManifest> {
    const name = this.deriveSkillName(pattern);
    const metrics = this.patternMetrics.get(pattern);
    const skillDir = path.join(SKILLS_DIR, name);

    await fs.mkdir(skillDir, { recursive: true });

    // Write SKILL.md
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const skillMd = this.renderSkillMd(name, pattern, metrics, trajectory);
    await fs.writeFile(skillMdPath, skillMd, "utf-8");

    // Write RVF container (JSON stub — TODO: binary RVF serialization)
    const rvfContainerPath = path.join(skillDir, `${name}.rvf.json`);
    const rvfContainer = {
      skillName: name,
      pattern,
      successRate: metrics?.successRate ?? 0,
      representativeTrajectoryId: trajectory.taskId,
      createdAt: new Date().toISOString(),
      rewardSignal: trajectory.rewardSignal,
    };
    await fs.writeFile(rvfContainerPath, JSON.stringify(rvfContainer, null, 2), "utf-8");

    const manifest: RVFSkillManifest = {
      id: `skill_${name}_${Date.now()}`,
      name,
      pattern,
      executor: this.selectBestExecutor(metrics ?? null),
      successRate: metrics?.successRate ?? 0,
      createdAt: new Date().toISOString(),
      rvfContainerPath,
      skillMdPath,
    };

    // Register in RuVector
    await this.memory.storeSkill({
      id: manifest.id,
      name: manifest.name,
      pattern: manifest.pattern,
      executor: manifest.executor,
      successRate: manifest.successRate,
      rvfPath: manifest.rvfContainerPath,
      createdAt: new Date(),
    });

    console.log(`[SkillEvolution] Distilled skill "${name}" — successRate=${manifest.successRate.toFixed(2)}`);
    return manifest;
  }

  /**
   * Spawn a permanent sub-agent via ruflo for patterns with >95% success rate.
   */
  async spawnPermanentAgent(skillName: string): Promise<string> {
    // TODO: Call ruflo to register a permanent agent role
    // const ruflo = new RufloClient({ apiKey: process.env.RUFLO_API_KEY });
    // const agent = await ruflo.registerPermanentAgent({
    //   role: skillName,
    //   skillPath: path.join(SKILLS_DIR, skillName),
    // });
    // return agent.agentId;

    const agentId = `permanent_${skillName}_${Date.now()}`;
    console.log(`[SkillEvolution] Spawning permanent agent — skill=${skillName} agentId=${agentId}`);
    return agentId;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractPattern(input: string): string {
    // TODO: Use NLP/embedding clustering to find canonical patterns
    // For now: normalize whitespace, lowercase, take first 64 chars
    return input.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 64);
  }

  private deriveSkillName(pattern: string): string {
    return pattern
      .slice(0, 30)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  private selectBestExecutor(metrics: PatternMetrics | null): string {
    // TODO: Query trajectory history to find which executor had highest success rate
    void metrics;
    return "voltAgent";
  }

  private renderSkillMd(
    name: string,
    pattern: string,
    metrics: PatternMetrics | undefined,
    trajectory: Trajectory
  ): string {
    return `# Skill: ${name}

## Pattern
\`\`\`
${pattern}
\`\`\`

## Stats
- Success Rate: ${((metrics?.successRate ?? 0) * 100).toFixed(1)}%
- Sample Count: ${metrics?.totalSamples ?? 0}
- Distilled At: ${new Date().toISOString()}

## Representative Trajectory
- Task ID: ${trajectory.taskId}
- Duration: ${trajectory.totalDurationMs}ms
- Cost: $${trajectory.totalCostUsd.toFixed(4)}
- Reward Score: ${trajectory.rewardSignal?.score.toFixed(3) ?? "N/A"}

## Executor
${this.selectBestExecutor(metrics ?? null)}

## Notes
Auto-distilled by Hermes SkillEvolution engine.
`;
  }
}
