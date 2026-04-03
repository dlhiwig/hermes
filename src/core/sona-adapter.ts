/**
 * SONA Adapter — Production SONA Configuration for Hermes
 *
 * This is the concrete wiring point for @ruvector/sona.
 * Configuration values are sourced directly from RuVector documentation
 * and validated against Charlie's production setup.
 *
 * SONA config:
 *   lora.microRank = 2    → instant adaptation (<1ms, Micro-LoRA)
 *   lora.baseRank  = 8    → background consolidation (Base LoRA)
 *   ewc.lambda     = 0.4  → base regularization strength
 *   ewc.fisherSamples = 200 → online Fisher estimation samples
 *   ewc.importanceDecay = 0.95 → old tasks lose protection at 5%/cycle
 *   ewc.perLayerScaling = true → earlier layers get lighter lambda
 *   ewc.mode = 'online'   → real-time, no replay buffer needed
 *
 * Integration points in the recursive loop:
 *   Step 5 (instant): sona.applyEwcPenalty(trajId) → Micro-LoRA update
 *   Step 8 (deep):    sona.optimizeRouter()         → Base LoRA + GNN propagation
 */

import { EWCPlusPlus, type EWCConfig } from "../brain/ewc.js";
import type { Trajectory, RewardSignal, HermesTask, HermesPlan, RoutingRecommendation } from "./loop.js";

// ── Production Config (matches @ruvector/sona API) ────────────────────────────

export interface LoRAConfig {
  /** Micro-LoRA rank — instant adaptation, rank 1-2 */
  microRank: number;
  /** Base LoRA rank — background learning, rank 8+ */
  baseRank: number;
}

export interface SONAAdapterConfig {
  lora: LoRAConfig;
  ewc: EWCConfig;
  /** Port for SONA daemon HTTP API */
  port: number;
}

/** Production-validated SONA config — matches Charlie's live setup */
export const PRODUCTION_SONA_CONFIG: SONAAdapterConfig = {
  lora: {
    microRank: 2,   // instant adaptation
    baseRank: 8,    // background learning
  },
  ewc: {
    lambda: 0.4,              // base regularization strength (0.0–1.0)
    fisherSamples: 200,       // samples for online Fisher estimation
    importanceDecay: 0.95,    // old tasks lose protection at 5%/cycle
    perLayerScaling: true,    // earlier layers get lighter lambda
    mode: "online",           // real-time, no replay buffer
    taskBufferSize: 512,      // circular buffer for boundary detection
  },
  port: 18804,
};

// ── Gradient Utilities ────────────────────────────────────────────────────────

/**
 * Derive a synthetic gradient map from a reward signal.
 * Used to feed EWC++ Fisher updates when real gradients aren't available
 * (i.e., when using API-based models without access to internal weights).
 *
 * Maps reward dimensions to named "parameter" slots in the EWC Fisher table.
 * Over time these become meaningful routing proxies.
 */
function rewardToGradients(reward: RewardSignal, taskPattern: string): Map<string, number> {
  const grads = new Map<string, number>();

  // Treat reward dimensions as pseudo-gradients
  grads.set(`accuracy:${taskPattern.slice(0, 16)}`, reward.score);
  grads.set(`latency:${taskPattern.slice(0, 16)}`, 1 / Math.max(reward.latencyMs, 1) * 1000);
  grads.set(`cost_efficiency:${taskPattern.slice(0, 16)}`, reward.costEfficiency);
  grads.set(`source:${reward.labels[0] ?? "unknown"}`, reward.score);

  // Per-executor gradient (from label tags)
  for (const label of reward.labels) {
    grads.set(`label:${label}`, reward.score);
  }

  return grads;
}

// ── SONAAdapter ───────────────────────────────────────────────────────────────

export class SONAAdapter {
  private config: SONAAdapterConfig;
  private ewc: EWCPlusPlus;
  private routingTableVersion: number = 0;
  private trajectoryBuffer: Array<{ trajectory: Trajectory; reward: RewardSignal }> = [];

  constructor(config: SONAAdapterConfig = PRODUCTION_SONA_CONFIG) {
    this.config = config;
    this.ewc = new EWCPlusPlus(config.ewc);

    // Register default LoRA layers for core routing dimensions
    // These correspond to the routing dimensions SONA optimizes
    this.ewc.registerLoRALayer("routing-accuracy",   config.lora.microRank, 64, 32);
    this.ewc.registerLoRALayer("routing-latency",    config.lora.microRank, 64, 32);
    this.ewc.registerLoRALayer("routing-cost",       config.lora.microRank, 64, 32);
    this.ewc.registerLoRALayer("executor-selection", config.lora.baseRank,  128, 64);
    this.ewc.registerLoRALayer("task-pattern",       config.lora.baseRank,  256, 128);

    console.log(`[SONAAdapter] Initialized — microRank=${config.lora.microRank} baseRank=${config.lora.baseRank} lambda=${config.ewc.lambda}`);
  }

