#!/usr/bin/env bash
# Hermes Morning SITREP — quick health check & status dump
# Usage: bash scripts/morning-sitrep.sh
# Output: /tmp/hermes-morning-sitrep.txt

set -euo pipefail
OUT="/tmp/hermes-morning-sitrep.txt"
cd "$(dirname "$0")/.."

{
  echo "=== Hermes Morning SITREP — $(date -Iseconds) ==="
  echo ""

  echo "--- 1. Build ---"
  if npm run build 2>&1; then
    echo "[OK] Build succeeded"
  else
    echo "[FAIL] Build failed"
  fi
  echo ""

  echo "--- 2. One-Loop Run (60s timeout, requires Ollama) ---"
  if command -v ollama &>/dev/null || curl -s --max-time 2 http://127.0.0.1:11434/api/tags &>/dev/null; then
    if timeout 60 npx tsx scripts/run-one-loop.ts 2>&1; then
      echo "[OK] Loop completed"
    else
      echo "[WARN] Loop exited non-zero or timed out"
    fi
  else
    echo "[SKIP] Ollama not detected — skipping loop run"
  fi
  echo ""

  echo "--- 3. Tests ---"
  if npx vitest run 2>&1; then
    echo "[OK] All tests passed"
  else
    echo "[FAIL] Some tests failed"
  fi
  echo ""

  echo "--- 4. Recent Commits ---"
  git log --oneline -10 2>&1
  echo ""

  echo "--- 5. SONA Stats ---"
  curl -s --max-time 5 http://127.0.0.1:18805/sona/stats 2>&1 || echo "[SKIP] SONA daemon not running"
  echo ""

  echo "--- 6. RuVector Health ---"
  curl -s --max-time 5 http://127.0.0.1:18803/health 2>&1 || echo "[SKIP] RuVector not running"
  echo ""

  echo "=== SITREP Complete ==="
} | tee "$OUT"

echo ""
echo "Full output saved to $OUT"
