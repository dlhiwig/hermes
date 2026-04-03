/**
 * SuperClaw Governance Layer
 *
 * SuperClaw is the capability proof governance system. It runs at two mandatory
 * checkpoints in every loop iteration:
 *
 *   Step 2.5 — PRE-EXECUTION: approve/reject/escalate the plan before any
 *               executor is started.
 *
 *   Step 7   — POST-EXECUTION: review the completed trajectory, refine policy,
 *               and feed back into the routing table.
 *
 * SuperClaw validates:
 *   - Capability proofs (cryptographic proof that an executor is authorized)
 *   - PII / sensitive data detection
 *   - Cost projection vs. SPEND_GATE_USD
 *   - Prompt injection patterns
 */

import type { HermesTask, HermesPlan, Trajectory, ExecutionResult, GovernanceResult, PlanStep } from "../core/loop.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CapabilityProof {
  executorId: string;
  capabilityHash: string;
  issuedAt: Date;
  expiresAt: Date;
  signature: string;
}

export interface PolicyRule {
  id: string;
  description: string;
  condition: string; // DSL expression — TODO: implement evaluator
  action: "approve" | "reject" | "escalate";
  priority: number;
}

export interface PolicyRefinement {
  ruleId: string;
  delta: Partial<PolicyRule>;
  sourceTrajectoryId: string;
  confidence: number;
}

// ── SuperClawGovernance ───────────────────────────────────────────────────────

export class SuperClawGovernance {
  private endpoint: string;
  private policyRules: PolicyRule[];
  private proofCache: Map<string, CapabilityProof>;

  constructor() {
    this.endpoint = process.env["SUPERCLAW_ENDPOINT"] ?? "http://localhost:9090";
    this.proofCache = new Map();

    // Default policy rules (will be refined by postExecutionReview)
    this.policyRules = [
      {
        id: "pii-block",
        description: "Block tasks that expose PII without explicit consent",
        condition: "task.hasPII && !task.consentGranted",
        action: "reject",
        priority: 100,
      },
      {
        id: "spend-gate",
        description: "Escalate tasks that exceed the spend gate",
        condition: "plan.estimatedCostUsd > SPEND_GATE_USD",
        action: "escalate",
        priority: 90,
      },
      {
        id: "injection-block",
        description: "Block detected prompt injection attempts",
        condition: "task.promptInjectionScore > 0.8",
        action: "reject",
        priority: 95,
      },
    ];

    console.log(`[SuperClaw] Initialized — endpoint=${this.endpoint}`);
  }

  // ── Pre-Execution Check (Step 2.5) ────────────────────────────────────────

  /**
   * MUST be called before any executor runs.
   * Returns approve/reject/escalate with full audit trail.
   */
  async preExecutionCheck(
    plan: HermesPlan | null,
    task: HermesTask
  ): Promise<GovernanceResult> {
    console.log(`[SuperClaw] Pre-execution check — task=${task.id}`);

    const piiRisk = await this.detectPII(task.input);
    const injectionDetected = await this.detectPromptInjection(task.input);
    const projectedCost = plan?.estimatedCostUsd ?? 0;

    // TODO: POST to SuperClaw endpoint for authoritative governance decision
    // const response = await fetch(`${this.endpoint}/governance/pre-execution`, {
    //   method: "POST",
    //   body: JSON.stringify({ task, plan, piiRisk, injectionDetected, projectedCost }),
    // });
    // return response.json();

    let decision: GovernanceResult["decision"] = "approve";
    let reason = "All pre-execution checks passed";

    if (injectionDetected) {
      decision = "reject";
      reason = "Prompt injection detected in task input";
    } else if (piiRisk && !task.context?.["consentGranted"]) {
      decision = "reject";
      reason = "PII detected without explicit consent";
    } else if (projectedCost > 50) {
      decision = "escalate";
      reason = `Projected cost $${projectedCost} exceeds SPEND_GATE_USD=$50 — human approval required`;
    }

    const result: GovernanceResult = {
      decision,
      reason,
      proofHash: await this.generateProofHash(task.id, plan?.id ?? ""),
      piiRisk,
      projectedCostUsd: projectedCost,
      promptInjectionDetected: injectionDetected,
    };

    console.log(`[SuperClaw] Pre-execution result — decision=${result.decision} reason="${result.reason}"`);
    return result;
  }

