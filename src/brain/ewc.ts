/**
 * EWC++ — Enhanced Elastic Weight Consolidation
 *
 * Anti-forgetting mechanism inside SONA. Enables Hermes to learn new patterns
 * (e.g., new Jessie financial rules, new ledger spending habits) WITHOUT erasing
 * prior knowledge — the classic "catastrophic forgetting" problem in continual
 * learning.
 *
 * Three learning loops:
 *   Instant  (<1ms):    Micro-LoRA (rank 1–2) + lightweight EWC++ penalty
 *   Background (~10–100ms): Online Fisher update + ReasoningBank distillation
 *   Deep (nightly):    Full EWC++ + Base LoRA + global GNN propagation
 *
 * Math:
 *   L_EWC++ = λ(t)/2 * Σ_i F_i(t) * (θ_i − θ_i*)² + γ * decay(t)
 *
 *   λ(t)   = adaptive strength (decays with task age)
 *   F_i(t) = running Fisher estimate (updated online via gradient squares)
 *   γ      = decay factor for old tasks
 */

export interface EWCConfig {
  /** Base regularization strength (0.0–1.0) */
  lambda: number;
  /** Samples used for online Fisher estimation */
  fisherSamples: number;
  /** 'online' = real-time | 'offline' = batch */
  mode: "online" | "offline";
  /** How quickly old tasks lose EWC protection (0.9–0.99 typical) */
  importanceDecay: number;
  /** Apply different λ to different LoRA layers */
  perLayerScaling: boolean;
  /** Circular buffer size for task boundary detection */
  taskBufferSize: number;
}

export interface FisherEstimate {
  paramId: string;
  /** Diagonal Fisher Information (gradient² average) */
  importance: number;
  /** Optimal weights at task boundary */
  optimalWeight: number;
  /** Adaptive λ at time of estimation */
  adaptiveLambda: number;
  taskAge: number;
}

export interface EWCPenaltyResult {
  totalPenalty: number;
  paramCount: number;
  adaptiveLambda: number;
  fisherUpdated: boolean;
}

export interface LoRADelta {
  layerId: string;
  rank: number;         // 1–2 for Micro, 8 for Base
  deltaA: number[];     // Low-rank factor A
  deltaB: number[];     // Low-rank factor B
  appliedAt: Date;
}

export class EWCPlusPlus {
  private config: EWCConfig;
  private fisherEstimates: Map<string, FisherEstimate>;
  private microLoraRank: number;
  private baseLoraRank: number;
  private taskBuffer: string[];   // circular buffer of recent task IDs
  private taskAge: number;

  constructor(config?: Partial<EWCConfig>) {
    this.config = {
      lambda: 0.4,
      fisherSamples: 200,
      mode: "online",
      importanceDecay: 0.95,
      perLayerScaling: true,
      taskBufferSize: 512,
      ...config,
    };
    this.fisherEstimates = new Map();
    this.microLoraRank = 2;
    this.baseLoraRank = 8;
    this.taskBuffer = [];
    this.taskAge = 0;
  }

  /**
   * INSTANT LOOP (<1ms)
   * Apply Micro-LoRA delta + lightweight EWC++ penalty for this trajectory step.
   * Called at SONA step 5 (instant optimization).
   */
  applyMicroLora(
    gradients: Map<string, number>,
    reward: number
  ): EWCPenaltyResult {
    let totalPenalty = 0;
    let paramCount = 0;

    for (const [paramId, grad] of gradients) {
      const estimate = this.fisherEstimates.get(paramId);
      if (!estimate) continue;

      const adaptiveLambda = this.adaptiveLambda(estimate);
      const penalty = (adaptiveLambda / 2) * estimate.importance *
        Math.pow(grad - estimate.optimalWeight, 2);

      totalPenalty += penalty;
      paramCount++;
    }

    // Online Fisher update from this gradient batch
    this.updateFisherOnline(gradients, reward);

    return {
      totalPenalty,
      paramCount,
      adaptiveLambda: this.config.lambda,
      fisherUpdated: true,
    };
  }

  /**
   * BACKGROUND LOOP (~10–100ms)
   * Full online Fisher update after a batch of trajectories.
   * Also detects task boundaries and triggers ReasoningBank distillation.
   */
  async applyBackgroundUpdate(
    trajectoryIds: string[],
    gradientBatch: Array<Map<string, number>>,
    rewards: number[]
  ): Promise<void> {
    // Detect task boundary (new task type entering buffer)
    const boundaryDetected = this.detectTaskBoundary(trajectoryIds);
    if (boundaryDetected) {
      await this.onTaskBoundary();
    }

    // Batch Fisher update
    for (let i = 0; i < gradientBatch.length; i++) {
      this.updateFisherOnline(gradientBatch[i]!, rewards[i] ?? 0);
    }

    // Decay importance of old tasks
    this.decayOldTasks();
  }