  /**
   * STEP 5 — Instant optimization (<1ms target)
   * Called immediately after trajectory observation.
   * Applies Micro-LoRA + lightweight EWC++ penalty.
   */
  async applyEwcPenalty(trajectory: Trajectory, reward: RewardSignal): Promise<void> {
    const pattern = reward.taskPattern;
    const gradients = rewardToGradients(reward, pattern);

    // Apply Micro-LoRA update with EWC++ penalty on LoRA A/B matrices
    const result = this.ewc.applyMicroLora(gradients, reward.score);

    console.log(
      `[SONAAdapter] applyEwcPenalty — taskId=${trajectory.taskId} ` +
      `penalty=${result.totalPenalty.toFixed(4)} params=${result.paramCount} ` +
      `lambda=${result.adaptiveLambda.toFixed(3)}`
    );

    // Buffer for background optimization
    this.trajectoryBuffer.push({ trajectory, reward });
  }

  /**
   * STEP 8 — Router optimization (background + deep consolidation)
   * Called during consolidation. Runs Base LoRA update + GNN propagation.
   */
  async optimizeRouter(): Promise<void> {
    if (this.trajectoryBuffer.length === 0) return;

    console.log(`[SONAAdapter] optimizeRouter — buffer=${this.trajectoryBuffer.length} routingV=${this.routingTableVersion}`);

    const gradientBatch = this.trajectoryBuffer.map(({ reward }) =>
      rewardToGradients(reward, reward.taskPattern)
    );
    const rewards = this.trajectoryBuffer.map(({ reward }) => reward.score);
    const trajIds = this.trajectoryBuffer.map(({ trajectory }) => trajectory.taskId);

    // Background EWC++ Fisher update across all buffered trajectories
    await this.ewc.applyBackgroundUpdate(trajIds, gradientBatch, rewards);

    this.routingTableVersion++;
    this.trajectoryBuffer = [];

    console.log(`[SONAAdapter] Router optimized — version=${this.routingTableVersion} ewcAge=${this.ewc.getTaskAge()}`);
  }

  /**
   * Deep consolidation — call nightly or under low load.
   * Full EWC++ + Base LoRA across entire trajectory history.
   */
  async deepConsolidate(
    allTrajectories: Array<{ trajectory: Trajectory; reward: RewardSignal }>
  ): Promise<void> {
    console.log(`[SONAAdapter] deepConsolidate — trajectories=${allTrajectories.length}`);

    const gradientCorpus = allTrajectories.map(({ reward }) =>
      rewardToGradients(reward, reward.taskPattern)
    );
    const rewards = allTrajectories.map(({ reward }) => reward.score);
    const trajIds = allTrajectories.map(({ trajectory }) => trajectory.taskId);

    const result = await this.ewc.deepConsolidate(trajIds, gradientCorpus, rewards);

    console.log(`[SONAAdapter] deepConsolidate complete — updatedParams=${result.updatedParams} avgPenalty=${result.avgPenalty.toFixed(4)}`);
  }

  /**
   * Feed governance negative reward into EWC++.
   * Called from Step 7 when SuperClaw flags a trajectory.
   * Amplifies Fisher importance for safety-critical parameters.
   */
  applyGovernancePenalty(paramPattern: string, negativeReward: number): void {
    // Apply penalty across all routing-layer params matching the pattern
    for (const paramId of ["routing-accuracy", "routing-latency", "routing-cost", "executor-selection"]) {
      this.ewc.applyGovernancePenalty(`${paramId}:${paramPattern.slice(0, 16)}`, negativeReward);
    }
  }

  /**
   * Get routing recommendation for a task.
   * Uses EWC++ adapted router (layer with highest Fisher importance for this pattern).
   */
  getRoutingRecommendation(task: HermesTask, _plan: HermesPlan | null): RoutingRecommendation {
    const pattern = task.input.slice(0, 64);
    const adapted = this.ewc.getAdaptedRouter(pattern);

    return {
      suggestedExecutor: adapted?.suggestedExecutor ?? "voltAgent",
      confidenceScore: adapted?.confidence ?? 0.5,
      reasoning: adapted
        ? `EWC++ routing — layer=${adapted.layerId} fishImportance=${adapted.fisherImportance.toFixed(4)} v${this.routingTableVersion}`
        : `No EWC++ routing data yet — defaulting to VoltAgent (v${this.routingTableVersion})`,
    };
  }

  getConfig(): SONAAdapterConfig { return this.config; }
  getRoutingTableVersion(): number { return this.routingTableVersion; }
  getEWC(): EWCPlusPlus { return this.ewc; }
}
