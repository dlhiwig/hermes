/**
 * Hermes Planner — gstack + ruflo + deer-flow integration
 *
 * Orchestrates planning across three systems:
 *  - gstack: structured plan → build → QA → ship gates
 *  - ruflo: multi-agent hive-mind spawning (CLI integration via child_process)
 *  - deer-flow: long-horizon sub-agent decomposition (Ollama Qwen3.5)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HermesTask, HermesPlan, PlanStep, RetrievalResult } from "../core/loop.js";

const execFileAsync = promisify(execFile);

const RUFLO_BIN = "ruflo";
const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_MODEL = "qwen3.5:27b";
const MAX_RECURSION_DEPTH = 5;

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
    const blockers: string[] = [];
    const checklist: string[] = [];

    // Gate 1: Task input must be substantive
    if (task.input.length > 10) {
      checklist.push("Task input is substantive (>10 chars) ✓");
    } else {
      blockers.push(`Task input too short (${task.input.length} chars, need >10)`);
    }

    // Gate 2: Recursion depth within safety limit
    if (task.recursionDepth < MAX_RECURSION_DEPTH) {
      checklist.push(`Recursion depth ${task.recursionDepth}/${MAX_RECURSION_DEPTH} ✓`);
    } else {
      blockers.push(`Recursion depth ${task.recursionDepth} exceeds max ${MAX_RECURSION_DEPTH}`);
    }

    // Gate 3: Retrieved context quality
    // Empty context is OK (e.g. Phase 1 when RuVector is empty) — only block
    // when documents ARE present but all have garbage scores (< 0.2).
    if (context.length === 0) {
      checklist.push("No context docs (empty RuVector) — proceeding without context ✓");
      console.warn("[gstack] Warning: no context documents retrieved — RuVector may be empty");
    } else {
      const usableDocs = context.filter((c) => c.score >= 0.2);
      if (usableDocs.length > 0) {
        checklist.push(`Usable context docs (score ≥ 0.2): ${usableDocs.length}/${context.length} ✓`);
      } else {
        blockers.push(
          `All ${context.length} context docs have score < 0.2 (best: ${Math.max(...context.map((c) => c.score)).toFixed(2)}) — garbage context is worse than none`
        );
      }
    }

    const passed = blockers.length === 0;
    const gate: GStackGate = { name: "plan", passed, blockers, checklist };

    console.log(`[gstack] plan gate — passed=${passed} blockers=${blockers.length}`);
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
    const hiveId = `hive_${task.id}`;
    const agentGoals = decomposition.subGoals.filter((g) => g.requiresSubAgent);

    // Initialize ruflo swarm in v3 mode
    try {
      const { stdout: swarmOut } = await execFileAsync(RUFLO_BIN, [
        "swarm",
        "init",
        "--v3-mode",
      ]);
      console.log(`[Ruflo] Swarm init: ${swarmOut.trim()}`);
    } catch (err) {
      console.warn(`[Ruflo] Swarm init failed, continuing with agent spawn: ${err}`);
    }

    // Spawn one agent per sub-goal that requires a sub-agent
    const agents: RufloAgent[] = [];
    for (const [i, goal] of agentGoals.entries()) {
      const agentId = `ruflo_${task.id}_${i}`;
      try {
        const { stdout } = await execFileAsync(RUFLO_BIN, [
          "agent",
          "spawn",
          "--id",
          agentId,
          "--role",
          goal.description.slice(0, 80),
        ]);
        console.log(`[Ruflo] Spawned agent ${agentId}: ${stdout.trim()}`);
        agents.push({
          agentId,
          role: goal.description.slice(0, 40),
          capabilities: ["research", "code", "plan"],
          status: "running",
        });
      } catch (err) {
        console.warn(`[Ruflo] Agent spawn failed for ${agentId}: ${err}`);
        agents.push({
          agentId,
          role: goal.description.slice(0, 40),
          capabilities: ["research", "code", "plan"],
          status: "failed",
        });
      }
    }

    const hive: RufloHive = {
      hiveId,
      agents,
      coordinationStrategy: agentGoals.length > 3 ? "consensus" : "parallel",
    };

    console.log(`[Ruflo] Spawned hive=${hive.hiveId} agents=${agents.length}`);
    return hive;
  }

  // ── deer-flow Decomposition ───────────────────────────────────────────────

  /**
   * Decompose a high-level task into hierarchical sub-goals using deer-flow.
   */
  async deerFlowDecompose(task: HermesTask): Promise<DeerFlowDecomposition> {
    // Try Ollama Qwen3.5 for intelligent decomposition, fall back to static split
    try {
      return await this.ollamaDecompose(task);
    } catch (err) {
      console.warn(`[DeerFlow] Ollama decomposition failed, using static fallback: ${err}`);
      return this.staticDecompose(task);
    }
  }

  private async ollamaDecompose(task: HermesTask): Promise<DeerFlowDecomposition> {
    const prompt = [
      "You are a task decomposition engine. Break the following task into 2-5 concrete sub-goals.",
      "Respond ONLY with valid JSON matching this schema (no markdown, no explanation):",
      '{"subGoals":[{"id":"sg_0","description":"...","complexity":"low|medium|high","requiresSubAgent":true|false}]}',
      "",
      `Task: ${task.input}`,
      task.context ? `Context: ${JSON.stringify(task.context)}` : "",
    ].join("\n");

    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    });

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { response: string };
    const parsed = JSON.parse(data.response) as {
      subGoals: Array<{
        id: string;
        description: string;
        complexity: "low" | "medium" | "high";
        requiresSubAgent: boolean;
      }>;
    };

    const subGoals: SubGoal[] = parsed.subGoals.slice(0, 5).map((sg, i) => ({
      id: `sg_${task.id}_${i}`,
      description: sg.description,
      estimatedComplexity: sg.complexity,
      requiresSubAgent: sg.requiresSubAgent,
    }));

    // Build linear dependency chain
    const dependencyGraph: Record<string, string[]> = {};
    for (let i = 1; i < subGoals.length; i++) {
      dependencyGraph[subGoals[i]!.id] = [subGoals[i - 1]!.id];
    }

    console.log(`[DeerFlow] Ollama decomposed into ${subGoals.length} sub-goals`);
    return { rootGoal: task.input, subGoals, dependencyGraph };
  }

  private staticDecompose(task: HermesTask): DeerFlowDecomposition {
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
