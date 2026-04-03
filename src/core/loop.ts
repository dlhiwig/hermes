/**
 * Hermes — The 8-Step Recursive Self-Learning Loop
 *
 * KILL SWITCHES (hard-coded, NOT runtime-configurable):
 *   MAX_RECURSION_DEPTH        = 5
 *   MAX_CONCURRENT_AGENTS      = 10
 *   SPEND_GATE_USD             = 50   (human approval required above this)
 *   MAX_LOOP_ITERATIONS_PER_HOUR = 1000
 */

import { SonaEngine } from "@ruvector/sona";
import { HermesMemory } from "../brain/ruvector.js";
import { SonaDaemon } from "../brain/sona.js";
import { HermesPlanner } from "../orchestration/planner.js";
import { SuperClawGovernance } from "../governance/superclaw.js";
import { SkillEvolution } from "../skills/evolution.js";

// ── Kill Switches ─────────────────────────────────────────────────────────────

const MAX_RECURSION_DEPTH = 5;
const MAX_CONCURRENT_AGENTS = 10;
const SPEND_GATE_USD = 50;
const MAX_LOOP_ITERATIONS_PER_HOUR = 1000;

// ── Core Interfaces ───────────────────────────────────────────────────────────

export interface HermesTask {
  id: string;
  input: string;
  context?: Record<string, unknown>;
  source: "telegram" | "api" | "internal" | "recursive";
  parentTaskId?: string;
  recursionDepth: number;
  submittedAt: Date;
}

export interface HermesContext {
  task: HermesTask;
  retrieved: RetrievalResult[];
  plan: HermesPlan | null;
  executionResults: ExecutionResult[];
  trajectory: Trajectory | null;
  governancePre: GovernanceResult | null;
  governancePost: GovernanceResult | null;
  sonaRecommendation: RoutingRecommendation | null;
  spendAccumulated: number;
  startedAt: Date;
}

export interface RetrievalResult {
  id: string;
  content: string;
  score: number;
  source: "vector" | "keyword" | "graph";
  metadata: Record<string, unknown>;
}

export interface HermesPlan {
  id: string;
  steps: PlanStep[];
  estimatedCostUsd: number;
  estimatedDurationMs: number;
  subAgents: string[];
  gstackGates: string[];
}

export interface PlanStep {
  id: string;
  description: string;
  executor: "voltAgent" | "skynetRust" | "deerFlow" | "ruflo" | "internal";
  dependencies: string[];
  inputs: Record<string, unknown>;
}

export interface ExecutionResult {
  stepId: string;
  output: unknown;
  durationMs: number;
  success: boolean;
  error?: string;
  proofHash?: string;
}

export interface Trajectory {
  taskId: string;
  input: string;
  plan: HermesPlan | null;
  executionResults: ExecutionResult[];
  rewardSignal: RewardSignal | null;
  totalDurationMs: number;
  totalCostUsd: number;
  completedAt: Date;
}

export interface RewardSignal {
  score: number;          // 0.0 – 1.0
  latencyMs: number;
  costEfficiency: number; // score / cost
  taskPattern: string;
  labels: string[];
}

export interface SkillCandidate {
  pattern: string;
  successRate: number;
  sampleTrajectories: string[]; // trajectory IDs
  proposedSkillName: string;
  proposedExecutor: string;
  rvfContainerPath?: string;
  skillMdPath?: string;
}

export interface GovernanceResult {
  decision: "approve" | "reject" | "escalate";
  reason: string;
  proofHash?: string;
  piiRisk: boolean;
  projectedCostUsd: number;
  promptInjectionDetected: boolean;
}

export interface RoutingRecommendation {
  suggestedExecutor: string;
  confidenceScore: number;
  reasoning: string;
}

export interface LoopMetrics {
  iterationsThisHour: number;
  lastResetAt: Date;
  activeAgents: number;
}

// ── HermesLoop ────────────────────────────────────────────────────────────────

