/**
 * planner-fallback.test.ts
 *
 * Regression guard: planner must always return a plan even when
 * all Ollama models are unavailable (timeout or unreachable).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HermesPlanner as Planner } from "../orchestration/planner.js";
import type { HermesTask } from "../core/loop.js";

const TASK: HermesTask = {
  id: "test-fallback-001",
  input: "Analyze AMEX charge $47.23 dining restaurant",
  source: "internal",
  recursionDepth: 0,
  submittedAt: new Date(),
};

describe("Planner fallback chain", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("falls back to static decompose when all Ollama models fail", async () => {
    // Simulate all models failing immediately (ECONNREFUSED / network error)
    globalThis.fetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed")
    ) as typeof fetch;

    const planner = new Planner();
    const result = await planner.deerFlowDecompose(TASK);

    expect(result).toBeTruthy();
    expect(result.subGoals.length).toBeGreaterThan(0);
    expect(result.rootGoal).toBe(TASK.input);
  });

  it("falls back to static decompose when Ollama returns non-JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "not json at all ¯\\_(ツ)_/¯" }),
    } as Response) as typeof fetch;

    const planner = new Planner();
    const result = await planner.deerFlowDecompose(TASK);

    expect(result.subGoals.length).toBeGreaterThan(0);
  });

  it("uses first responding model when primary is available", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            subGoals: [
              { id: "sg_0", description: "Categorize transaction", complexity: "low", requiresSubAgent: false },
              { id: "sg_1", description: "Calculate savings", complexity: "low", requiresSubAgent: false },
            ],
          }),
        }),
      } as Response;
    }) as typeof fetch;

    const planner = new Planner();
    const result = await planner.deerFlowDecompose(TASK);

    expect(result.subGoals.length).toBe(2);
    expect(callCount).toBe(1); // only hit first model
  });
});
