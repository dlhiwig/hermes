/**
 * scripts/multi-turn-demo.ts
 *
 * Runs 5 tasks through HermesLoop in sequence to demonstrate self-improvement.
 * After each task, evaluates the trajectory via SkillEvolution and prints metrics.
 * After all 5, prints top patterns and saves results.
 *
 * Usage:
 *   npx tsx scripts/multi-turn-demo.ts           # default (uses Ollama)
 *   npx tsx scripts/multi-turn-demo.ts --fast     # uses dolphin-llama3:8b (faster)
 *   npx tsx scripts/multi-turn-demo.ts --mock     # skip Ollama entirely, static responses
 */

import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { HermesLoop } from "../src/core/loop.js";
import { SkillEvolution } from "../src/skills/evolution.js";
import { HermesMemory } from "../src/brain/ruvector.js";
import type { HermesTask, Trajectory } from "../src/core/loop.js";

// ── CLI Flags ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FAST_MODE = args.includes("--fast");
const MOCK_MODE = args.includes("--mock");

const TASK_TIMEOUT_MS = 90_000;

const TASKS = [
  "Categorize this expense: $45 coffee shop",
  "Categorize this expense: $38 coffee and snacks",
  "Categorize this expense: $52 lunch meeting",
  "Categorize this expense: $29 coffee shop visit",
  "What pattern have you learned from these 4 coffee/food transactions?",
];

const MOCK_RESPONSES: Record<number, string> = {
  0: '{"category":"food_beverage","subcategory":"coffee","amount":45,"merchant":"coffee shop","confidence":0.92}',
  1: '{"category":"food_beverage","subcategory":"coffee_snacks","amount":38,"merchant":"coffee and snacks","confidence":0.89}',
  2: '{"category":"food_beverage","subcategory":"business_meal","amount":52,"merchant":"lunch meeting","confidence":0.85}',
  3: '{"category":"food_beverage","subcategory":"coffee","amount":29,"merchant":"coffee shop","confidence":0.94}',
  4: '{"pattern":"food_beverage_recurring","frequency":"high","avg_amount":41.00,"merchants":["coffee shop","coffee and snacks","lunch meeting"],"recommendation":"Consider a food/coffee budget category with $160/month allocation"}',
};

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

// ── Mock Ollama when --mock is set ─────────────────────────────────────────

let currentMockTask = 0;

if (MOCK_MODE) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("11434") || url.includes("ollama")) {
      const mockContent = MOCK_RESPONSES[currentMockTask] ?? '{"result":"mock"}';
      return new Response(
        JSON.stringify({ message: { content: mockContent } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  };
}

// ── Fast mode: override VoltAgent model ────────────────────────────────────

if (FAST_MODE) {
  // Dynamically override all VoltAgent roles to use the smaller model
  import("../src/skills/voltAgent.js").then(({ VOLT_AGENT_ROLES }) => {
    for (const role of Object.values(VOLT_AGENT_ROLES)) {
      role.model = "dolphin-llama3:8b";
    }
  });
}

// ── Task runner with timeout ───────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[Timeout] ${label} exceeded ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const modeLabel = MOCK_MODE ? "MOCK" : FAST_MODE ? "FAST" : "FULL";

  console.log(`\n${divider}`);
  console.log(`  HERMES MULTI-TURN DEMO — Self-Improvement Showcase [${modeLabel}]`);
  console.log(`${divider}\n`);

  const loop = new HermesLoop();
  const memory = new HermesMemory();
  const skillEvolution = new SkillEvolution(memory);
  const results: DemoResult[] = [];

  for (let i = 0; i < TASKS.length; i++) {
    const input = TASKS[i]!;
    currentMockTask = i;

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
    let trajectory: Trajectory;

    try {
      trajectory = await withTimeout(
        loop.run(task),
        TASK_TIMEOUT_MS,
        `Task ${i + 1}`,
      );
    } catch (err) {
      const wallMs = Date.now() - startMs;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Task ${i + 1}/${TASKS.length} FAILED (${(wallMs / 1000).toFixed(1)}s): ${errMsg}`);
      results.push({
        taskId: task.id,
        input,
        rewardScore: 0,
        durationMs: wallMs,
        executionSteps: 0,
        successRate: 0,
        pattern: null,
        patternSamples: 0,
        patternSuccessRate: 0,
      });
      continue;
    }

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

    console.log(`  ✓ Task ${i + 1}/${TASKS.length} complete (${(wallMs / 1000).toFixed(1)}s, reward=${result.rewardScore.toFixed(2)})`);

    if (evaluation) {
      console.log(`    Pattern: "${evaluation.pattern.slice(0, 50)}"`);
      console.log(`    Samples: ${evaluation.sampleTrajectories.length}  Success: ${(evaluation.successRate * 100).toFixed(1)}%`);
    }
  }

  // ── Summary Table ──────────────────────────────────────────────────────

  console.log(`\n${divider}`);
  console.log("  SUMMARY TABLE");
  console.log(`${divider}\n`);

  console.log("  #  Reward   Duration   Steps  Success  Pattern");
  console.log("  " + "─".repeat(56));

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const num = String(i + 1).padStart(2);
    const reward = r.rewardScore.toFixed(2).padStart(6);
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`.padStart(9);
    const steps = String(r.executionSteps).padStart(5);
    const success = `${(r.successRate * 100).toFixed(0)}%`.padStart(7);
    const pat = r.pattern ? `"${r.pattern.slice(0, 25)}"` : "(none)";
    console.log(`  ${num}  ${reward}  ${dur}  ${steps}  ${success}  ${pat}`);
  }

  // ── Top Patterns ───────────────────────────────────────────────────────

  console.log(`\n${divider}`);
  console.log("  TOP PATTERNS (by success rate)");
  console.log(`${divider}\n`);

  const topPatterns = skillEvolution.getTopPatterns(3);
  if (topPatterns.length === 0) {
    console.log("  No patterns have reached minimum sample threshold yet.");

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
    mode: modeLabel,
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