export class HermesLoop {
  private memory: HermesMemory;
  private sona: SonaDaemon;
  private sonaEngine: SonaEngine;
  private planner: HermesPlanner;
  private governance: SuperClawGovernance;
  private skillEvolution: SkillEvolution;
  private metrics: LoopMetrics;

  constructor() {
    this.memory = new HermesMemory();
    this.sona = new SonaDaemon();
    this.sonaEngine = new SonaEngine(256);
    this.planner = new HermesPlanner();
    this.governance = new SuperClawGovernance();
    this.skillEvolution = new SkillEvolution(this.memory);
    this.metrics = {
      iterationsThisHour: 0,
      lastResetAt: new Date(),
      activeAgents: 0,
    };
  }

  // ── Entry Point ─────────────────────────────────────────────────────────────

  async run(task: HermesTask): Promise<Trajectory> {
    this.enforceKillSwitches(task);
    this.tickRateLimit();

    const ctx: HermesContext = {
      task,
      retrieved: [],
      plan: null,
      executionResults: [],
      trajectory: null,
      governancePre: null,
      governancePost: null,
      sonaRecommendation: null,
      spendAccumulated: 0,
      startedAt: new Date(),
    };

    console.log(`[Hermes] Starting task ${task.id} (depth=${task.recursionDepth})`);

    // ── Step 1: Input & Retrieval ──────────────────────────────────────────
    ctx.retrieved = await this.step1_inputAndRetrieval(task);

    // ── Step 2: Planning ──────────────────────────────────────────────────
    ctx.plan = await this.step2_planning(task, ctx.retrieved);
    ctx.sonaRecommendation = await this.sona.getRoutingRecommendation(task, ctx.plan);

    // ── Step 2.5: PRE-EXECUTION GOVERNANCE CHECK ──────────────────────────
    ctx.governancePre = await this.step2_5_preExecutionGovernance(ctx.plan, ctx);
    if (ctx.governancePre.decision === "reject") {
      // End a zero-reward trajectory so Fisher estimates don't go stale
      const rejectEmb = this.taskToEmbedding(task);
      const rejectTrajId = this.sonaEngine.beginTrajectory(rejectEmb);
      this.sonaEngine.endTrajectory(rejectTrajId, 0);
      return this.abortTrajectory(ctx, `Governance pre-check rejected: ${ctx.governancePre.reason}`);
    }
    if (ctx.governancePre.decision === "escalate") {
      await this.humanEscalation(ctx, "pre-execution");
    }

    // ── Step 3: Execution (with Convoy trajectory tracking) ────────────────
    const trajEmbedding = this.taskToEmbedding(task);
    const trajId = this.sonaEngine.beginTrajectory(trajEmbedding);

    try {
      ctx.executionResults = await this.step3_execution(ctx.plan!, ctx);
      ctx.spendAccumulated = ctx.executionResults.reduce((_acc, _r) => _acc, 0); // TODO: sum actual cost

      // Record each execution result as a trajectory step
      for (const result of ctx.executionResults) {
        const stepEmb = this.taskToEmbedding({ ...task, input: `${task.input}:step:${result.stepId}` });
        const actions: number[] = [result.success ? 1.0 : 0.0];
        const stepReward = result.success ? 0.8 : 0.0;
        this.sonaEngine.addTrajectoryStep(trajId, stepEmb, actions, stepReward);
      }
    } catch (err) {
      // End trajectory with zero reward on error so Fisher estimates don't go stale
      this.sonaEngine.endTrajectory(trajId, 0);
      throw err;
    }

    // ── Step 4: Observation & Logging ─────────────────────────────────────
    ctx.trajectory = await this.step4_observationAndLogging(ctx);

    // End trajectory with the computed reward signal
    const finalReward = ctx.trajectory.rewardSignal?.score ?? 0;
    this.sonaEngine.endTrajectory(trajId, finalReward);

    // ── Step 5: SONA Optimization ─────────────────────────────────────────
    await this.step5_sonaOptimization(ctx.trajectory);

    // ── Step 6: Skill Evolution ───────────────────────────────────────────
    await this.step6_skillEvolution(ctx.trajectory);

    // ── Step 7: POST-EXECUTION GOVERNANCE FEEDBACK ────────────────────────
    ctx.governancePost = await this.step7_postExecutionGovernance(ctx.trajectory);

    // ── Step 8: Consolidation ─────────────────────────────────────────────
    await this.step8_consolidation(ctx);

    console.log(`[Hermes] Task ${task.id} complete in ${Date.now() - ctx.startedAt.getTime()}ms`);
    return ctx.trajectory;
  }

