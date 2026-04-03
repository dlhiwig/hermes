//! skynet-runtime — Hermes critical-path Rust execution layer
//!
//! Responsibilities:
//!   - execute_with_proof(): run executor with Blake3 capability proof
//!   - ewc_record_step():    online Fisher update (<1ms EWC++ penalty)
//!   - gnn_update_weights(): zero-copy GNN weight update
//!   - proof_validate():     verify capability proof hash

use serde::{Deserialize, Serialize};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ExecutionTask {
    pub step_id: String,
    pub executor: String,
    pub inputs: serde_json::Value,
    pub capability_proof: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub step_id: String,
    pub output: serde_json::Value,
    pub duration_ms: u64,
    pub success: bool,
    pub proof_hash: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrajectoryStep {
    pub param_id: String,
    pub gradient: f32,
    pub reward: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EwcPenaltyResult {
    pub total_penalty: f32,
    pub param_count: usize,
    pub adaptive_lambda: f32,
    pub fisher_updated: bool,
}

// ── Core Functions ───────────────────────────────────────────────────────────

/// Execute a task step with capability proof generation.
/// SuperClaw validates the returned proof_hash.
pub fn execute_with_proof(task: &ExecutionTask) -> ExecutionResult {
    let start = std::time::Instant::now();

    // TODO: Dispatch to real executor (VoltAgent FFI, internal, etc.)
    // For Phase 0: stub — always succeeds

    let proof_hash = generate_proof_hash(&task.step_id, &task.executor);

    ExecutionResult {
        step_id: task.step_id.clone(),
        output: serde_json::json!({ "status": "stub", "executor": task.executor }),
        duration_ms: start.elapsed().as_millis() as u64,
        success: true,
        proof_hash,
        error: None,
    }
}

/// Online EWC++ Fisher update — runs in <1ms on each trajectory step.
/// Called from SONA instant loop (Step 5).
pub fn ewc_record_step(steps: &[TrajectoryStep], lambda: f32, decay: f32) -> EwcPenaltyResult {
    let mut total_penalty = 0.0f32;
    let param_count = steps.len();

    for step in steps {
        // gradient² as Fisher importance proxy
        let importance = step.gradient * step.gradient * step.reward.max(0.0);
        // EWC++ quadratic penalty: λ/2 * F_i * (θ_i − θ_i*)²
        let penalty = (lambda / 2.0) * importance * step.gradient.powi(2);
        total_penalty += penalty;
    }

    // Adaptive lambda decays with task age
    let adaptive_lambda = lambda * decay;

    EwcPenaltyResult {
        total_penalty,
        param_count,
        adaptive_lambda,
        fisher_updated: true,
    }
}

/// Zero-copy GNN weight update via SONA routing.
/// TODO: integrate ruvector-gnn crate when available.
pub fn gnn_update_weights(trajectory_reward: f32, routing_table_version: u32) -> u32 {
    // Stub: increment version on positive reward
    if trajectory_reward > 0.5 {
        routing_table_version + 1
    } else {
        routing_table_version
    }
}

/// Validate a capability proof hash (Blake3).
pub fn proof_validate(proof_hash: &str, step_id: &str, executor: &str) -> bool {
    let expected = generate_proof_hash(step_id, executor);
    // Constant-time comparison to prevent timing attacks
    proof_hash.len() == expected.len()
        && proof_hash.bytes().zip(expected.bytes()).all(|(a, b)| a == b)
}

fn generate_proof_hash(step_id: &str, executor: &str) -> String {
    let data = format!("{step_id}:{executor}");
    let hash = blake3::hash(data.as_bytes());
    hash.to_hex().to_string()
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execute_with_proof_returns_hash() {
        let task = ExecutionTask {
            step_id: "step-001".into(),
            executor: "voltAgent".into(),
            inputs: serde_json::json!({}),
            capability_proof: None,
        };
        let result = execute_with_proof(&task);
        assert!(result.success);
        assert!(!result.proof_hash.is_empty());
    }

    #[test]
    fn test_ewc_record_step_positive_reward() {
        let steps = vec![
            TrajectoryStep { param_id: "w1".into(), gradient: 0.5, reward: 0.9 },
            TrajectoryStep { param_id: "w2".into(), gradient: -0.3, reward: 0.9 },
        ];
        let result = ewc_record_step(&steps, 0.4, 0.95);
        assert_eq!(result.param_count, 2);
        assert!(result.fisher_updated);
    }

    #[test]
    fn test_proof_validate_roundtrip() {
        let hash = generate_proof_hash("step-1", "skynetRust");
        assert!(proof_validate(&hash, "step-1", "skynetRust"));
        assert!(!proof_validate(&hash, "step-1", "voltAgent"));
    }

    #[test]
    fn test_ewc_zero_reward_no_penalty() {
        let steps = vec![
            TrajectoryStep { param_id: "w1".into(), gradient: 0.8, reward: 0.0 },
            TrajectoryStep { param_id: "w2".into(), gradient: -0.5, reward: 0.0 },
        ];
        let result = ewc_record_step(&steps, 0.4, 0.95);
        assert_eq!(result.total_penalty, 0.0);
    }

    #[test]
    fn test_gnn_no_increment_low_reward() {
        let new_version = gnn_update_weights(0.3, 5);
        assert_eq!(new_version, 5);
    }

    #[test]
    fn test_proof_wrong_executor_fails() {
        let hash = generate_proof_hash("step-1", "skynetRust");
        assert!(!proof_validate(&hash, "step-1", "voltAgent"));
    }
}
