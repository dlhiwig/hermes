/**
 * RuVector Integration Client
 *
 * Connects to the RuVector daemon (Qdrant-compatible HTTP API at port 18803)
 * to provide Hermes with:
 *  - Vector similarity search
 *  - Trajectory storage (as points with payload)
 *  - Graph edge management (stored as points with edge metadata)
 *  - Embedding upserts
 *
 * Falls back to in-memory stubs when RuVector is unreachable.
 */

import type { Trajectory, RetrievalResult } from "../core/loop.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const TRAJECTORY_COLLECTION = "hermes-trajectories";
const GRAPH_COLLECTION = "hermes-graph-edges";
const SKILLS_COLLECTION = "hermes-skills";
const VECTOR_DIM = 256;

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
  embeddings?: Float32Array;
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
  private url: string;
  private connected: boolean | null = null; // null = untested
  private collectionsReady = false;

  constructor() {
    this.url = process.env["RUVECTOR_URL"] ?? "http://127.0.0.1:18803";
    console.log(`[RuVector] Initialized — url=${this.url}`);
  }

  // ── Connection Check ────────────────────────────────────────────────────

  async checkConnection(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.url}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) { this.connected = false; return false; }
      const data = (await resp.json()) as { status: string };
      this.connected = data.status === "healthy";
      return this.connected;
    } catch {
      this.connected = false;
      return false;
    }
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.connected === null) {
      await this.checkConnection();
    }
    return this.connected ?? false;
  }

  /**
   * Ensure required collections exist. Idempotent — skips after first success.
   */
  private async ensureCollections(): Promise<void> {
    if (this.collectionsReady) return;
    if (!(await this.ensureConnected())) return;

    for (const name of [TRAJECTORY_COLLECTION, GRAPH_COLLECTION, SKILLS_COLLECTION]) {
      try {
        const check = await fetch(`${this.url}/collections/${name}`, {
          signal: AbortSignal.timeout(2000),
        });
        if (check.ok) continue;

        await fetch(`${this.url}/collections`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(3000),
          body: JSON.stringify({ name, dimension: VECTOR_DIM }),
        });
        console.log(`[RuVector] Created collection: ${name}`);
      } catch {
        // Collection may already exist or service unavailable
      }
    }
    this.collectionsReady = true;
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /**
   * Vector similarity search against trajectories collection.
   * Falls back to empty results when RuVector is unreachable.
   */
  async hybridSearch(
    query: string,
    options: HybridSearchOptions = {}
  ): Promise<RetrievalResult[]> {
    const { vectorTopK = 10 } = options;

    console.log(
      `[RuVector] hybridSearch — query="${query.slice(0, 40)}" topK=${vectorTopK}`
    );

    if (!(await this.ensureConnected())) return [];
    await this.ensureCollections();

    try {
      const vector = this.textToVector(query);
      const resp = await fetch(
        `${this.url}/collections/${TRAJECTORY_COLLECTION}/points/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ vector, k: vectorTopK }),
        }
      );
      if (!resp.ok) return [];

      const data = (await resp.json()) as {
        results?: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
      };

      return (data.results ?? []).map((r) => ({
        id: r.id,
        content: String(r.metadata?.["input"] ?? ""),
        score: r.score,
        source: "vector" as const,
        metadata: r.metadata ?? {},
      }));
    } catch {
      return [];
    }
  }

  /**
   * Short-hand used by loop.ts Step 1.
   */
  async retrieve(
    query: string,
    filters?: Record<string, unknown>
  ): Promise<RetrievalResult[]> {
    return this.hybridSearch(query, filters !== undefined ? { filters } : {});
  }

  // ── Store ───────────────────────────────────────────────────────────────

  /**
   * Serialize a Trajectory into an RVF container and persist it as a point.
   */
  async store(trajectory: Trajectory): Promise<RVFContainer> {
    const container: RVFContainer = {
      id: `rvf_${trajectory.taskId}_${Date.now()}`,
      trajectoryId: trajectory.taskId,
      createdAt: new Date(),
      payload: trajectory,
      tags: trajectory.rewardSignal?.labels ?? [],
    };

    console.log(`[RuVector] store — rvfId=${container.id}`);

    if (await this.ensureConnected()) {
      await this.ensureCollections();
      try {
        const vector = this.textToVector(trajectory.input);
        await fetch(
          `${this.url}/collections/${TRAJECTORY_COLLECTION}/points`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(5000),
            body: JSON.stringify({
              points: [
                {
                  id: container.id,
                  vector,
                  metadata: {
                    trajectoryId: trajectory.taskId,
                    input: trajectory.input,
                    reward: trajectory.rewardSignal?.score ?? 0,
                    costUsd: trajectory.totalCostUsd,
                    durationMs: trajectory.totalDurationMs,
                    tags: container.tags,
                    createdAt: container.createdAt.toISOString(),
                  },
                },
              ],
            }),
          }
        );
      } catch (err) {
        console.warn(`[RuVector] store failed (non-fatal):`, (err as Error).message);
      }
    }

    return container;
  }

  // ── Graph Edges ─────────────────────────────────────────────────────────

  /**
   * Store a graph edge as a point in the graph-edges collection.
   */
  async storeGraphEdge(edge: GraphEdge): Promise<void> {
    console.log(`[RuVector] storeGraphEdge — ${edge.from} -[${edge.relation}]-> ${edge.to}`);

    if (!(await this.ensureConnected())) return;
    await this.ensureCollections();

    try {
      const edgeId = `edge_${edge.from}_${edge.relation}_${edge.to}`;
      const vector = this.textToVector(`${edge.from}:${edge.relation}:${edge.to}`);
      await fetch(`${this.url}/collections/${GRAPH_COLLECTION}/points`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          points: [
            {
              id: edgeId,
              vector,
              metadata: {
                from: edge.from,
                to: edge.to,
                relation: edge.relation,
                weight: edge.weight ?? 1.0,
                ...(edge.metadata ?? {}),
              },
            },
          ],
        }),
      });
    } catch (err) {
      console.warn(`[RuVector] storeGraphEdge failed (non-fatal):`, (err as Error).message);
    }
  }

  /**
   * Update graph edges (e.g. task → completed_by → trajectory).
   */
  async updateGraph(edges: GraphEdge[]): Promise<void> {
    console.log(`[RuVector] updateGraph — ${edges.length} edge(s)`);
    for (const edge of edges) {
      await this.storeGraphEdge(edge);
    }
  }

  /**
   * Cypher query pass-through for advanced graph operations.
   * Falls back to empty results (RuVector uses vector search, not Cypher).
   */
  async cypher(query: string, params?: Record<string, unknown>): Promise<unknown[]> {
    console.log(`[RuVector] cypher — ${query.slice(0, 60)}`);
    void params;
    return [];
  }

  // ── Embeddings & Skills ─────────────────────────────────────────────────

  /**
   * Upsert embeddings for a document (used after skill distillation).
   */
  async upsertEmbedding(
    id: string,
    vector: Float32Array,
    metadata: Record<string, unknown>
  ): Promise<void> {
    console.log(`[RuVector] upsertEmbedding — id=${id} dim=${vector.length}`);

    if (!(await this.ensureConnected())) return;
    await this.ensureCollections();

    try {
      await fetch(`${this.url}/collections/${TRAJECTORY_COLLECTION}/points`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          points: [{ id, vector: Array.from(vector), metadata }],
        }),
      });
    } catch (err) {
      console.warn(`[RuVector] upsertEmbedding failed (non-fatal):`, (err as Error).message);
    }
  }

  /**
   * Persist a distilled skill as an RVF skill record.
   */
  async storeSkill(skill: RVFSkill): Promise<void> {
    console.log(`[RuVector] storeSkill — name=${skill.name} successRate=${skill.successRate}`);

    if (!(await this.ensureConnected())) return;
    await this.ensureCollections();

    try {
      const vector = this.textToVector(skill.pattern);
      await fetch(`${this.url}/collections/${SKILLS_COLLECTION}/points`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          points: [
            {
              id: skill.id,
              vector,
              metadata: {
                name: skill.name,
                pattern: skill.pattern,
                executor: skill.executor,
                successRate: skill.successRate,
                rvfPath: skill.rvfPath,
                createdAt: skill.createdAt.toISOString(),
              },
            },
          ],
        }),
      });
    } catch (err) {
      console.warn(`[RuVector] storeSkill failed (non-fatal):`, (err as Error).message);
    }
  }

  /**
   * Look up all RVF skills for a given task pattern.
   */
  async findSkills(pattern: string): Promise<RVFSkill[]> {
    console.log(`[RuVector] findSkills — pattern="${pattern.slice(0, 40)}"`);

    if (!(await this.ensureConnected())) return [];
    await this.ensureCollections();

    try {
      const vector = this.textToVector(pattern);
      const resp = await fetch(
        `${this.url}/collections/${SKILLS_COLLECTION}/points/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ vector, k: 10 }),
        }
      );
      if (!resp.ok) return [];

      const data = (await resp.json()) as {
        results?: Array<{ id: string; score: number; payload?: Record<string, unknown> }>;
      };

      return (data.results ?? []).map((r) => ({
        id: String(r.metadata?.["name"] ?? r.id),
        name: String(r.metadata?.["name"] ?? ""),
        pattern: String(r.metadata?.["pattern"] ?? ""),
        executor: String(r.metadata?.["executor"] ?? ""),
        successRate: Number(r.metadata?.["successRate"] ?? 0),
        rvfPath: String(r.metadata?.["rvfPath"] ?? ""),
        createdAt: new Date(String(r.metadata?.["createdAt"] ?? new Date().toISOString())),
      }));
    } catch {
      return [];
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Simple hash-based text → 256-dim vector for storage/search.
   * Matches the embedding approach used in loop.ts taskToEmbedding().
   */
  private textToVector(text: string): number[] {
    const emb = new Array(VECTOR_DIM).fill(0) as number[];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const idx = (code * 31 + i * 17) % VECTOR_DIM;
      emb[idx] = (emb[idx] ?? 0) + ((code * 0.0073) % 1.0);
    }
    let norm = 0;
    for (let i = 0; i < VECTOR_DIM; i++) {
      norm += (emb[i] ?? 0) * (emb[i] ?? 0);
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < VECTOR_DIM; i++) {
      emb[i] = (emb[i] ?? 0) / norm;
    }
    return emb;
  }
}
