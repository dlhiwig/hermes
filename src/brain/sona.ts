/**
 * SONA Daemon Integration
 *
 * SONA is Hermes's self-optimizing GNN brain. It runs as a background daemon
 * on port 18805 and exposes:
 *  - Trajectory recording
 *  - GNN model updates (Q-Learning / PPO / SARSA)
 *  - Routing table optimization (<1ms target)
 *  - Hyperparameter auto-tuning
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { Trajectory, RewardSignal, HermesTask, HermesPlan, RoutingRecommendation } from "../core/loop.js";
import { EWCPlusPlus } from "./ewc.js";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { SonaEngine } = _require("@ruvector/sona") as { SonaEngine: new (dim: number) => import("@ruvector/sona").SonaEngine };

const SONA_PORT = parseInt(process.env["SONA_PORT"] ?? "18805", 10);
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
  private trajectoryQueue: Trajectory[];
  private ewcSteps: Array<{ paramId: string; fisher: number }>;
  private optimizeTimer: NodeJS.Timeout | null = null;
  private gnnUpdateTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private ewcFlushTimer: NodeJS.Timeout | null = null;
  private ewc: EWCPlusPlus;
  private sonaEngine: import("@ruvector/sona").SonaEngine;

  constructor() {
    this.port = SONA_PORT;
    this.trajectoryBuffer = [];
    this.trajectoryQueue = [];
    this.ewcSteps = [];
    this.ewc = new EWCPlusPlus({ lambda: 0.4, importanceDecay: 0.95 });
    this.sonaEngine = new SonaEngine(256);
    console.log("[SONA] SonaEngine (Rust/WASM) initialized — dim=256");

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

    // Background flush: batch-send queued trajectories every 5s
    this.flushTimer = setInterval(async () => {
      await this.flushTrajectoryQueue().catch((err) =>
        console.error("[SONA] flushTrajectoryQueue error:", err)
      );
    }, SONA_OPTIMIZE_INTERVAL_MS);

    // Background EWC: batch-send fisher steps every 30s
    this.ewcFlushTimer = setInterval(async () => {
      await this.flushEwcSteps().catch((err) =>
        console.error("[SONA] flushEwcSteps error:", err)
      );
    }, SONA_GNN_UPDATE_INTERVAL_MS);
  }

  stop(): void {
    if (this.optimizeTimer) clearInterval(this.optimizeTimer);
    if (this.gnnUpdateTimer) clearInterval(this.gnnUpdateTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.ewcFlushTimer) clearInterval(this.ewcFlushTimer);
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

    // Wire to @ruvector/sona SonaEngine — beginTrajectory/endTrajectory with hash embedding
    try {
      const embedding = this._textToEmbedding(trajectory.input);
      const trajId = this.sonaEngine.beginTrajectory(embedding);
      this.sonaEngine.addTrajectoryStep(trajId, embedding, [], reward.score);
      this.sonaEngine.endTrajectory(trajId, reward.score);
    } catch (err) {
      console.warn("[SONA] sonaEngine trajectory failed (non-fatal):", (err as Error).message);
    }

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

    // Wire to @ruvector/sona: tick + applyMicroLora for routing optimization
    try {
      this.sonaEngine.tick();
      const avgReward = this.trajectoryBuffer.reduce((sum, t) => sum + t.rewardSignal.score, 0)
        / this.trajectoryBuffer.length;
      // applyMicroLora takes a 256-dim vector — use embedding of "routing optimization"
      const routingEmb = this._textToEmbedding(`routing optimization reward=${avgReward.toFixed(3)}`);
      this.sonaEngine.applyMicroLora(routingEmb);
      const stats = this.sonaEngine.getStats();
      console.log(`[SONA] optimizeRouter — sonaStats=${JSON.stringify(stats)}`);
    } catch (err) {
      console.warn("[SONA] sonaEngine optimize failed (non-fatal):", (err as Error).message);
    }

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

  // ── Embedding Helper ──────────────────────────────────────────────────

  /**
   * Hash-based 256-dim embedding — matches ruvector.ts and ledger.ts.
   * Not semantically meaningful but consistent across the pipeline.
   */
  private _textToEmbedding(text: string): number[] {
    const dim = 256;
    const emb = new Array(dim).fill(0) as number[];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const idx = (code * 31 + i * 17) % dim;
      emb[idx] = (emb[idx] ?? 0) + ((code * 0.0073) % 1.0);
    }
    let norm = 0;
    for (const v of emb) norm += (v ?? 0) * (v ?? 0);
    norm = Math.sqrt(norm) || 1;
    return emb.map((v) => (v ?? 0) / norm);
  }

  // ── Queue & Flush ──────────────────────────────────────────────────────

  /**
   * Enqueue a trajectory for background flushing to the SONA HTTP daemon.
   */
  enqueue(trajectory: Trajectory): void {
    this.trajectoryQueue.push(trajectory);
    console.log(`[SONA] enqueue — queueSize=${this.trajectoryQueue.length}`);
  }

  /**
   * Add an EWC fisher step for background flushing.
   */
  addEwcStep(paramId: string, fisher: number): void {
    this.ewcSteps.push({ paramId, fisher });
  }

  /**
   * Batch-send all queued trajectories to the SONA HTTP daemon.
   */
  private async flushTrajectoryQueue(): Promise<void> {
    if (this.trajectoryQueue.length === 0) return;

    const batch = this.trajectoryQueue.splice(0, this.trajectoryQueue.length);
    console.log(`[SONA] flushTrajectoryQueue — sending ${batch.length} trajectories`);

    try {
      const res = await fetch(`http://127.0.0.1:18805/sona/trajectory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trajectories: batch }),
      });
      if (!res.ok) {
        console.warn(`[SONA] flushTrajectoryQueue — HTTP ${res.status}: ${await res.text()}`);
        // Re-queue on failure
        this.trajectoryQueue.unshift(...batch);
      }
    } catch (err) {
      console.warn(`[SONA] flushTrajectoryQueue — daemon unreachable:`, (err as Error).message);
      // Re-queue on connection failure
      this.trajectoryQueue.unshift(...batch);
    }
  }

  /**
   * Batch-send accumulated EWC fisher steps to the SONA daemon.
   */
  private async flushEwcSteps(): Promise<void> {
    if (this.ewcSteps.length === 0) return;

    const batch = this.ewcSteps.splice(0, this.ewcSteps.length);
    console.log(`[SONA] flushEwcSteps — sending ${batch.length} fisher steps`);

    try {
      const res = await fetch(`http://127.0.0.1:18805/sona/ewc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps: batch }),
      });
      if (!res.ok) {
        console.warn(`[SONA] flushEwcSteps — HTTP ${res.status}: ${await res.text()}`);
        this.ewcSteps.unshift(...batch);
      }
    } catch (err) {
      console.warn(`[SONA] flushEwcSteps — daemon unreachable:`, (err as Error).message);
      this.ewcSteps.unshift(...batch);
    }
  }

  /**
   * Query SONA daemon stats endpoint.
   */
  async getStats(): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(`http://127.0.0.1:18805/sona/stats`);
      if (!res.ok) {
        return { error: `HTTP ${res.status}`, local: this.getLocalStats() };
      }
      return await res.json() as Record<string, unknown>;
    } catch {
      return { error: "daemon unreachable", local: this.getLocalStats() };
    }
  }

  private getLocalStats(): Record<string, unknown> {
    return {
      trajectoryBufferSize: this.trajectoryBuffer.length,
      trajectoryQueueSize: this.trajectoryQueue.length,
      ewcStepsPending: this.ewcSteps.length,
      routingTableVersion: this.routingTable.version,
      routingTableEntries: this.routingTable.entries.length,
    };
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
