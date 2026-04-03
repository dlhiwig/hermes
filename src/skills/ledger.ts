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

const EMBEDDING_DIM = 256;

/**
 * Generate a simple 256-dim embedding by hashing transaction fields.
 * Uses a basic string-hash-to-float approach — not production-quality,
 * but sufficient for the Phase 1 proof-of-concept.
 */
function hashEmbedding(input: string): number[] {
  const emb = new Array(EMBEDDING_DIM).fill(0) as number[];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const idx = (code * 31 + i * 17) % EMBEDDING_DIM;
    emb[idx] = (emb[idx] ?? 0) + ((code * 0.0073) % 1.0);
  }
  // Normalize to unit vector
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    norm += (emb[i] ?? 0) * (emb[i] ?? 0);
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    emb[i] = (emb[i] ?? 0) / norm;
  }
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
  private transactions: Transaction[];

  constructor() {
    this.sona = new SonaEngine(EMBEDDING_DIM);
    this.transactions = TRANSACTIONS;
  }

  /**
   * Feed each transaction as a SONA trajectory, applying category-based rewards.
   * This is the Phase 1 closed-loop proof-of-concept.
   */
  async runTransactions(): Promise<void> {
    console.log("[LedgerSkill] Starting Phase 1 — 10 transactions → SONA trajectories");

    for (const tx of this.transactions) {
      const reward = CATEGORY_REWARDS[tx.category];
      const inputStr = `${tx.date}|${tx.category}|${tx.amount}|${tx.description}`;
      const embedding = hashEmbedding(inputStr);

      // Begin trajectory with initial embedding
      const trajId = this.sona.beginTrajectory(embedding);

      // Step 1: classify the transaction
      const classifyEmb = hashEmbedding(`classify:${tx.category}:${tx.amount}`);
      this.sona.addTrajectoryStep(trajId, classifyEmb, [tx.category as unknown as number], reward * 0.5);

      // Step 2: record the financial impact
      const impactEmb = hashEmbedding(`impact:${tx.amount}:${tx.description}`);
      this.sona.addTrajectoryStep(trajId, impactEmb, [tx.amount], reward * 0.8);

      // End trajectory with final reward
      this.sona.endTrajectory(trajId, reward);

      console.log(
        `[LedgerSkill] tx=${tx.description.slice(0, 30).padEnd(30)} ` +
        `cat=${tx.category.padEnd(14)} reward=${reward.toFixed(1)} trajId=${trajId}`
      );
    }

    // Print SONA stats
    const stats = this.sona.getStats();
    console.log("\n[LedgerSkill] SONA stats after 10 trajectories:");
    console.log(JSON.stringify(stats, null, 2));
    console.log("\n[LedgerSkill] Phase 1 complete — graph edges written to RuVector via SONA.");
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