  // ── Step 1: Input & Retrieval ─────────────────────────────────────────────

  private async step1_inputAndRetrieval(task: HermesTask): Promise<RetrievalResult[]> {
    console.log(`[Step 1] Input & Retrieval — task=${task.id}`);

    // TODO: Call RuVector hybrid search (vector + keyword + Cypher graph traversal)
    // const results = await this.memory.hybridSearch(task.input, {
    //   vectorTopK: 10,
    //   keywordBoost: 0.3,
    //   cypherQuery: `MATCH (n:Skill)-[:SOLVED]->(t:Task) WHERE t.pattern =~ $pattern RETURN n`,
    //   filters: { source: task.source, maxAge: "7d" },
    // });

    return [];
  }

  // ── Step 2: Planning ──────────────────────────────────────────────────────

  private async step2_planning(
    task: HermesTask,
    context: RetrievalResult[]
  ): Promise<HermesPlan> {
    console.log(`[Step 2] Planning — task=${task.id}`);

    // TODO: Run gstack plan gate, ruflo hivemind spawn, deer-flow decomposition
    return this.planner.plan(task, context);
  }

  // ── Step 2.5: PRE-EXECUTION GOVERNANCE CHECK ──────────────────────────────

  private async step2_5_preExecutionGovernance(
    plan: HermesPlan | null,
    ctx: HermesContext
  ): Promise<GovernanceResult> {
    console.log(`[Step 2.5] PRE-EXECUTION GOVERNANCE CHECK — task=${ctx.task.id}`);
    // SuperClaw MUST run before any execution starts (non-negotiable)
    return this.governance.preExecutionCheck(plan, ctx.task);
  }

  // ── Step 3: Execution ─────────────────────────────────────────────────────

  private async step3_execution(
    plan: HermesPlan,
    ctx: HermesContext
  ): Promise<ExecutionResult[]> {
    console.log(`[Step 3] Execution — steps=${plan.steps.length}`);

    const results: ExecutionResult[] = [];

    for (const step of plan.steps) {
      this.enforceAgentLimit();

      let result: ExecutionResult;
      switch (step.executor) {
        case "voltAgent":
          result = await this.runVoltAgent(step);
          break;
        case "skynetRust":
          result = await this.runSkynetRust(step);
          break;
        case "deerFlow":
          result = await this.runDeerFlow(step, ctx.task);
          break;
        case "ruflo":
          result = await this.runRuflo(step);
          break;
        default:
          result = await this.runInternal(step);
      }

      // SuperClaw proof validation per step
      await this.governance.validateProof(result.proofHash ?? "", step);
      results.push(result);
    }

    return results;
  }

  // ── Step 4: Observation & Logging ─────────────────────────────────────────

  private async step4_observationAndLogging(ctx: HermesContext): Promise<Trajectory> {
    console.log(`[Step 4] Observation & Logging — task=${ctx.task.id}`);

    const trajectory: Trajectory = {
      taskId: ctx.task.id,
      input: ctx.task.input,
      plan: ctx.plan,
      executionResults: ctx.executionResults,
      rewardSignal: this.computeRewardSignal(ctx),
      totalDurationMs: Date.now() - ctx.startedAt.getTime(),
      totalCostUsd: ctx.spendAccumulated,
      completedAt: new Date(),
    };

    // TODO: Serialize to RVF container and store
    // await this.memory.store(trajectory);

    return trajectory;
  }

  // ── Step 5: SONA Optimization ─────────────────────────────────────────────

