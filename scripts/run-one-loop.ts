/**
 * scripts/run-one-loop.ts
 *
 * Run one real transaction through the full Hermes 8-step loop.
 * Usage: npx tsx scripts/run-one-loop.ts
 */

import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { HermesLoop } from "../src/core/loop.js";
import type { HermesTask, Trajectory } from "../src/core/loop.js";

const TASK: HermesTask = {
  id: randomUUID(),
  input:
    "Analyze this ledger transaction: salary deposit of $5200 on 2025-06-01. Categorize it and recommend savings allocation.",
  source: "internal",
  recursionDepth: 0,
  submittedAt: new Date(),
};

function printTrajectory(trajectory: Trajectory, durationMs: number): void {
  const divider = "═".repeat(60);

  console.log(`\n${divider}`);
  console.log("  HERMES LOOP — TRAJECTORY REPORT");
  console.log(divider);

  console.log(`\n  Task ID:       ${trajectory.taskId}`);
  console.log(`  Input:         ${trajectory.input.slice(0, 80)}`);
  console.log(`  Completed At:  ${trajectory.completedAt.toISOString()}`);

  console.log(`\n  ── Reward Signal ──`);
  if (trajectory.rewardSignal) {
    const rs = trajectory.rewardSignal;
    console.log(`  Score:           ${rs.score.toFixed(4)}`);
    console.log(`  Latency:         ${rs.latencyMs}ms`);
    console.log(`  Cost Efficiency: ${rs.costEfficiency.toFixed(4)}`);
    console.log(`  Task Pattern:    ${rs.taskPattern}`);
    console.log(`  Labels:          ${rs.labels.join(", ")}`);
  } else {
    console.log(`  (no reward signal)`);
  }

  console.log(`\n  ── Plan ──`);
  if (trajectory.plan) {
    console.log(`  Steps:           ${trajectory.plan.steps.length}`);
    console.log(`  Est. Cost:       $${trajectory.plan.estimatedCostUsd.toFixed(4)}`);
    console.log(`  Est. Duration:   ${trajectory.plan.estimatedDurationMs}ms`);
    console.log(`  Sub-Agents:      ${trajectory.plan.subAgents.join(", ") || "(none)"}`);
    console.log(`  gstack Gates:    ${trajectory.plan.gstackGates.join(", ") || "(none)"}`);
    for (const step of trajectory.plan.steps) {
      console.log(`    [${step.executor}] ${step.id}: ${step.description}`);
    }
  } else {
    console.log(`  (no plan)`);
  }

  console.log(`\n  ── Execution Results (${trajectory.executionResults.length} steps) ──`);
  for (const result of trajectory.executionResults) {
    const status = result.success ? "OK" : "FAIL";
    const proof = result.proofHash ? ` proof=${result.proofHash.slice(0, 12)}...` : "";
    const err = result.error ? ` error="${result.error}"` : "";
    console.log(`    [${status}] ${result.stepId} — ${result.durationMs}ms${proof}${err}`);
  }

  console.log(`\n  ── Totals ──`);
  console.log(`  Duration:        ${trajectory.totalDurationMs}ms (wall: ${durationMs}ms)`);
  console.log(`  Cost:            $${trajectory.totalCostUsd.toFixed(4)}`);

  console.log(`\n${divider}\n`);
}

async function main(): Promise<void> {
  console.log("[run-one-loop] Starting Hermes loop test...");
  console.log(`[run-one-loop] Task: ${TASK.input}`);
  console.log(`[run-one-loop] Task ID: ${TASK.id}\n`);

  const loop = new HermesLoop();
  const startMs = Date.now();

  const trajectory = await loop.run(TASK);

  const wallMs = Date.now() - startMs;

  // Print full trajectory report
  printTrajectory(trajectory, wallMs);

  // Save trajectory JSON
  mkdirSync("data", { recursive: true });
  const outPath = "data/test-trajectory.json";
  writeFileSync(outPath, JSON.stringify(trajectory, null, 2), "utf-8");
  console.log(`[run-one-loop] Trajectory saved to ${outPath}`);

  // Print SONA stats summary
  console.log("\n  ── SONA Stats ──");
  console.log(`  Routing table version: (inline — no daemon started)`);
  console.log(`  Trajectory buffer:     1 (recorded in-loop)`);
  console.log(`  EWC++ Micro-LoRA:      applied (reward=${trajectory.rewardSignal?.score.toFixed(4) ?? "N/A"})`);

  console.log("\n[run-one-loop] Done.");
}

main().catch((err) => {
  console.error("[run-one-loop] Fatal error:", err);
  process.exit(1);
});
