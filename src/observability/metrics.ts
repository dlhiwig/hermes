/**
 * Hermes Observability — Simple in-process metrics collector.
 *
 * Counters: tasksTotal, tasksSucceeded, tasksFailed
 * Gauge:    averageRewardSignal, sonatrajectoriesBuffered
 * Histogram: taskDurationMs (buckets: 100, 500, 1000, 5000, 30000)
 */

import type { Trajectory } from "../core/loop.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface HistogramData {
  buckets: Record<number, number>; // upper-bound → count
  sum: number;
  count: number;
}

export interface MetricsSummary {
  counters: {
    tasksTotal: number;
    tasksSucceeded: number;
    tasksFailed: number;
  };
  gauges: {
    averageRewardSignal: number;
    sonaTrajectoriestBuffered: number;
  };
  histogram: {
    taskDurationMs: HistogramData;
  };
  collectedAt: string;
}

// ── State ──────────────────────────────────────────────────────────────────

const HISTOGRAM_BUCKETS = [100, 500, 1000, 5000, 30000] as const;

let tasksTotal = 0;
let tasksSucceeded = 0;
let tasksFailed = 0;
let rewardSum = 0;
let rewardCount = 0;
let sonaTrajectoriesBuffered = 0;

const durationBuckets: Record<number, number> = {};
let durationSum = 0;
let durationCount = 0;

for (const b of HISTOGRAM_BUCKETS) {
  durationBuckets[b] = 0;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function recordTask(trajectory: Trajectory): void {
  tasksTotal++;

  const allSucceeded = trajectory.executionResults.every((r) => r.success);
  if (allSucceeded && trajectory.executionResults.length > 0) {
    tasksSucceeded++;
  } else {
    tasksFailed++;
  }

  if (trajectory.rewardSignal) {
    rewardSum += trajectory.rewardSignal.score;
    rewardCount++;
  }

  // Histogram
  const dur = trajectory.totalDurationMs;
  durationSum += dur;
  durationCount++;
  for (const b of HISTOGRAM_BUCKETS) {
    if (dur <= b) {
      durationBuckets[b] = (durationBuckets[b] ?? 0) + 1;
    }
  }
}

export function setSonaTrajectoriesBuffered(count: number): void {
  sonaTrajectoriesBuffered = count;
}

export function getMetricsSummary(): MetricsSummary {
  return {
    counters: {
      tasksTotal,
      tasksSucceeded,
      tasksFailed,
    },
    gauges: {
      averageRewardSignal: rewardCount > 0 ? rewardSum / rewardCount : 0,
      sonaTrajectoriestBuffered: sonaTrajectoriesBuffered,
    },
    histogram: {
      taskDurationMs: {
        buckets: { ...durationBuckets },
        sum: durationSum,
        count: durationCount,
      },
    },
    collectedAt: new Date().toISOString(),
  };
}

export function resetMetrics(): void {
  tasksTotal = 0;
  tasksSucceeded = 0;
  tasksFailed = 0;
  rewardSum = 0;
  rewardCount = 0;
  sonaTrajectoriesBuffered = 0;
  durationSum = 0;
  durationCount = 0;
  for (const b of HISTOGRAM_BUCKETS) {
    durationBuckets[b] = 0;
  }
}