  private async step5_sonaOptimization(trajectory: Trajectory): Promise<void> {
    console.log(`[Step 5] SONA Optimization — taskId=${trajectory.taskId}`);

    if (!trajectory.rewardSignal) return;

    // TODO: GNN update (Q-Learning / PPO / SARSA), routing table update, hyperparam tune (<1ms target)
    await this.sona.recordTrajectory(trajectory, trajectory.rewardSignal);
    await this.sona.optimizeRouter();
    await this.sona.updateGNN();
  }

  // ── Step 6: Skill Evolution ───────────────────────────────────────────────

  private async step6_skillEvolution(trajectory: Trajectory): Promise<void> {
    console.log(`[Step 6] Skill Evolution — taskId=${trajectory.taskId}`);

    const evaluation = await this.skillEvolution.evaluate(trajectory);
    if (!evaluation) return;

    const pattern = evaluation.pattern;
    const successRate = await this.skillEvolution.getSuccessRate(pattern);

    if (this.skillEvolution.shouldDistill(successRate)) {
      // Distill into RVF skill or spawn permanent sub-agent
      await this.skillEvolution.createRVFSkill(pattern, trajectory);
      // TODO: If success_rate > SPAWN_THRESHOLD, spawn a permanent sub-agent via ruflo
      // await this.skillEvolution.spawnPermanentAgent(evaluation.proposedSkillName);
    }
  }

  // ── Step 7: POST-EXECUTION GOVERNANCE FEEDBACK ───────────────────────────

  private async step7_postExecutionGovernance(trajectory: Trajectory): Promise<GovernanceResult> {
    console.log(`[Step 7] POST-EXECUTION GOVERNANCE FEEDBACK — taskId=${trajectory.taskId}`);
    // SuperClaw refines policy from observed trajectory (non-negotiable)
    return this.governance.postExecutionReview(trajectory);
  }

  // ── Step 8: Consolidation ─────────────────────────────────────────────────

  private async step8_consolidation(ctx: HermesContext): Promise<void> {
    console.log(`[Step 8] Consolidation — task=${ctx.task.id}`);

    if (!ctx.trajectory) return;

    // TODO: Write back to RuVector graph + update embeddings
    // await this.memory.updateGraph([
    //   { from: ctx.task.id, to: ctx.trajectory.taskId, relation: "COMPLETED_BY" },
    // ]);

    // TODO: Log improvement metric to SONA dashboard
    const metric = ctx.trajectory.rewardSignal?.score ?? 0;
    console.log(`[Step 8] Improvement metric: ${metric.toFixed(4)}`);
  }

  // ── Executor Stubs ────────────────────────────────────────────────────────

  private async runVoltAgent(step: PlanStep): Promise<ExecutionResult> {
    // TODO: Integrate VoltAgent TypeScript worker
    console.log(`[VoltAgent] Running step ${step.id}`);
    return { stepId: step.id, output: null, durationMs: 0, success: true };
  }

  private async runSkynetRust(step: PlanStep): Promise<ExecutionResult> {
    // TODO: FFI call to crates/skynet-runtime execute_with_proof()
    console.log(`[SkynetRust] Running step ${step.id}`);
    return { stepId: step.id, output: null, durationMs: 0, success: true, proofHash: "" };
  }

  private async runDeerFlow(step: PlanStep, parentTask: HermesTask): Promise<ExecutionResult> {
    // TODO: Spawn deer-flow sub-agent with recursion guard
    if (parentTask.recursionDepth >= MAX_RECURSION_DEPTH) {
      return { stepId: step.id, output: null, durationMs: 0, success: false, error: "Max recursion depth reached" };
    }
    console.log(`[DeerFlow] Running step ${step.id}`);
    return { stepId: step.id, output: null, durationMs: 0, success: true };
  }

  private async runRuflo(step: PlanStep): Promise<ExecutionResult> {
    // TODO: Dispatch to ruflo hive-mind agent pool
    console.log(`[Ruflo] Running step ${step.id}`);
    return { stepId: step.id, output: null, durationMs: 0, success: true };
  }