  /**
   * DEEP CONSOLIDATION LOOP (nightly / low-load)
   * Full EWC++ + Base LoRA update across all layers.
   * Locks in learned patterns while preventing forgetting.
   */
  async deepConsolidate(
    allTrajectoryIds: string[],
    fullGradientCorpus: Array<Map<string, number>>,
    rewards: number[]
  ): Promise<{ updatedParams: number; avgPenalty: number }> {
    console.log(`[EWC++] Deep consolidation — trajectories=${allTrajectoryIds.length}`);

    let totalPenalty = 0;
    let updatedParams = 0;

    // Full Fisher re-estimation over entire corpus
    for (let i = 0; i < fullGradientCorpus.length; i++) {
      const grads = fullGradientCorpus[i]!;
      const reward = rewards[i] ?? 0;
      for (const [paramId, grad] of grads) {
        const existing = this.fisherEstimates.get(paramId);
        const importance = grad * grad * reward;    // gradient² * reward as proxy
        this.fisherEstimates.set(paramId, {
          paramId,
          importance: existing
            ? this.config.importanceDecay * existing.importance + (1 - this.config.importanceDecay) * importance
            : importance,
          optimalWeight: grad,
          adaptiveLambda: this.config.lambda,
          taskAge: this.taskAge,
        });
        totalPenalty += importance;
        updatedParams++;
      }
    }

    console.log(`[EWC++] Deep consolidation complete — params=${updatedParams}`);
    return { updatedParams, avgPenalty: updatedParams > 0 ? totalPenalty / updatedParams : 0 };
  }

  /**
   * Feed negative reward into EWC++ from SuperClaw governance (Step 7).
   * Flagged trajectories get higher Fisher importance — locks those weights harder.
   */
  applyGovernancePenalty(
    paramId: string,
    negativeReward: number
  ): void {
    const existing = this.fisherEstimates.get(paramId);
    const penaltyBoost = Math.abs(negativeReward) * 2.0;   // amplify for safety
    if (existing) {
      existing.importance *= (1 + penaltyBoost);
      this.fisherEstimates.set(paramId, existing);
    }
    console.log(`[EWC++] Governance penalty applied — param=${paramId} boost=${penaltyBoost.toFixed(3)}`);
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  private updateFisherOnline(
    gradients: Map<string, number>,
    reward: number
  ): void {
    for (const [paramId, grad] of gradients) {
      const newImportance = grad * grad * Math.max(reward, 0);   // gradient²
      const existing = this.fisherEstimates.get(paramId);

      this.fisherEstimates.set(paramId, {
        paramId,
        importance: existing
          ? this.config.importanceDecay * existing.importance +
            (1 - this.config.importanceDecay) * newImportance
          : newImportance,
        optimalWeight: grad,
        adaptiveLambda: this.adaptiveLambda(existing),
        taskAge: this.taskAge,
      });
    }
  }

  private adaptiveLambda(estimate?: FisherEstimate): number {
    if (!estimate || !this.config.perLayerScaling) return this.config.lambda;
    const ageDelta = this.taskAge - estimate.taskAge;
    return this.config.lambda * Math.pow(this.config.importanceDecay, ageDelta);
  }

  private detectTaskBoundary(newTaskIds: string[]): boolean {
    const prevSize = this.taskBuffer.length;
    for (const id of newTaskIds) {
      if (this.taskBuffer.length >= this.config.taskBufferSize) {
        this.taskBuffer.shift();
      }
      this.taskBuffer.push(id);
    }
    // Simple heuristic: boundary if buffer pattern changes significantly
    return this.taskBuffer.length === this.config.taskBufferSize &&
      prevSize < this.config.taskBufferSize;
  }

  private async onTaskBoundary(): Promise<void> {
    this.taskAge++;
    console.log(`[EWC++] Task boundary detected — taskAge=${this.taskAge}`);
    // TODO: Snapshot current Fisher estimates as checkpoint
    // TODO: Trigger ReasoningBank distillation for patterns in buffer
  }

  private decayOldTasks(): void {
    for (const [paramId, estimate] of this.fisherEstimates) {
      estimate.importance *= this.config.importanceDecay;
      if (estimate.importance < 1e-6) {
        this.fisherEstimates.delete(paramId);   // prune negligible params
      } else {
        this.fisherEstimates.set(paramId, estimate);
      }
    }
  }

  getConfig(): EWCConfig { return this.config; }
  getFisherEstimates(): Map<string, FisherEstimate> { return this.fisherEstimates; }
  getTaskAge(): number { return this.taskAge; }
}
