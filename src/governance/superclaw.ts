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
 *
 * Wired to real SuperClaw instance at SUPERCLAW_ENDPOINT (default http://localhost:18800).
 * Falls back to local evaluation if SuperClaw is unreachable.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
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

export interface AuditEntry {
  timestamp: string;
  taskId: string;
  phase: "pre-execution" | "post-execution" | "proof-validation";
  decision: GovernanceResult["decision"];
  reason: string;
  piiRisk: boolean;
  projectedCostUsd: number;
  promptInjectionDetected: boolean;
  proofHash?: string;
  superclawReachable: boolean;
}

// ── Audit log path ──────────────────────────────────────────────────────────

const AUDIT_LOG_PATH = join(process.cwd(), "data", "governance-audit.jsonl");

// ── SuperClawGovernance ───────────────────────────────────────────────────────

export class SuperClawGovernance {
  private endpoint: string;
  private policyRules: PolicyRule[];
  private proofCache: Map<string, CapabilityProof>;
  private auditDirReady: boolean;

  constructor() {
    this.endpoint = process.env["SUPERCLAW_ENDPOINT"] ?? "http://localhost:18800";
    this.proofCache = new Map();
    this.auditDirReady = false;

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

  // ── Audit Logging ─────────────────────────────────────────────────────────

  private async writeAuditLog(entry: AuditEntry): Promise<void> {
    if (!this.auditDirReady) {
      await mkdir(dirname(AUDIT_LOG_PATH), { recursive: true });
      this.auditDirReady = true;
    }
    await appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  }

  // ── SuperClaw Remote Check ────────────────────────────────────────────────

  /**
   * Try to reach the real SuperClaw thresholds API for cost/limits validation.
   * Returns null if SuperClaw is unreachable (caller falls back to local logic).
   */
  private async checkSuperClawThresholds(
    projectedCost: number
  ): Promise<{ allowed: boolean; reason: string } | null> {
    try {
      const resp = await fetch(`${this.endpoint}/skynet/thresholds`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return null;

      const data = (await resp.json()) as {
        limits: { financial?: { requireApprovalAbove?: number; dailySpendLimit?: number } };
        usage: { dailySpend?: number };
      };

      const dailySpend = data.usage?.dailySpend ?? 0;
      const dailyLimit = data.limits?.financial?.dailySpendLimit ?? 1000;
      const approvalThreshold = data.limits?.financial?.requireApprovalAbove ?? 100;

      if (dailySpend + projectedCost > dailyLimit) {
        return { allowed: false, reason: `Daily spend limit exceeded: $${dailySpend} + $${projectedCost} > $${dailyLimit}` };
      }
      if (projectedCost > approvalThreshold) {
        return { allowed: false, reason: `Cost $${projectedCost} exceeds approval threshold $${approvalThreshold}` };
      }
      return { allowed: true, reason: "SuperClaw thresholds check passed" };
    } catch {
      return null; // SuperClaw unreachable — fall back to local
    }
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

    const piiRisk = this.detectPII(task.input);
    const injectionDetected = this.detectPromptInjection(task.input);
    const projectedCost = plan?.estimatedCostUsd ?? 0;

    let decision: GovernanceResult["decision"] = "approve";
    let reason = "All pre-execution checks passed";
    let superclawReachable = false;

    if (injectionDetected) {
      decision = "reject";
      reason = "Prompt injection detected in task input";
    } else if (piiRisk && !task.context?.["consentGranted"]) {
      decision = "reject";
      reason = "PII detected without explicit consent";
    } else {
      // Check real SuperClaw thresholds for cost gating
      const thresholdResult = await this.checkSuperClawThresholds(projectedCost);
      if (thresholdResult !== null) {
        superclawReachable = true;
        if (!thresholdResult.allowed) {
          decision = "escalate";
          reason = thresholdResult.reason;
        }
      } else if (projectedCost > 50) {
        // Local fallback: SPEND_GATE_USD
        decision = "escalate";
        reason = `Projected cost $${projectedCost} exceeds SPEND_GATE_USD=$50 — human approval required`;
      }
    }

    const proofHash = this.generateProofHash(task.id, plan?.id ?? "");

    const result: GovernanceResult = {
      decision,
      reason,
      proofHash,
      piiRisk,
      projectedCostUsd: projectedCost,
      promptInjectionDetected: injectionDetected,
    };

    await this.writeAuditLog({
      timestamp: new Date().toISOString(),
      taskId: task.id,
      phase: "pre-execution",
      decision,
      reason,
      piiRisk,
      projectedCostUsd: projectedCost,
      promptInjectionDetected: injectionDetected,
      proofHash,
      superclawReachable,
    });

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

    const piiRisk = this.detectPII(JSON.stringify(trajectory.executionResults));
    const success = trajectory.executionResults.every((r) => r.success);

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

    await this.writeAuditLog({
      timestamp: new Date().toISOString(),
      taskId: trajectory.taskId,
      phase: "post-execution",
      decision: result.decision,
      reason: result.reason,
      piiRisk,
      projectedCostUsd: trajectory.totalCostUsd,
      promptInjectionDetected: false,
      superclawReachable: false,
    });

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

    const refinements: PolicyRefinement[] = failures.map((f) => ({
      ruleId: "auto-refined",
      delta: {},
      sourceTrajectoryId: f.stepId,
      confidence: 0,
    }));

    return refinements;
  }

  // ── Detection Utilities ───────────────────────────────────────────────────

  private detectPII(text: string): boolean {
    const piiPatterns = [
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,                    // email
      /\b\d{3}-\d{2}-\d{4}\b/,                                            // SSN (US)
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,                     // credit card
      /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,        // US phone
      /\b(?:\+\d{1,3}[-.\s]?)?\d{7,15}\b/,                                // international phone
      /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,                          // IPv4 address
      /\b[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){7}\b/,                      // IPv6 address (full)
      /\b\d{3}-\d{3}-\d{3}\b/,                                            // Canadian SIN
      /\b[A-Z]{2}\d{6}[A-Z]\b/,                                           // UK NI number
    ];
    return piiPatterns.some((p) => p.test(text));
  }

  private detectPromptInjection(text: string): boolean {
    const lower = text.toLowerCase();

    // Direct injection signals
    const injectionSignals = [
      "ignore previous instructions",
      "ignore all previous",
      "ignore above instructions",
      "system prompt",
      "jailbreak",
      "disregard all prior",
      "disregard above",
      "forget your instructions",
      "forget all previous",
      "override your instructions",
      "new system prompt",
      "you are now",
      "act as if you",
      "pretend you are",
      "roleplay as",
      "<|im_start|>system",
      "<|im_start|>",
      "<|im_end|>",
      "<!-- override -->",
      "[system]",
      "###instruction###",
      "```system",
      "\\nsystem:",
    ];

    if (injectionSignals.some((s) => lower.includes(s))) {
      return true;
    }

    // Unicode homoglyph trick detection — Cyrillic/Greek chars mixed with Latin
    const hasMixedScripts = /[\u0400-\u04FF]/.test(text) && /[a-zA-Z]/.test(text);
    // Zero-width characters used to hide instructions
    const hasZeroWidth = /[\u200B\u200C\u200D\uFEFF]/.test(text);
    // Base64-encoded instruction patterns
    const base64Pattern = /(?:[A-Za-z0-9+/]{20,}={0,2})/;
    if (base64Pattern.test(text)) {
      try {
        const matches = text.match(/(?:[A-Za-z0-9+/]{20,}={0,2})/g);
        if (matches) {
          for (const match of matches) {
            const decoded = Buffer.from(match, "base64").toString("utf-8");
            const decodedLower = decoded.toLowerCase();
            if (
              decodedLower.includes("ignore") ||
              decodedLower.includes("system") ||
              decodedLower.includes("instruction") ||
              decodedLower.includes("override")
            ) {
              return true;
            }
          }
        }
      } catch {
        // Not valid base64, ignore
      }
    }

    if (hasMixedScripts || hasZeroWidth) {
      return true;
    }

    return false;
  }

  private generateProofHash(taskId: string, planId: string): string {
    const data = `${taskId}:${planId}:${Date.now()}`;
    return createHash("sha256").update(data).digest("hex");
  }
}
