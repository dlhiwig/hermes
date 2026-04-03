/**
 * SONA Daemon Integration
 *
 * SONA is Hermes's self-optimizing GNN brain. It runs as a background daemon
 * on port 18804 and exposes:
 *  - Trajectory recording
 *  - GNN model updates (Q-Learning / PPO / SARSA)
 *  - Routing table optimization (<1ms target)
 *  - Hyperparameter auto-tuning
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { Trajectory, RewardSignal, HermesTask, HermesPlan, RoutingRecommendation } from "../core/loop.js";
import { EWCPlusPlus } from "./ewc.js";

const SONA_PORT = parseInt(process.env["SONA_PORT"] ?? "18804", 10);
const SONA_OPTIMIZE_INTERVAL_MS = 5_000; // every 5 seconds
const SONA_GNN_UPDATE_INTERVAL_MS = 30_000; // every 30 seconds

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrajectoryRecord {
  trajectoryId: string;
  rewardSignal: RewardSignal;
  timestamp: Date;
}

export interface GNNUpdateResult {
  loss: number;
  epochsRun: number;
  routingTableVersion: number;
  durationMs: number;
}

export interface RoutingTable {
  version: number;
  entries: RoutingEntry[];
  updatedAt: Date;
}

export interface RoutingEntry {
  pattern: string;
  preferredExecutor: string;
  confidenceScore: number;
  sampleCount: number;
}

export interface HyperparameterSet {
  learningRate: number;
  discountFactor: number;
  explorationEpsilon: number;
  batchSize: number;
  updateFrequency: number;
}

// ── SonaDaemon ────────────────────────────────────────────────────────────────

export class SonaDaemon {
  private port: number;
  private routingTable: RoutingTable;
  private hyperparams: HyperparameterSet;
  private trajectoryBuffer: TrajectoryRecord[];
  private optimizeTimer: NodeJS.Timeout | null = null;
  private gnnUpdateTimer: NodeJS.Timeout | null = null;
  private ewc: EWCPlusPlus;

  constructor() {
    this.port = SONA_PORT;
    this.trajectoryBuffer = [];
    this.ewc = new EWCPlusPlus({ lambda: 0.4, importanceDecay: 0.95 });

    this.routingTable = {
      version: 0,
      entries: [],
      updatedAt: new Date(),
    };

    // Default hyperparameters — SONA will auto-tune these
    this.hyperparams = {
      learningRate: 0.001,
      discountFactor: 0.99,
      explorationEpsilon: 0.1,
      batchSize: 32,
      updateFrequency: 100,
    };

    console.log(`[SONA] Daemon initialized — port=${this.port}`);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the background optimization loops.
   * Called by the main daemon entry point (src/main.ts or hermes-core).
   */
  start(): void {
    console.log(`[SONA] Starting background optimization loops`);

    this.optimizeTimer = setInterval(async () => {
      await this.optimizeRouter().catch((err) =>
        console.error("[SONA] optimizeRouter error:", err)
      );
    }, SONA_OPTIMIZE_INTERVAL_MS);

    this.gnnUpdateTimer = setInterval(async () => {
      await this.updateGNN().catch((err) =>
        console.error("[SONA] updateGNN error:", err)
      );
    }, SONA_GNN_UPDATE_INTERVAL_MS);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (method === "GET" && url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          port: this.port,
          routingTableVersion: this.routingTable.version,
          bufferSize: this.trajectoryBuffer.length,
        }));
        return;
      }

      if (method === "POST" && url === "/trajectory") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            const data = JSON.parse(body) as { trajectory: Trajectory; reward: RewardSignal };
            this.recordTrajectory(data.trajectory, data.reward).catch((err) =>
              console.error("[SONA] recordTrajectory error:", err)
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid json" }));
          }
        });
        return;
      }

      if (method === "GET" && url === "/routing-table") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.routingTable));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(this.port, () => {
      console.log(`[SONA] HTTP server listening on :${this.port}`);
    });
  }

  stop(): void {
    if (this.optimizeTimer) clearInterval(this.optimizeTimer);
    if (this.gnnUpdateTimer) clearInterval(this.gnnUpdateTimer);
    console.log("[SONA] Stopped");
  }

  // ── Core API ─────────────────────────────────────────────────────────────

  /**
   * Record a completed trajectory + reward signal for GNN training.
   * Called from loop.ts Step 5.
   */
  async recordTrajectory(trajectory: Trajectory, reward: RewardSignal): Promise<void> {
    const record: TrajectoryRecord = {
      trajectoryId: trajectory.taskId,
      rewardSignal: reward,
      timestamp: new Date(),
    };

    this.trajectoryBuffer.push(record);

    // Build a simple gradient map from the reward signal and apply Micro-LoRA
    const gradients = new Map<string, number>([
      ["routing_weight", reward.score],
      ["task_success", reward.score],
    ]);
    this.ewc.applyMicroLora(gradients, reward.score);

    // TODO: POST to SONA HTTP API or call @ruvector/sona directly
    // await fetch(`http://localhost:${this.port}/trajectory`, {
    //   method: "POST",
    //   body: JSON.stringify(record),
    // });

    console.log(
      `[SONA] recordTrajectory — id=${trajectory.taskId} score=${reward.score.toFixed(3)} buffer=${this.trajectoryBuffer.length}`
    );
  }

  /**
   * Trigger routing table optimization from accumulated trajectories.
   * Target: <1ms decision latency after optimization.
   */
  async optimizeRouter(): Promise<void> {
    if (this.trajectoryBuffer.length === 0) return;

    console.log(`[SONA] optimizeRouter — buffer=${this.trajectoryBuffer.length}`);

    // TODO: Call @ruvector/sona optimize() with buffer
    // const result = await sona.optimize({
    //   trajectories: this.trajectoryBuffer,
    //   hyperparams: this.hyperparams,
    //   algorithm: "PPO",
    // });
    // this.routingTable = result.routingTable;
    // this.hyperparams = result.updatedHyperparams;

    // Flush buffer after optimization
    this.trajectoryBuffer = [];
    this.routingTable.version++;
    this.routingTable.updatedAt = new Date();
  }

  /**
   * Full GNN weight update pass (Q-Learning / PPO / SARSA).
   * More expensive than optimizeRouter — runs less frequently.
   */
  async updateGNN(): Promise<GNNUpdateResult> {
    console.log(`[SONA] updateGNN — routingTable.version=${this.routingTable.version}`);

    const start = Date.now();

    // TODO: Call @ruvector/sona updateGNN()
    // const result = await sona.updateGNN({
    //   algorithm: "SARSA",
    //   epochs: 10,
    //   learningRate: this.hyperparams.learningRate,
    // });

    return {
      loss: 0,
      epochsRun: 0,
      routingTableVersion: this.routingTable.version,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Get routing recommendation for an incoming task + plan.
   * Used in loop.ts after Step 2 to inform Step 3 executor selection.
   */
  async getRoutingRecommendation(
    task: HermesTask,
    plan: HermesPlan | null
  ): Promise<RoutingRecommendation> {
    // TODO: Query routing table or call @ruvector/sona recommend()
    const bestEntry = this.routingTable.entries.find((e) =>
      task.input.toLowerCase().includes(e.pattern.toLowerCase())
    );

    if (bestEntry) {
      return {
        suggestedExecutor: bestEntry.preferredExecutor,
        confidenceScore: bestEntry.confidenceScore,
        reasoning: `Matched routing table pattern "${bestEntry.pattern}" (v${this.routingTable.version})`,
      };
    }

    void plan;

    return {
      suggestedExecutor: "voltAgent",
      confidenceScore: 0.5,
      reasoning: "No routing table match — defaulting to VoltAgent",
    };
  }

  /**
   * Auto-tune hyperparameters based on recent reward trends.
   */
  async autoTuneHyperparams(): Promise<HyperparameterSet> {
    // TODO: Bayesian optimization or simple hill-climbing over this.hyperparams
    console.log("[SONA] autoTuneHyperparams — stub");
    return this.hyperparams;
  }

  /**
   * Feed a governance violation into EWC++ to lock weights harder on flagged params.
   * Called from SuperClaw Step 7 when a trajectory is flagged.
   */
  applyGovernancePenalty(paramId: string, negativeReward: number): void {
    this.ewc.applyGovernancePenalty(paramId, negativeReward);
  }

  getRoutingTable(): RoutingTable {
    return this.routingTable;
  }

  getHyperparams(): HyperparameterSet {
    return this.hyperparams;
  }
}

// ── CLI Entry Point (sona:daemon script) ──────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = new SonaDaemon();
  daemon.start();

  process.on("SIGTERM", () => { daemon.stop(); process.exit(0); });
  process.on("SIGINT",  () => { daemon.stop(); process.exit(0); });
}
