/**
 * Hermes Planner — gstack + ruflo + deer-flow integration
 *
 * Orchestrates planning across three systems:
 *  - gstack: structured plan → build → QA → ship gates
 *  - ruflo: multi-agent hive-mind spawning
 *  - deer-flow: long-horizon sub-agent decomposition
 */

import type { HermesTask, HermesPlan, PlanStep, RetrievalResult } from "../core/loop.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GStackGate {
  name: "plan" | "build" | "qa" | "ship";
  passed: boolean;
  blockers: string[];
  checklist: string[];
}

export interface RufloHive {
  hiveId: string;
  agents: RufloAgent[];
  coordinationStrategy: "consensus" | "leader" | "parallel";
}

export interface RufloAgent {
  agentId: string;
  role: string;
  capabilities: string[];
  status: "idle" | "running" | "done" | "failed";
}

export interface DeerFlowDecomposition {
  rootGoal: string;
  subGoals: SubGoal[];
  dependencyGraph: Record<string, string[]>;
}

export interface SubGoal {
  id: string;
  description: string;
  estimatedComplexity: "low" | "medium" | "high";
  requiresSubAgent: boolean;
}

// ── HermesPlanner ─────────────────────────────────────────────────────────────

export class HermesPlanner {
  constructor() {
    console.log("[Planner] Initialized");
  }

  /**
   * Main planning entry point.
   * Runs gstack gates, ruflo spawn, and deer-flow decomposition in order.
   */
  async plan(
    task: HermesTask,
    retrievedContext: RetrievalResult[]
  ): Promise<HermesPlan> {
    console.log(`[Planner] Planning task=${task.id}`);

    // 1. gstack gate: plan phase
    const planGate = await this.gstackPlan(task, retrievedContext);
    if (!planGate.passed) {
      console.warn(`[Planner] gstack plan gate failed: ${planGate.blockers.join(", ")}`);
    }

    // 2. deer-flow: decompose into sub-goals
    const decomposition = await this.deerFlowDecompose(task);

    // 3. ruflo: spawn hive if complexity warrants it
    let hive: RufloHive | null = null;
    if (decomposition.subGoals.some((g) => g.requiresSubAgent)) {
      hive = await this.rufloSpawnHive(task, decomposition);
    }

    // 4. Assemble plan steps from decomposition
    const steps = this.assembleSteps(decomposition, hive);

    const plan: HermesPlan = {
      id: `plan_${task.id}_${Date.now()}`,
      steps,
      estimatedCostUsd: this.estimateCost(steps),
      estimatedDurationMs: this.estimateDuration(steps),
      subAgents: hive?.agents.map((a) => a.agentId) ?? [],
      gstackGates: ["plan"], // will grow as gates pass
    };

    console.log(
      `[Planner] Plan assembled — steps=${steps.length} estimatedCost=$${plan.estimatedCostUsd} subAgents=${plan.subAgents.length}`
    );

    return plan;
  }

  // ── gstack Gates ──────────────────────────────────────────────────────────

  /**
   * gstack PLAN gate — validates the task is well-formed and retrievable context
   * is sufficient before committing to execution.
   */
  async gstackPlan(task: HermesTask, context: RetrievalResult[]): Promise<GStackGate> {
    // TODO: Call gstack plan gate CLI or API
    // const result = await gstack.gate("plan", { task, context });

    const gate: GStackGate = {
      name: "plan",
      passed: context.length >= 0, // placeholder — always passes in stub
      blockers: [],
      checklist: [
        "Task has a clear input ✓",
        "Recursion depth within limit ✓",
        `Context documents retrieved: ${context.length}`,
      ],
    };

    console.log(`[gstack] plan gate — passed=${gate.passed}`);
    return gate;
  }

  /**
   * gstack BUILD gate — validates execution artifacts before QA.
   */
  async gstackBuild(planId: string): Promise<GStackGate> {
    // TODO: gstack.gate("build", { planId })
    console.log(`[gstack] build gate — planId=${planId}`);
    return { name: "build", passed: true, blockers: [], checklist: [] };
  }

