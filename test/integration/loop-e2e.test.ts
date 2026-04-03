/**
 * End-to-end integration test for HermesLoop.
 *
 * Mocks external dependencies (ruflo, RuVector, Ollama, SuperClaw)
 * and verifies the 8-step loop completes in order with governance
 * and SONA trajectory recording.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";

// Mock external modules before importing HermesLoop
vi.mock("ruflo", () => ({}));
vi.mock("ruvector", () => ({}));
vi.mock("@ruvector/ruvllm", () => ({}));

// Mock @ruvector/sona with a working SonaEngine stub
vi.mock("@ruvector/sona", () => {
  return {
    SonaEngine: class SonaEngineStub {
      private trajectories = new Map<number, { reward: number }>();
      private nextId = 1;
      stats = { trajectoriesCompleted: 0, lastReward: 0 };

      constructor(_dim: number) {}

      beginTrajectory(_embedding: number[]): number {
        const id = this.nextId++;
        this.trajectories.set(id, { reward: 0 });
        return id;
      }

      addTrajectoryStep(_trajId: number, _emb: number[], _actions: number[], _reward: number): void {}

      endTrajectory(trajId: number, reward: number): void {
        const t = this.trajectories.get(trajId);
        if (t) {
          t.reward = reward;
          this.stats.trajectoriesCompleted++;
          this.stats.lastReward = reward;
        }
      }
    },
  };
});

// Mock node:child_process so ruflo CLI calls don't fail
vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, _args: string[], cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: "mock-ok", stderr: "" });
  },
}));

// Mock fetch globally for Ollama calls
const fetchMock = vi.fn().mockImplementation(async (url: string) => {
  if (typeof url === "string" && url.includes("ollama")) {
    return {
      ok: false,
      status: 503,
      text: async () => "mock: ollama unavailable",
    };
  }
  // SuperClaw endpoint mock
  if (typeof url === "string" && url.includes("18800")) {
    return {
      ok: false,
      status: 503,
      text: async () => "mock: superclaw unavailable",
    };
  }
  return { ok: false, status: 404, text: async () => "not found" };
});
vi.stubGlobal("fetch", fetchMock);

// Now import the loop and VoltAgent (after mocks are in place)
const { HermesLoop } = await import("../../src/core/loop.js");
import type { HermesTask, Trajectory } from "../../src/core/loop.js";
const { VoltAgentExecutor, VOLT_AGENT_ROLES } = await import("../../src/skills/voltAgent.js");

describe("HermesLoop end-to-end", () => {
  let loop: InstanceType<typeof HermesLoop>;
  const consoleLogs: string[] = [];

  beforeEach(() => {
    loop = new HermesLoop();
    consoleLogs.length = 0;

    // Capture console.log to verify step ordering
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      consoleLogs.push(String(args[0]));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("runs all 8 steps in order for a valid task", async () => {
    const task: HermesTask = {
      id: randomUUID(),
      input: "Analyze quarterly revenue trends and produce a summary report for Q1 2026",
      source: "api",
      recursionDepth: 0,
      submittedAt: new Date(),
    };

    const trajectory: Trajectory = await loop.run(task);

    // Verify trajectory was produced
    expect(trajectory).toBeDefined();
    expect(trajectory.taskId).toBe(task.id);
    expect(trajectory.input).toBe(task.input);
    expect(trajectory.completedAt).toBeInstanceOf(Date);

    // Verify all 8 steps ran in order
    const stepLogs = consoleLogs.filter((l) => /^\[Step /.test(l));
    expect(stepLogs.length).toBeGreaterThanOrEqual(8);

    const stepOrder = stepLogs.map((l) => {
      const match = l.match(/^\[Step (\d+\.?\d*)\]/);
      return match ? parseFloat(match[1]!) : 0;
    });

    // Steps should be monotonically non-decreasing
    for (let i = 1; i < stepOrder.length; i++) {
      expect(stepOrder[i]).toBeGreaterThanOrEqual(stepOrder[i - 1]!);
    }
  });

  it("governance pre-check runs before execution", async () => {
    const task: HermesTask = {
      id: randomUUID(),
      input: "Test governance pre-check ordering in the Hermes loop pipeline",
      source: "api",
      recursionDepth: 0,
      submittedAt: new Date(),
    };

    await loop.run(task);

    const stepLogs = consoleLogs.filter((l) => /^\[Step /.test(l));
    const preGovIdx = stepLogs.findIndex((l) => l.includes("PRE-EXECUTION GOVERNANCE"));
    const execIdx = stepLogs.findIndex((l) => l.includes("[Step 3]"));

    expect(preGovIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(-1);
    expect(preGovIdx).toBeLessThan(execIdx);
  });

  it("records SONA trajectory with reward signal", async () => {
    const task: HermesTask = {
      id: randomUUID(),
      input: "Verify that SONA trajectory recording captures the reward signal correctly",
      source: "api",
      recursionDepth: 0,
      submittedAt: new Date(),
    };

    const trajectory = await loop.run(task);

    // Reward signal must be set
    expect(trajectory.rewardSignal).toBeDefined();
    expect(trajectory.rewardSignal!.score).toBeGreaterThanOrEqual(0);
    expect(trajectory.rewardSignal!.score).toBeLessThanOrEqual(1);
    expect(trajectory.rewardSignal!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(trajectory.rewardSignal!.taskPattern).toBeTruthy();
    expect(trajectory.rewardSignal!.labels).toContain("api");

    // SONA optimization step should have run
    const sonaLog = consoleLogs.find((l) => l.includes("[Step 5] SONA Optimization"));
    expect(sonaLog).toBeDefined();
  });

  it("produces execution results for plan steps", async () => {
    const task: HermesTask = {
      id: randomUUID(),
      input: "Execute a multi-step plan and verify all execution results are collected",
      source: "telegram",
      recursionDepth: 0,
      submittedAt: new Date(),
    };

    const trajectory = await loop.run(task);

    expect(trajectory.executionResults.length).toBeGreaterThan(0);
    for (const result of trajectory.executionResults) {
      expect(result.stepId).toBeTruthy();
      expect(typeof result.success).toBe("boolean");
    }
  });

  it("voltAgent executor uses Ollama for financial tasks", async () => {
    // Override fetch mock to return a valid Ollama response for this test
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("11434")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              content: `Analyzed: ${body.messages?.[1]?.content ?? "task"}. Category: expense, amount: $42.00`,
            },
          }),
          text: async () => "ok",
        };
      }
      if (typeof url === "string" && url.includes("18800")) {
        return { ok: false, status: 503, text: async () => "mock: superclaw unavailable" };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    });

    const task: HermesTask = {
      id: randomUUID(),
      input: "Categorize this transaction: $42.00 at Grocery Store on 2026-03-15",
      source: "api",
      recursionDepth: 0,
      submittedAt: new Date(),
    };

    const trajectory = await loop.run(task);

    // The loop should have completed with the voltAgent executor
    expect(trajectory).toBeDefined();
    expect(trajectory.taskId).toBe(task.id);

    // Verify Ollama was called at the VoltAgent endpoint
    const ollamaCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("11434"),
    );
    expect(ollamaCalls.length).toBeGreaterThan(0);

    // Verify execution results contain VoltAgent output
    const voltResult = trajectory.executionResults.find(
      (r) => typeof r.output === "string" && r.output.includes("Analyzed"),
    );
    expect(voltResult).toBeDefined();
    expect(voltResult!.success).toBe(true);

    // Restore default fetch mock
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("ollama")) {
        return { ok: false, status: 503, text: async () => "mock: ollama unavailable" };
      }
      if (typeof url === "string" && url.includes("18800")) {
        return { ok: false, status: 503, text: async () => "mock: superclaw unavailable" };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    });
  });

  it("enforces kill switch on excessive recursion depth", async () => {
    const task: HermesTask = {
      id: randomUUID(),
      input: "This should fail due to recursion depth kill switch enforcement",
      source: "recursive",
      recursionDepth: 6, // exceeds MAX_RECURSION_DEPTH=5
      submittedAt: new Date(),
    };

    await expect(loop.run(task)).rejects.toThrow("MAX_RECURSION_DEPTH");
  });
});
