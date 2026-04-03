/**
 * scripts/multi-turn-demo.ts
 *
 * Runs 5 tasks through HermesLoop in sequence to demonstrate self-improvement.
 * After each task, evaluates the trajectory via SkillEvolution and prints metrics.
 * After all 5, prints top patterns and saves results.
 *
 * Usage: npx tsx scripts/multi-turn-demo.ts
 */

import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { HermesLoop } from "../src/core/loop.js";
import { SkillEvolution } from "../src/skills/evolution.js";
import { HermesMemory } from "../src/brain/ruvector.js";
import type { HermesTask, Trajectory } from "../src/core/loop.js";

const TASKS = [
  "Categorize this expense: $45 coffee shop",
  "Categorize this expense: $38 coffee and snacks",
  "Categorize this expense: $52 lunch meeting",
  "Categorize this expense: $29 coffee shop visit",
  "What pattern have you learned from these 4 coffee/food transactions?",
];

const divider = "═".repeat(60);

interface DemoResult {
  taskId: string;
  input: string;
  rewardScore: number;
  durationMs: number;
  executionSteps: number;
  successRate: number;
  pattern: string | null;
  patternSamples: number;
  patternSuccessRate: number;
}

async function main(): Promise<void> {
  console.log(`\n${divider}`);
  console.log("  HERMES MULTI-TURN DEMO — Self-Improvement Showcase");
  console.log(`${divider}\n`);

  const loop = new HermesLoop();
  const memory = new HermesMemory();
  const skillEvolution = new SkillEvolution(memory);
  const results: DemoResult[] = [];

  for (let i = 0; i < TASKS.length; i++) {
    const input = TASKS[i]!;
    const task: HermesTask = {
      id: randomUUID(),
      input,
      source: "internal",
      recursionDepth: 0,
      submittedAt: new Date(),
    };

    console.log(`\n${"─".repeat(60)}`);
    console.log(`  Task ${i + 1}/${TASKS.length}: ${input}`);
    console.log(`${"─".repeat(60)}`);

    const startMs = Date.now();
    const trajectory: Trajectory = await loop.run(task);
    const wallMs = Date.now() - startMs;

    // Evaluate trajectory for skill evolution
    const evaluation = await skillEvolution.evaluate(trajectory);

    const result: DemoResult = {
      taskId: task.id,
      input,
      rewardScore: trajectory.rewardSignal?.score ?? 0,
      durationMs: wallMs,
      executionSteps: trajectory.executionResults.length,
      successRate: trajectory.executionResults.length > 0
        ? trajectory.executionResults.filter((r) => r.success).length / trajectory.executionResults.length
        : 0,
      pattern: evaluation?.pattern ?? null,
      patternSamples: evaluation?.sampleTrajectories.length ?? 0,
      patternSuccessRate: evaluation?.successRate ?? 0,
    };
    results.push(result);

    // Print per-task metrics
    console.log(`\n  Reward Score:       ${result.rewardScore.toFixed(4)}`);
    console.log(`  Duration:          ${result.durationMs}ms`);
    console.log(`  Execution Steps:   ${result.executionSteps}`);
    console.log(`  Success Rate:      ${(result.successRate * 100).toFixed(1)}%`);
    if (evaluation) {
      console.log(`  Pattern:           "${evaluation.pattern.slice(0, 50)}"`);
      console.log(`  Pattern Samples:   ${evaluation.sampleTrajectories.length}`);
      console.log(`  Pattern Success:   ${(evaluation.successRate * 100).toFixed(1)}%`);
    } else {
      console.log(`  Pattern:           (not enough data yet)`);
    }
  }

  // Print top patterns summary
  console.log(`\n${divider}`);
  console.log("  TOP PATTERNS (by success rate)");
  console.log(`${divider}\n`);

  const topPatterns = skillEvolution.getTopPatterns(3);
  if (topPatterns.length === 0) {
    console.log("  No patterns have reached minimum sample threshold yet.");
    console.log("  (This is expected — the demo runs 5 tasks, threshold is 5 samples.)\n");

    // Show all tracked patterns regardless of threshold
    const allPatterns = skillEvolution.getTopPatterns(3, 1);
    if (allPatterns.length > 0) {
      console.log("  Patterns tracked (below threshold):");
      for (const p of allPatterns) {
        console.log(`    "${p.pattern.slice(0, 50)}" — ${p.totalSamples} samples, ${(p.successRate * 100).toFixed(1)}% success`);
      }
    }
  } else {
    for (const p of topPatterns) {
      console.log(`  "${p.pattern.slice(0, 50)}"`);
      console.log(`    Samples: ${p.totalSamples}  Success: ${(p.successRate * 100).toFixed(1)}%`);
    }
  }

  // Save results
  mkdirSync("data", { recursive: true });
  const output = {
    demo: "multi-turn-self-improvement",
    runAt: new Date().toISOString(),
    taskCount: TASKS.length,
    results,
    topPatterns: skillEvolution.getTopPatterns(3, 1).map((p) => ({
      pattern: p.pattern,
      totalSamples: p.totalSamples,
      successRate: p.successRate,
      trajectoryIds: p.trajectoryIds,
    })),
  };

  const outPath = "data/multi-turn-demo-results.json";
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(`\n${divider}`);
  console.log(`  Results saved to ${outPath}`);
  console.log(`${divider}\n`);
}

main().catch((err) => {
  console.error("[multi-turn-demo] Fatal error:", err);
  process.exit(1);
});
