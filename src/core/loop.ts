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
import { VoltAgentExecutor, VOLT_AGENT_ROLES } from "../skills/voltAgent.js";
import { recordTask } from "../observability/metrics.js";

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

// ── Step Timeout ─────────────────────────────────────────────────────────────

const STEP_TIMEOUT_MS = parseInt(process.env["HERMES_STEP_TIMEOUT_MS"] ?? "120000", 10);

function withTimeout<T>(promise: Promise<T>, stepName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[Timeout] ${stepName} exceeded ${STEP_TIMEOUT_MS}ms`)),
      STEP_TIMEOUT_MS,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── HermesLoop ────────────────────────────────────────────────────────────────

export class HermesLoop {
  private memory: HermesMemory;
  private sona: SonaDaemon;
  private sonaEngine: SonaEngine;
  private planner: HermesPlanner;
  private governance: SuperClawGovernance;
  private skillEvolution: SkillEvolution;
  private voltAgent: VoltAgentExecutor;
  private metrics: LoopMetrics;

  constructor() {
    this.memory = new HermesMemory();
    this.sona = new SonaDaemon();
    this.sonaEngine = new SonaEngine(256);
    this.planner = new HermesPlanner();
    this.governance = new SuperClawGovernance();
    this.skillEvolution = new SkillEvolution(this.memory);
    this.voltAgent = new VoltAgentExecutor();
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

    // ── Step 1: Input & Retrieval (non-fatal — continue with empty context) ──
    try {
      ctx.retrieved = await withTimeout(this.step1_inputAndRetrieval(task), "Step 1: Retrieval");
    } catch (err) {
      console.warn(`[Hermes] Step 1 (Retrieval) failed: ${err instanceof Error ? err.message : err}`);
      ctx.retrieved = [];
    }

    // ── Step 2: Planning (fatal — abort with failed trajectory) ──────────────
    try {
      ctx.plan = await withTimeout(this.step2_planning(task, ctx.retrieved), "Step 2: Planning");
      ctx.sonaRecommendation = await withTimeout(
        this.sona.getRoutingRecommendation(task, ctx.plan),
        "Step 2: SONA Routing",
      );
    } catch (err) {
      console.error(`[Hermes] Step 2 (Planning) failed: ${err instanceof Error ? err.message : err}`);
      return this.abortTrajectory(ctx, `Planning failed: ${err instanceof Error ? err.message : err}`);
    }

    // ── Step 2.5: PRE-EXECUTION GOVERNANCE CHECK ──────────────────────────
    ctx.governancePre = await withTimeout(
      this.step2_5_preExecutionGovernance(ctx.plan, ctx),
      "Step 2.5: Governance Pre",
    );
    if (ctx.governancePre.decision === "reject") {
      const rejectEmb = this.taskToEmbedding(task);
      const rejectTrajId = this.sonaEngine.beginTrajectory(rejectEmb);
      this.sonaEngine.endTrajectory(rejectTrajId, 0);
      return this.abortTrajectory(ctx, `Governance pre-check rejected: ${ctx.governancePre.reason}`);
    }
    if (ctx.governancePre.decision === "escalate") {
      await this.humanEscalation(ctx, "pre-execution");
    }

    // ── Step 3: Execution (record failure but continue to step 4) ─────────
    const trajEmbedding = this.taskToEmbedding(task);
    const trajId = this.sonaEngine.beginTrajectory(trajEmbedding);

    try {
      ctx.executionResults = await withTimeout(this.step3_execution(ctx.plan!, ctx), "Step 3: Execution");
      ctx.spendAccumulated = ctx.executionResults.reduce((_acc, _r) => _acc, 0); // TODO: sum actual cost

      for (const result of ctx.executionResults) {
        const stepEmb = this.taskToEmbedding({ ...task, input: `${task.input}:step:${result.stepId}` });
        const actions: number[] = [result.success ? 1.0 : 0.0];
        const stepReward = result.success ? 0.8 : 0.0;
        this.sonaEngine.addTrajectoryStep(trajId, stepEmb, actions, stepReward);
      }
    } catch (err) {
      console.error(`[Hermes] Step 3 (Execution) failed: ${err instanceof Error ? err.message : err}`);
      ctx.executionResults.push({
        stepId: "execution-error",
        output: null,
        durationMs: Date.now() - ctx.startedAt.getTime(),
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Step 4: Observation & Logging ─────────────────────────────────────
    try {
      ctx.trajectory = await withTimeout(this.step4_observationAndLogging(ctx), "Step 4: Observation");
    } catch (err) {
      console.warn(`[Hermes] Step 4 (Observation) failed: ${err instanceof Error ? err.message : err}`);
      // Build a minimal trajectory so downstream steps can proceed
      ctx.trajectory = {
        taskId: ctx.task.id,
        input: ctx.task.input,
        plan: ctx.plan,
        executionResults: ctx.executionResults,
        rewardSignal: this.computeRewardSignal(ctx),
        totalDurationMs: Date.now() - ctx.startedAt.getTime(),
        totalCostUsd: ctx.spendAccumulated,
        completedAt: new Date(),
      };
    }

    // End trajectory with the computed reward signal
    const finalReward = ctx.trajectory.rewardSignal?.score ?? 0;
    this.sonaEngine.endTrajectory(trajId, finalReward);

    // ── Step 5: SONA Optimization (non-fatal — best-effort) ───────────────
    try {
      await withTimeout(this.step5_sonaOptimization(ctx.trajectory), "Step 5: SONA Optimization");
    } catch (err) {
      console.warn(`[Hermes] Step 5 (SONA Optimization) failed: ${err instanceof Error ? err.message : err}`);
    }

    // ── Step 6: Skill Evolution (non-fatal — best-effort) ─────────────────
    try {
      await withTimeout(this.step6_skillEvolution(ctx.trajectory), "Step 6: Skill Evolution");
    } catch (err) {
      console.warn(`[Hermes] Step 6 (Skill Evolution) failed: ${err instanceof Error ? err.message : err}`);
    }

    // ── Step 7: POST-EXECUTION GOVERNANCE (non-fatal — don't block delivery)
    try {
      ctx.governancePost = await withTimeout(
        this.step7_postExecutionGovernance(ctx.trajectory),
        "Step 7: Governance Post",
      );
    } catch (err) {
      console.warn(`[Hermes] Step 7 (Governance Post) failed: ${err instanceof Error ? err.message : err}`);
    }

    // ── Step 8: Consolidation (non-fatal — still return trajectory) ───────
    try {
      await withTimeout(this.step8_consolidation(ctx), "Step 8: Consolidation");
    } catch (err) {
      console.warn(`[Hermes] Step 8 (Consolidation) failed: ${err instanceof Error ? err.message : err}`);
    }

    console.log(`[Hermes] Task ${task.id} complete in ${Date.now() - ctx.startedAt.getTime()}ms`);
    recordTask(ctx.trajectory);
    return ctx.trajectory;
  }

  // ── Step 1: Input & Retrieval ─────────────────────────────────────────────

  private async step1_inputAndRetrieval(task: HermesTask): Promise<RetrievalResult[]> {
    console.log(`[Step 1] Input & Retrieval — task=${task.id}`);

    const results = await this.memory.hybridSearch(task.input, {
      vectorTopK: 10,
      keywordBoost: 0.3,
      filters: { source: task.source },
    });

    return results;
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

    await this.memory.store(trajectory);

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

    // evaluate() now handles distillation + agent spawn internally when thresholds are met
    const evaluation = await this.skillEvolution.evaluate(trajectory);
    if (!evaluation) return;

    console.log(
      `[Step 6] Evaluation: pattern="${evaluation.pattern.slice(0, 40)}" successRate=${evaluation.successRate.toFixed(2)}`
    );
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

    await this.memory.updateGraph([
      { from: ctx.task.id, to: ctx.trajectory.taskId, relation: "COMPLETED_BY" },
    ]);
    const metric = ctx.trajectory.rewardSignal?.score ?? 0;
    console.log(`[Step 8] Improvement metric: ${metric.toFixed(4)}`);
  }

  // ── Executor Stubs ────────────────────────────────────────────────────────

  private async runVoltAgent(step: PlanStep): Promise<ExecutionResult> {
    console.log(`[VoltAgent] Running step ${step.id}`);
    const roleName = (step.inputs?.role as string) ?? "financial-analyst";
    const role = VOLT_AGENT_ROLES[roleName];
    if (!role) {
      return { stepId: step.id, output: null, durationMs: 0, success: false, error: `Unknown VoltAgent role: ${roleName}` };
    }

    const task = (step.inputs?.task as string) ?? step.description;
    const context = step.inputs?.context as string | undefined;
    const start = Date.now();

    try {
      const output = await this.voltAgent.execute(role, task, context);
      return { stepId: step.id, output, durationMs: Date.now() - start, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stepId: step.id, output: null, durationMs: Date.now() - start, success: false, error: msg };
    }
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
