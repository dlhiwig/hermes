/**
 * RuVector Integration — Direct @ruvector/core NAPI bindings
 *
 * Previously: HTTP calls to localhost:18803 (Qdrant-style) — silently failed.
 * Previously: ruvector VectorIndex wrapper — wrong API (values vs vector, no metadata).
 * Fixed: use @ruvector/core VectorDb directly. Metadata stored in a parallel Map.
 *
 * VectorDb stores (id, vector). Metadata is stored in-process in metaStore Map.
 * Phase 2: persist metaStore to disk for cross-restart retrieval.
 */

// @ruvector/core is CJS-only — use createRequire for ESM interop
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

type RuvDb = {
  insert(entry: { id: string; vector: Float32Array }): Promise<string>;
  search(query: { vector: Float32Array; k: number }): Promise<Array<{ id: string; score: number }>>;
  len(): Promise<number>;
  isEmpty(): Promise<boolean>;
  delete(id: string): Promise<boolean>;
};
const coreModule = require("@ruvector/core") as {
  VectorDb: new (opts: { dimensions: number; distanceMetric: string }) => RuvDb;
  JsDistanceMetric: { Cosine: string; Euclidean: string; DotProduct: string };
};
const { VectorDb, JsDistanceMetric } = coreModule;
import type { Trajectory, RetrievalResult } from "../core/loop.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const VECTOR_DIM = 768;
const OLLAMA_URL = process.env["OLLAMA_URL"] ?? "http://127.0.0.1:11434";
const EMBED_MODEL = "nomic-embed-text";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HybridSearchOptions {
  vectorTopK?: number;
  keywordBoost?: number;
  cypherQuery?: string;
  filters?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface RVFContainer {
  id: string;
  trajectoryId: string;
  createdAt: Date;
  payload: Trajectory;
  tags: string[];
}

export interface RVFSkill {
  id: string;
  name: string;
  pattern: string;
  executor: string;
  successRate: number;
  rvfPath: string;
  createdAt: Date;
}

// ── HermesMemory ──────────────────────────────────────────────────────────────

export class HermesMemory {
  private trajectoryDb: RuvDb;
  private skillDb: RuvDb;
  private graphDb: RuvDb;
  // Metadata store — VectorDb doesn't carry metadata, so we keep it here
  private metaStore = new Map<string, Record<string, unknown>>();
  private trajCount = 0;

  constructor() {
    // Note: @ruvector/core uses a single file-backed store (ruvector.db in cwd).
    // All VectorDb instances share the same backing file — dimension must match.
    // storagePath pins the file to data/ instead of repo root.
    const dbOpts = { dimensions: VECTOR_DIM, distanceMetric: JsDistanceMetric.Cosine, storagePath: "data/ruvector.db" };
    this.trajectoryDb = new VectorDb(dbOpts);
    this.skillDb = new VectorDb(dbOpts);
    this.graphDb = new VectorDb(dbOpts);
    console.log(`[RuVector] Initialized — @ruvector/core VectorDb (dim=${VECTOR_DIM})`);
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  async hybridSearch(query: string, options: HybridSearchOptions = {}): Promise<RetrievalResult[]> {
    const { vectorTopK = 10 } = options;
    console.log(`[RuVector] hybridSearch — query="${query.slice(0, 40)}" topK=${vectorTopK}`);

    try {
      // Use db.len() so cross-restart trajectories are found (trajCount resets each process)
      const dbLen = await this.trajectoryDb.len();
      if (dbLen === 0) return [];
      const vector = await this.textToVector(query);
      const results = await this.trajectoryDb.search({ vector, k: Math.min(vectorTopK, dbLen) });
      return results.map((r) => {
        const meta = this.metaStore.get(r.id) ?? {};
        return {
          id: r.id,
          content: String(meta["input"] ?? ""),
          score: r.score,
          source: "vector" as const,
          metadata: meta,
        };
      });
    } catch (err) {
      console.warn(`[RuVector] hybridSearch failed: ${(err as Error).message}`);
      return [];
    }
  }

  async retrieve(query: string, filters?: Record<string, unknown>): Promise<RetrievalResult[]> {
    return this.hybridSearch(query, filters !== undefined ? { filters } : {});
  }

  // ── Store ───────────────────────────────────────────────────────────────────

  async store(trajectory: Trajectory): Promise<RVFContainer> {
    const container: RVFContainer = {
      id: `rvf_${trajectory.taskId}_${Date.now()}`,
      trajectoryId: trajectory.taskId,
      createdAt: new Date(),
      payload: trajectory,
      tags: trajectory.rewardSignal?.labels ?? [],
    };

    console.log(`[RuVector] store — rvfId=${container.id}`);

    try {
      const vector = await this.textToVector(trajectory.input);
      await this.trajectoryDb.insert({ id: container.id, vector });
      this.metaStore.set(container.id, {
        trajectoryId: trajectory.taskId,
        input: trajectory.input,
        reward: trajectory.rewardSignal?.score ?? 0,
        costUsd: trajectory.totalCostUsd,
        durationMs: trajectory.totalDurationMs,
        tags: container.tags,
        createdAt: container.createdAt.toISOString(),
      });
      this.trajCount++;
      console.log(`[RuVector] stored — total trajectories: ${this.trajCount}`);
    } catch (err) {
      console.warn(`[RuVector] store failed (non-fatal): ${(err as Error).message}`);
    }

    return container;
  }

  // ── Graph Edges ─────────────────────────────────────────────────────────────

  async storeGraphEdge(edge: GraphEdge): Promise<void> {
    console.log(`[RuVector] storeGraphEdge — ${edge.from} -[${edge.relation}]-> ${edge.to}`);
    try {
      const edgeId = `edge_${edge.from}_${edge.relation}_${edge.to}`.slice(0, 128);
      const vector = await this.textToVector(`${edge.from}:${edge.relation}:${edge.to}`);
      await this.graphDb.insert({ id: edgeId, vector });
      this.metaStore.set(edgeId, { from: edge.from, to: edge.to, relation: edge.relation, weight: edge.weight ?? 1.0 });
    } catch (err) {
      console.warn(`[RuVector] storeGraphEdge failed (non-fatal): ${(err as Error).message}`);
    }
  }

  async updateGraph(edges: GraphEdge[]): Promise<void> {
    console.log(`[RuVector] updateGraph — ${edges.length} edge(s)`);
    for (const edge of edges) {
      await this.storeGraphEdge(edge);
    }
  }

  async cypher(query: string, params?: Record<string, unknown>): Promise<unknown[]> {
    void query; void params;
    return [];
  }

  // ── Skills ──────────────────────────────────────────────────────────────────

  async upsertEmbedding(id: string, vector: Float32Array, metadata: Record<string, unknown>): Promise<void> {
    try {
      await this.trajectoryDb.insert({ id, vector });
      this.metaStore.set(id, metadata);
    } catch (err) {
      console.warn(`[RuVector] upsertEmbedding failed: ${(err as Error).message}`);
    }
  }

  async storeSkill(skill: RVFSkill): Promise<void> {
    console.log(`[RuVector] storeSkill — name=${skill.name} successRate=${skill.successRate}`);
    try {
      const vector = await this.textToVector(skill.pattern);
      await this.skillDb.insert({ id: skill.id, vector });
      this.metaStore.set(skill.id, {
        name: skill.name, pattern: skill.pattern, executor: skill.executor,
        successRate: skill.successRate, rvfPath: skill.rvfPath,
        createdAt: skill.createdAt.toISOString(),
      });
    } catch (err) {
      console.warn(`[RuVector] storeSkill failed: ${(err as Error).message}`);
    }
  }

  async findSkills(pattern: string): Promise<RVFSkill[]> {
    try {
      const vector = await this.textToVector(pattern);
      const results = await this.skillDb.search({ vector, k: 10 });
      return results.map((r) => {
        const m = this.metaStore.get(r.id) ?? {};
        return {
          id: String(m["name"] ?? r.id), name: String(m["name"] ?? ""),
          pattern: String(m["pattern"] ?? ""), executor: String(m["executor"] ?? ""),
          successRate: Number(m["successRate"] ?? 0), rvfPath: String(m["rvfPath"] ?? ""),
          createdAt: new Date(String(m["createdAt"] ?? new Date().toISOString())),
        };
      });
    } catch { return []; }
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  async getStats(): Promise<{ trajectories: number; skills: number; edges: number }> {
    return { trajectories: this.trajCount, skills: 0, edges: 0 };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Semantic 768-dim embedding via Ollama nomic-embed-text.
   * Falls back to hash-based Float32Array when Ollama is unreachable.
   */
  async textToVector(text: string): Promise<Float32Array> {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { embedding?: number[] };
        if (data.embedding && data.embedding.length > 0) {
          return new Float32Array(data.embedding);
        }
      }
    } catch {
      // fall through to hash fallback
    }
    return this._hashVector(text);
  }

  /**
   * Hash-based 768-dim fallback — used when Ollama is unreachable.
   */
  private _hashVector(text: string): Float32Array {
    const emb = new Float32Array(VECTOR_DIM);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const idx = (code * 31 + i * 17) % VECTOR_DIM;
      emb[idx] = (emb[idx] ?? 0) + ((code * 0.0073) % 1.0);
    }
    let norm = 0;
    for (let i = 0; i < VECTOR_DIM; i++) norm += (emb[i] ?? 0) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < VECTOR_DIM; i++) emb[i] = (emb[i] ?? 0) / norm;
    return emb;
  }
}
