import { describe, it, expect } from "vitest";
import { HermesLoop } from "../core/loop.js";
import type { HermesTask } from "../core/loop.js";

function makeTask(overrides: Partial<HermesTask> = {}): HermesTask {
  return {
    id: `task-smoke-${Date.now()}`,
    input: "smoke test task",
    source: "internal",
    recursionDepth: 0,
    submittedAt: new Date(),
    ...overrides,
  };
}

describe("HermesLoop smoke tests", () => {
  it("runs all 8 steps and returns a trajectory", async () => {
    const loop = new HermesLoop();
    const trajectory = await loop.run(makeTask());

    expect(trajectory.taskId).toBeTruthy();
    expect(trajectory.rewardSignal).not.toBeNull();
  });

  it("kill switch: throws on recursionDepth > 5", async () => {
    const loop = new HermesLoop();
    await expect(loop.run(makeTask({ recursionDepth: 6 }))).rejects.toThrow(
      "KILL SWITCH"
    );
  });

  it("governance rejection aborts trajectory", () => {
    const loop = new HermesLoop();
    const ctx = {
      task: makeTask(),
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

    // Access private abortTrajectory via cast — verifies abort path sets score=0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aborted = (loop as any).abortTrajectory(ctx, "test rejection") as Awaited<ReturnType<typeof loop.run>>;

    expect(aborted.rewardSignal?.score).toBe(0);
  });
});