  private async runInternal(step: PlanStep): Promise<ExecutionResult> {
    console.log(`[Internal] Running step ${step.id}`);
    return { stepId: step.id, output: null, durationMs: 0, success: true };
  }

  // ── Kill Switch Enforcement ───────────────────────────────────────────────

  private enforceKillSwitches(task: HermesTask): void {
    if (task.recursionDepth > MAX_RECURSION_DEPTH) {
      throw new Error(
        `[KILL SWITCH] MAX_RECURSION_DEPTH=${MAX_RECURSION_DEPTH} exceeded at depth=${task.recursionDepth}`
      );
    }
  }

  private enforceAgentLimit(): void {
    if (this.metrics.activeAgents >= MAX_CONCURRENT_AGENTS) {
      throw new Error(
        `[KILL SWITCH] MAX_CONCURRENT_AGENTS=${MAX_CONCURRENT_AGENTS} reached`
      );
    }
  }

  private tickRateLimit(): void {
    const now = new Date();
    const hourMs = 60 * 60 * 1000;
    if (now.getTime() - this.metrics.lastResetAt.getTime() > hourMs) {
      this.metrics.iterationsThisHour = 0;
      this.metrics.lastResetAt = now;
    }
    this.metrics.iterationsThisHour++;
    if (this.metrics.iterationsThisHour > MAX_LOOP_ITERATIONS_PER_HOUR) {
      throw new Error(
        `[KILL SWITCH] MAX_LOOP_ITERATIONS_PER_HOUR=${MAX_LOOP_ITERATIONS_PER_HOUR} exceeded`
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private computeRewardSignal(ctx: HermesContext): RewardSignal {
    const durationMs = Date.now() - ctx.startedAt.getTime();
    const successCount = ctx.executionResults.filter((r) => r.success).length;
    const totalCount = ctx.executionResults.length || 1;
    const score = successCount / totalCount;

    return {
      score,
      latencyMs: durationMs,
      costEfficiency: score / Math.max(ctx.spendAccumulated, 0.001),
      taskPattern: ctx.task.input.slice(0, 64),
      labels: [ctx.task.source],
    };
  }

  /**
   * Convert a task to a 256-dim embedding for SONA trajectory tracking.
   * Simple hash-based approach matching LedgerSkill's pattern.
   */
  private taskToEmbedding(task: HermesTask): number[] {
    const input = `${task.id}:${task.source}:${task.input}`;
    const dim = 256;
    const emb = new Array(dim).fill(0) as number[];
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);
      const idx = (code * 31 + i * 17) % dim;
      emb[idx] = (emb[idx] ?? 0) + ((code * 0.0073) % 1.0);
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      norm += (emb[i] ?? 0) * (emb[i] ?? 0);
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) {
      emb[i] = (emb[i] ?? 0) / norm;
    }
    return emb;
  }

  private abortTrajectory(ctx: HermesContext, reason: string): Trajectory {
    console.warn(`[Hermes] Aborting task ${ctx.task.id}: ${reason}`);
    return {
      taskId: ctx.task.id,
      input: ctx.task.input,
      plan: ctx.plan,
      executionResults: [],
      rewardSignal: { score: 0, latencyMs: 0, costEfficiency: 0, taskPattern: ctx.task.input.slice(0, 64), labels: ["aborted"] },
      totalDurationMs: Date.now() - ctx.startedAt.getTime(),
      totalCostUsd: 0,
      completedAt: new Date(),
    };
  }

  private async humanEscalation(ctx: HermesContext, phase: string): Promise<void> {
    // TODO: Block execution and notify human via Telegram + audit log
    console.warn(`[SPEND GATE] Human approval required at phase=${phase} task=${ctx.task.id} estimatedCost=$${ctx.plan?.estimatedCostUsd ?? "?"}`);
    if ((ctx.plan?.estimatedCostUsd ?? 0) > SPEND_GATE_USD) {
      throw new Error(`[KILL SWITCH] SPEND_GATE_USD=${SPEND_GATE_USD} exceeded — awaiting human approval`);
    }
  }
}