  /**
   * gstack QA gate — runs automated quality checks on execution results.
   */
  async gstackQA(planId: string): Promise<GStackGate> {
    // TODO: gstack.gate("qa", { planId })
    console.log(`[gstack] QA gate — planId=${planId}`);
    return { name: "qa", passed: true, blockers: [], checklist: [] };
  }

  /**
   * gstack SHIP gate — final validation before results are delivered.
   */
  async gstackShip(planId: string): Promise<GStackGate> {
    // TODO: gstack.gate("ship", { planId })
    console.log(`[gstack] ship gate — planId=${planId}`);
    return { name: "ship", passed: true, blockers: [], checklist: [] };
  }

  // ── ruflo Hive-Mind ───────────────────────────────────────────────────────

  /**
   * Spawn a ruflo hive-mind: a coordinated pool of sub-agents.
   * Each agent receives a role derived from deer-flow sub-goals.
   */
  async rufloSpawnHive(
    task: HermesTask,
    decomposition: DeerFlowDecomposition
  ): Promise<RufloHive> {
    // TODO: const ruflo = new RufloClient({ apiKey: process.env.RUFLO_API_KEY });
    // const hive = await ruflo.spawnHive({
    //   taskId: task.id,
    //   subGoals: decomposition.subGoals,
    //   coordinationStrategy: "parallel",
    // });

    const agents: RufloAgent[] = decomposition.subGoals
      .filter((g) => g.requiresSubAgent)
      .map((g, i) => ({
        agentId: `ruflo_${task.id}_${i}`,
        role: g.description.slice(0, 40),
        capabilities: ["research", "code", "plan"],
        status: "idle" as const,
      }));

    const hive: RufloHive = {
      hiveId: `hive_${task.id}`,
      agents,
      coordinationStrategy: "parallel",
    };

    console.log(`[Ruflo] Spawned hive=${hive.hiveId} agents=${agents.length}`);
    return hive;
  }

  // ── deer-flow Decomposition ───────────────────────────────────────────────

  /**
   * Decompose a high-level task into hierarchical sub-goals using deer-flow.
   */
  async deerFlowDecompose(task: HermesTask): Promise<DeerFlowDecomposition> {
    // TODO: const deerFlow = new DeerFlowClient();
    // return await deerFlow.decompose({
    //   goal: task.input,
    //   context: task.context,
    //   maxDepth: 3,
    //   sandbox: process.env.DEER_FLOW_SANDBOX === "true",
    // });

    const subGoals: SubGoal[] = [
      {
        id: `sg_${task.id}_0`,
        description: `Research and retrieve context for: ${task.input.slice(0, 50)}`,
        estimatedComplexity: "low",
        requiresSubAgent: false,
      },
      {
        id: `sg_${task.id}_1`,
        description: `Execute primary task: ${task.input.slice(0, 50)}`,
        estimatedComplexity: "medium",
        requiresSubAgent: false,
      },
    ];

    return {
      rootGoal: task.input,
      subGoals,
      dependencyGraph: {
        [`sg_${task.id}_1`]: [`sg_${task.id}_0`],
      },
    };
  }

  // ── Step Assembly ─────────────────────────────────────────────────────────

  private assembleSteps(
    decomposition: DeerFlowDecomposition,
    hive: RufloHive | null
  ): PlanStep[] {
    const steps: PlanStep[] = decomposition.subGoals.map((goal) => ({
      id: goal.id,
      description: goal.description,
      executor: goal.requiresSubAgent
        ? ("ruflo" as const)
        : goal.estimatedComplexity === "high"
          ? ("deerFlow" as const)
          : ("voltAgent" as const),
      dependencies: decomposition.dependencyGraph[goal.id] ?? [],
      inputs: { goalDescription: goal.description },
    }));

    void hive; // hive metadata is tracked separately in plan.subAgents
    return steps;
  }

  private estimateCost(steps: PlanStep[]): number {
    // TODO: Real cost model per executor type
    return steps.length * 0.01;
  }

  private estimateDuration(steps: PlanStep[]): number {
    // TODO: Real duration model based on complexity and dependencies
    return steps.length * 2000;
  }
}
