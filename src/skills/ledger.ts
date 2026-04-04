/**
 * LedgerSkill — Phase 1 proof-of-concept that closes the SONA loop.
 *
 * Defines 10 sample financial transactions, feeds each as a SONA trajectory
 * with simple hash-based 256-dim embeddings, and assigns category-based rewards.
 *
 * Usage:
 *   npx tsx src/skills/ledger.ts
 */

import { SonaEngine } from "@ruvector/sona";
import { HermesMemory } from "../brain/ruvector.js";

// Re-use the same hash embedding as HermesMemory for consistency
function hashEmbedding(text: string): number[] {
  const DIM = 256;
  const emb = new Array(DIM).fill(0) as number[];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const idx = (code * 31 + i * 17) % DIM;
    emb[idx] = (emb[idx] ?? 0) + ((code * 0.0073) % 1.0);
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += (emb[i] ?? 0) ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) emb[i] = (emb[i] ?? 0) / norm;
  return emb;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Transaction {
  amount: number;
  category: "income" | "savings" | "essential" | "discretionary" | "unknown";
  description: string;
  date: string; // ISO date
}

// ── Reward Map ───────────────────────────────────────────────────────────────

const CATEGORY_REWARDS: Record<Transaction["category"], number> = {
  income: 1.0,
  savings: 0.9,
  essential: 0.7,
  discretionary: 0.4,
  unknown: 0.5,
};

// ── Embedding Helper ─────────────────────────────────────────────────────────

const EMBEDDING_DIM = 768;
const OLLAMA_URL = process.env["OLLAMA_URL"] ?? "http://127.0.0.1:11434";

/**
 * Generate a 768-dim semantic embedding via Ollama nomic-embed-text.
 * Falls back to hash-based embedding when Ollama is unreachable.
 */
async function getEmbedding(input: string): Promise<number[]> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ model: "nomic-embed-text", prompt: input }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { embedding?: number[] };
      if (data.embedding && data.embedding.length > 0) return data.embedding;
    }
  } catch {
    // fall through
  }
  // Hash fallback
  const emb = new Array(EMBEDDING_DIM).fill(0) as number[];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const idx = (code * 31 + i * 17) % EMBEDDING_DIM;
    emb[idx] = (emb[idx] ?? 0) + ((code * 0.0073) % 1.0);
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += (emb[i] ?? 0) * (emb[i] ?? 0);
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) emb[i] = (emb[i] ?? 0) / norm;
  return emb;
}

// ── Sample Transactions ──────────────────────────────────────────────────────

const TRANSACTIONS: Transaction[] = [
  { amount: 5200,  category: "income",        description: "Monthly salary deposit",         date: "2025-06-01" },
  { amount: 1400,  category: "essential",      description: "Rent payment",                   date: "2025-06-02" },
  { amount: 85,    category: "essential",       description: "Electric bill",                  date: "2025-06-03" },
  { amount: 120,   category: "essential",       description: "Grocery run — weekly staples",   date: "2025-06-05" },
  { amount: 500,   category: "savings",         description: "Transfer to high-yield savings", date: "2025-06-06" },
  { amount: 45,    category: "discretionary",   description: "Coffee shop and pastries",       date: "2025-06-07" },
  { amount: 200,   category: "discretionary",   description: "New headphones",                 date: "2025-06-10" },
  { amount: 750,   category: "income",          description: "Freelance invoice payment",      date: "2025-06-12" },
  { amount: 300,   category: "savings",         description: "Roth IRA contribution",          date: "2025-06-15" },
  { amount: 62,    category: "unknown",         description: "Unrecognized charge — pending",  date: "2025-06-18" },
];

// ── LedgerSkill ──────────────────────────────────────────────────────────────

export class LedgerSkill {
  private sona: SonaEngine;
  private memory: HermesMemory;
  private transactions: Transaction[];

  constructor() {
    // Use withConfig to set qualityThreshold=0.0 (accept all rewards) and small cluster count for fast pattern emergence
    this.sona = SonaEngine.withConfig({ hiddenDim: EMBEDDING_DIM, qualityThreshold: 0.0, patternClusters: 3 });
    this.memory = new HermesMemory();
    this.transactions = TRANSACTIONS;
  }

