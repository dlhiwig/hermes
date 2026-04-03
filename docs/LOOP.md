# The Hermes Recursive Self-Learning Loop

8 steps. Every cycle <50ms. Compounds after 50-200 trajectories.

## Step 1: Input & Retrieval (RuVector)
Hybrid search: vector similarity + keyword boost + Cypher graph traversal.
Retrieves: episodic memories, past trajectories, graph edges, ReasoningBank patterns.

## Step 2: Planning (gstack + ruflo + deer-flow)
gstack enforces Plan -> Build -> QA -> Ship gates.
ruflo spawns hive-mind swarm (queen-led Byzantine consensus).
deer-flow handles long-horizon decomposition + Docker sandboxed sub-agents.

## Step 2.5: PRE-EXECUTION GOVERNANCE (MANDATORY)
SuperClaw validates: capability proofs, PII detection, cost projection, prompt injection scan.
Decision: approve / reject / escalate.
NO EXECUTOR RUNS WITHOUT PASSING THIS GATE.

## Step 3: Execution (VoltAgent + skynet-rust + SuperClaw)
Each step: executor runs -> Blake3 proof generated -> SuperClaw validates proof.
Critical paths: skynet-rust (zero-copy, sub-ms latency).
TS agents: VoltAgent workers with built-in observability.

## Step 4: Observation & Logging
Full trajectory: input -> plan -> sub-agent outputs -> final result + reward signal.
Reward dimensions: accuracy, latency, token efficiency, cost efficiency, user feedback.
Stored as RVF container + GNN edges.

## Step 5: SONA Instant Optimization (<1ms)
Micro-LoRA (rank 1-2) applied to current trajectory.
EWC++ penalty: L = lambda(t)/2 * F_i(t) * (theta_i - theta_i*)^2
GNN router weights updated (Q-Learning / PPO / SARSA).
Hyperparameters auto-tuned.

## Step 6: Skill Evolution / Distillation (~10-100ms background)
Pattern clustering on successful trajectories -> ReasoningBank.
If success_rate > 85% over N>=10 runs:
  -> Distill into new SKILL.md + RVF cognitive container
  -> Register in routing table immediately
If success_rate > 92%:
  -> Spawn permanent specialized sub-agent (e.g., "LedgerAnomalyForecaster")

## Step 7: POST-EXECUTION GOVERNANCE FEEDBACK (MANDATORY)
SuperClaw reviews: policy compliance, PII, security, cost.
Failures -> negative reward -> EWC++ amplifies Fisher importance (locks safety weights).
Policies themselves evolve: high-risk patterns -> tighter guardrails.

## Step 8: Consolidation (nightly deep loop)
Full EWC++ + Base LoRA (rank 8) update across all layers.
Global GNN propagation (embeddings + relationships).
Routing table Mixture-of-Experts refresh.
Meta-log: delta accuracy, delta latency, new skills spawned.
Final memory write: trajectory + distilled skill + governance outcome as immutable RVF.