  // ── Post-Execution Review (Step 7) ────────────────────────────────────────

  /**
   * MUST be called after every execution, even on failure.
   * Reviews the trajectory and refines policy rules.
   */
  async postExecutionReview(trajectory: Trajectory): Promise<GovernanceResult> {
    console.log(`[SuperClaw] Post-execution review — taskId=${trajectory.taskId}`);

    const piiRisk = await this.detectPII(JSON.stringify(trajectory.executionResults));
    const success = trajectory.executionResults.every((r) => r.success);

    // TODO: POST to SuperClaw for authoritative post-execution review
    // const response = await fetch(`${this.endpoint}/governance/post-execution`, {
    //   method: "POST",
    //   body: JSON.stringify({ trajectory }),
    // });

    const result: GovernanceResult = {
      decision: success ? "approve" : "reject",
      reason: success ? "Trajectory completed successfully" : "One or more steps failed",
      piiRisk,
      projectedCostUsd: trajectory.totalCostUsd,
      promptInjectionDetected: false,
    };

    // Trigger policy refinement based on failures
    if (!success) {
      await this.refinePolicy(
        trajectory.executionResults.filter((r) => !r.success)
      );
    }

    console.log(`[SuperClaw] Post-execution result — decision=${result.decision}`);
    return result;
  }

  // ── Per-Step Proof Validation ─────────────────────────────────────────────

  /**
   * Validates the capability proof attached to an executor's result.
   * Called after each step in Step 3.
   */
  async validateProof(proofHash: string, step: PlanStep): Promise<boolean> {
    if (!proofHash) {
      // Non-critical executors may not provide proofs in Phase 0
      return true;
    }

    const cached = this.proofCache.get(proofHash);
    if (cached && cached.expiresAt > new Date()) {
      return true;
    }

    // TODO: POST to SuperClaw proof validation endpoint
    // const valid = await fetch(`${this.endpoint}/proof/validate`, {
    //   method: "POST",
    //   body: JSON.stringify({ proofHash, executorId: step.executor }),
    // }).then((r) => r.json());

    console.log(`[SuperClaw] validateProof — step=${step.id} hash=${proofHash.slice(0, 16)}...`);
    return true; // stub: all proofs valid in Phase 0
  }

  // ── Policy Refinement ─────────────────────────────────────────────────────

  /**
   * Refine policy rules based on observed failures.
   * Called from postExecutionReview when steps fail.
   */
  async refinePolicy(failures: ExecutionResult[]): Promise<PolicyRefinement[]> {
    console.log(`[SuperClaw] refinePolicy — failures=${failures.length}`);

    // TODO: Analyze failure patterns and adjust policy rules
    // const refinements = await fetch(`${this.endpoint}/policy/refine`, {
    //   method: "POST",
    //   body: JSON.stringify({ failures, currentRules: this.policyRules }),
    // }).then((r) => r.json());

    const refinements: PolicyRefinement[] = failures.map((f) => ({
      ruleId: "auto-refined",
      delta: {},
      sourceTrajectoryId: f.stepId,
      confidence: 0,
    }));

    return refinements;
  }

  // ── Detection Utilities ───────────────────────────────────────────────────

  private async detectPII(text: string): Promise<boolean> {
    // TODO: Real PII detection (email, SSN, credit card, phone patterns)
    // Simple heuristic for Phase 0
    const piiPatterns = [
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,          // email
      /\b\d{3}-\d{2}-\d{4}\b/,                                  // SSN
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,           // credit card
    ];
    return piiPatterns.some((p) => p.test(text));
  }

  private async detectPromptInjection(text: string): Promise<boolean> {
    // TODO: Real injection detection (model-based or rule-based)
    const injectionSignals = [
      "ignore previous instructions",
      "system prompt",
      "jailbreak",
      "disregard all prior",
      "<|im_start|>system",
      "<!-- override -->",
    ];
    const lower = text.toLowerCase();
    return injectionSignals.some((s) => lower.includes(s));
  }

  private async generateProofHash(taskId: string, planId: string): Promise<string> {
    // TODO: Cryptographic proof generation (Blake3 or SHA-256)
    // const data = `${taskId}:${planId}:${Date.now()}`;
    // return crypto.createHash("sha256").update(data).digest("hex");
    return `proof_${taskId}_${planId}`.slice(0, 32);
  }
}