  /**
   * Feed each transaction as a SONA trajectory, applying category-based rewards.
   * Uses semantic Ollama embeddings (768-dim) and flushes patterns to RuVector.
   */
  async runTransactions(): Promise<void> {
    console.log(`[LedgerSkill] Starting Phase 1 — 10 transactions → SONA trajectories (dim=${EMBEDDING_DIM})`);

    for (const tx of this.transactions) {
      const reward = CATEGORY_REWARDS[tx.category];
      const inputStr = `${tx.date}|${tx.category}|${tx.amount}|${tx.description}`;
      const embedding = await getEmbedding(inputStr);

      // Begin trajectory with initial embedding
      const trajId = this.sona.beginTrajectory(embedding);

      // Step 1: classify the transaction
      const classifyEmb = await getEmbedding(`classify:${tx.category}:${tx.amount}`);
      this.sona.addTrajectoryStep(trajId, classifyEmb, [reward * 0.5], reward * 0.5);

      // Step 2: record the financial impact
      const impactEmb = await getEmbedding(`impact:${tx.amount}:${tx.description}`);
      this.sona.addTrajectoryStep(trajId, impactEmb, [reward * 0.8], reward * 0.8);

      // End trajectory with final reward
      this.sona.endTrajectory(trajId, reward);

      console.log(
        `[LedgerSkill] tx=${tx.description.slice(0, 30).padEnd(30)} ` +
        `cat=${tx.category.padEnd(14)} reward=${reward.toFixed(1)} trajId=${trajId}`
      );
    }

    // Flush patterns from SONA engine → RuVector
    console.log("\n[LedgerSkill] Flushing SONA patterns to RuVector...");
    this.sona.flush();
    const queryEmb = await getEmbedding("financial transaction pattern");
    const patterns = this.sona.findPatterns(queryEmb, 10);
    if (patterns.length > 0) {
      for (const pattern of patterns) {
        const vec = new Float32Array(pattern.centroid);
        await this.memory.upsertEmbedding(`ledger_pattern_${pattern.id}`, vec, {
          patternId: pattern.id,
          clusterSize: pattern.clusterSize,
          avgQuality: pattern.avgQuality,
          totalWeight: pattern.totalWeight,
          patternType: pattern.patternType,
          source: "ledger",
        });
      }
      console.log(`[LedgerSkill] Stored ${patterns.length} patterns to RuVector`);
    } else {
      console.log("[LedgerSkill] No patterns found yet (need more trajectories or force-learn)");
    }

    // Force a learning cycle to surface patterns
    const learnResult = this.sona.forceLearn();
    console.log(`[LedgerSkill] forceLearn: ${learnResult}`);

    // Check again after force-learn
    const patterns2 = this.sona.findPatterns(queryEmb, 10);
    if (patterns2.length > patterns.length) {
      for (const pattern of patterns2.slice(patterns.length)) {
        const vec = new Float32Array(pattern.centroid);
        await this.memory.upsertEmbedding(`ledger_pattern_${pattern.id}`, vec, {
          patternId: pattern.id,
          clusterSize: pattern.clusterSize,
          avgQuality: pattern.avgQuality,
          patternType: pattern.patternType,
          source: "ledger",
        });
      }
      console.log(`[LedgerSkill] Stored ${patterns2.length - patterns.length} additional patterns after forceLearn`);
    }

    // Print SONA stats
    const statsRaw = this.sona.getStats();
    let statsObj: Record<string, unknown> = { raw: statsRaw };
    try { statsObj = JSON.parse(statsRaw) as Record<string, unknown>; } catch { /* keep raw */ }
    console.log("\n[LedgerSkill] SONA stats after 10 trajectories:");
    console.log(JSON.stringify(statsObj, null, 2));
    console.log(`\n[LedgerSkill] patterns_stored=${patterns2.length} — Phase 1 complete.`);
  }
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const skill = new LedgerSkill();
  skill.runTransactions().catch((err) => {
    console.error("[LedgerSkill] Fatal:", err);
    process.exit(1);
  });
}
