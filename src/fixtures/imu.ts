// IMU fixture traces for detector unit tests.
// Segment boundaries must be continuous (seg[n] ends where seg[n+1] starts)
// to avoid artificial inter-segment vector-jerk spikes. The only intentional
// discontinuities are at crack and snap-back segment starts.

import { IMUSample } from '../detector';

function s(
  ts: number,
  ax: number, ay: number, az: number,
  gx: number, gy: number, gz: number
): IMUSample {
  return { ts, ax, ay, az, gx, gy, gz };
}

// ─── Helper: build a trace from segments ─────────────────────────────────────

interface Segment {
  durationMs: number;
  ax: number; ay: number; az: number;
  gx: number; gy: number; gz: number;
  ax2?: number; ay2?: number; az2?: number;
  gx2?: number; gy2?: number; gz2?: number;
}

function buildTrace(startTs: number, segments: Segment[]): IMUSample[] {
  const samples: IMUSample[] = [];
  let ts = startTs;
  for (const seg of segments) {
    const count = Math.max(1, Math.round(seg.durationMs / 10));
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      samples.push(s(
        ts,
        lerp(seg.ax, seg.ax2 ?? seg.ax, t),
        lerp(seg.ay, seg.ay2 ?? seg.ay, t),
        lerp(seg.az, seg.az2 ?? seg.az, t),
        lerp(seg.gx, seg.gx2 ?? seg.gx, t),
        lerp(seg.gy, seg.gy2 ?? seg.gy, t),
        lerp(seg.gz, seg.gz2 ?? seg.gz, t),
      ));
      ts += 10;
    }
  }
  return samples;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ─── CRACK FIXTURE 1: clean textbook overhead crack ──────────────────────────
// Continuous swing: starts at wind-up end values, ramps gyro from 0.1→12 and
// az from 9.5→5 over 150 ms, so there are no mid-swing segment-boundary steps.

export const CRACK_1: IMUSample[] = buildTrace(1000, [
  // Phase A: wind-up — phone pointing up, still
  { durationMs: 200, ax: 0.2, ay: 0.1, az: 9.5, gx: 0.1, gy: 0.1, gz: 0.1 },
  // Phase B: one smooth swing — starts exactly where wind-up ends
  { durationMs: 150,
    ax: 0.2, ay: 0.1, az: 9.5, gx: 0.1, gy: 0.1, gz: 0.1,
    ax2: 2,  ay2: 1,  az2: 5,  gx2: 0,  gy2: 12, gz2: 2 },
  // Post-swing hold (continues from swing end; gives SWING_MIN_MS time before crack)
  { durationMs: 60,  ax: 2, ay: 1, az: 5, gx: 0, gy: 12, gz: 2 },
  // Phase C crack: intentional step → large vector jerk
  { durationMs: 20,  ax: 26, ay: 16, az: 3, gx: 1, gy: 8, gz: 1 },
  // Snap-back: direction reversal → dot product with crack accel < 0
  { durationMs: 20,  ax: -20, ay: -12, az: 4, gx: 1, gy: 5, gz: 0.5 },
  // Follow-through: smooth decel from snap-back end value
  { durationMs: 100, ax: -20, ay: -12, az: 4,  gx: 0.5, gy: 2, gz: 0.3,
                     ax2: 0.5, ay2: 0.3, az2: 4, gx2: 0.1, gy2: 0.5, gz2: 0.1 },
]);

// ─── CRACK FIXTURE 2: aggressive fast crack ───────────────────────────────────

export const CRACK_2: IMUSample[] = buildTrace(2000, [
  { durationMs: 120, ax: 0.1, ay: 0.1, az: 9.2, gx: 0.05, gy: 0.05, gz: 0.05 },
  { durationMs: 110,
    ax: 0.1, ay: 0.1, az: 9.2, gx: 0.05, gy: 0.05, gz: 0.05,
    ax2: 3,  ay2: 2,  az2: 4,  gx2: 0,   gy2: 14,  gz2: 3 },
  { durationMs: 60,  ax: 3, ay: 2, az: 4, gx: 0, gy: 14, gz: 3 },
  { durationMs: 20,  ax: 35, ay: 20, az: 2, gx: 2, gy: 6, gz: 1 },
  { durationMs: 20,  ax: -28, ay: -18, az: 4, gx: 1, gy: 4, gz: 0.5 },
  { durationMs: 80,  ax: -28, ay: -18, az: 4, gx: 0.3, gy: 1, gz: 0.3,
                     ax2: 1, ay2: 0.5, az2: 4, gx2: 0.1, gy2: 0.3, gz2: 0.1 },
]);

// ─── CRACK FIXTURE 3: lower-confidence but valid crack ────────────────────────
// Gyro just barely above threshold (8.5 vs default 8 rad/s).
// Shorter wind-up (150 ms) so the gyro ramp stays within WINDUP_MAX_MS (300 ms).

export const CRACK_3: IMUSample[] = buildTrace(3000, [
  { durationMs: 150, ax: 0.3, ay: 0.15, az: 8.5, gx: 0.2, gy: 0.2, gz: 0.1 },
  // Smooth swing — gyro ramps from 0.2→8.5, az 8.5→5. At the last sample
  // (elapsed=250 ms < WINDUP_MAX_MS) gy hits 8.5 → SWING triggered.
  { durationMs: 100,
    ax: 0.3, ay: 0.15, az: 8.5, gx: 0.2, gy: 0.2, gz: 0.1,
    ax2: 2,  ay2: 1,   az2: 5,  gx2: 0,  gy2: 8.5, gz2: 1 },
  // Post-swing hold: gives SWING_MIN_MS time before crack
  { durationMs: 60,  ax: 2, ay: 1, az: 5, gx: 0, gy: 8.5, gz: 1 },
  // Crack (just above threshold)
  { durationMs: 30,  ax: 18, ay: 11, az: 4, gx: 1, gy: 5, gz: 1 },
  // Snap-back
  { durationMs: 30,  ax: -15, ay: -9, az: 5, gx: 0.8, gy: 4, gz: 0.5 },
  // Follow-through
  { durationMs: 100, ax: -15, ay: -9, az: 5, gx: 0.3, gy: 1.5, gz: 0.3,
                     ax2: 0.5, ay2: 0.3, az2: 5, gx2: 0.1, gy2: 0.5, gz2: 0.1 },
]);

// ─── COMPACT CRACK (300 ms rep): for rate-limit testing ──────────────────────
// Designed so that crack detections occur at ~300 ms intervals when reps are
// fed one after another with SPACING_MS=300 offsets in the test.
//
// Timing breakdown (windupStartTs established during prior rep's recovery):
//   Wind-up:     100 ms (az=9.5, reinforces WINDUP)
//   Smooth swing: 50 ms (gy 0.05→9; transition fires at elapsed≈140–180 ms)
//   Post-swing:   50 ms (elapsed in SWING reaches 50 ms → crack check enabled)
//   Crack:        20 ms (large vector jerk → CRACK_WATCH at elapsed≈60 ms)
//   Snap-back:    20 ms (direction reversal → crack confirmed, ts≈+220 ms)
//   Recovery:     60 ms (az=9.5 low motion → gravity re-converges for next rep)
//   Total:       300 ms

export const COMPACT_CRACK: IMUSample[] = buildTrace(7000, [
  { durationMs: 100, ax: 0.1, ay: 0.1, az: 9.5, gx: 0.05, gy: 0.05, gz: 0.05 },
  { durationMs: 50,
    ax: 0.1, ay: 0.1, az: 9.5, gx: 0.05, gy: 0.05, gz: 0.05,
    ax2: 2,  ay2: 1,  az2: 5,  gx2: 0,   gy2: 9,   gz2: 1 },
  { durationMs: 50,  ax: 2, ay: 1, az: 5, gx: 0, gy: 9, gz: 1 },
  { durationMs: 20,  ax: 24, ay: 14, az: 3, gx: 1, gy: 6, gz: 1 },
  { durationMs: 20,  ax: -18, ay: -12, az: 4, gx: 0.8, gy: 4, gz: 0.5 },
  // Recovery: return to az=9.5 low-motion state so next rep's wind-up detects
  { durationMs: 60,  ax: 0.1, ay: 0.1, az: 9.5, gx: 0.05, gy: 0.05, gz: 0.05 },
]);

// ─── NON-CRACK FIXTURE 1: gentle shake ───────────────────────────────────────
// Gyro stays well below threshold, no jerk spike.

export const NON_CRACK_SHAKE: IMUSample[] = buildTrace(4000, [
  { durationMs: 100, ax: 1, ay: 0.5, az: 4, gx: 0.3, gy: 0.5, gz: 0.3 },
  { durationMs: 100, ax: 1, ay: 0.5, az: 4, gx: 0.3, gy: 0.5, gz: 0.3,
                     ax2: -1, ay2: -0.5, az2: 4, gx2: -0.3, gy2: -0.5, gz2: -0.3 },
  { durationMs: 100, ax: -1, ay: -0.5, az: 4, gx: -0.3, gy: -0.5, gz: -0.3 },
  { durationMs: 100, ax: -1, ay: -0.5, az: 4, gx: -0.3, gy: -0.5, gz: -0.3,
                     ax2: 0.1, ay2: 0.1, az2: 4, gx2: 0.05, gy2: 0.05, gz2: 0.05 },
  { durationMs: 100, ax: 0.1, ay: 0.1, az: 4, gx: 0.05, gy: 0.05, gz: 0.05 },
]);

// ─── NON-CRACK FIXTURE 2: fast swing but no snap-back ─────────────────────────
// Has wind-up and a jerk spike (entering CRACK_WATCH), but the deceleration is
// a smooth ramp in the SAME direction — dot product with crack accel stays > 0,
// and per-sample vectorJerk (~50 m/s³) is below the 0.4×threshold requirement.

export const NON_CRACK_NO_SNAPBACK: IMUSample[] = buildTrace(5000, [
  { durationMs: 200, ax: 0.2, ay: 0.1, az: 9.0, gx: 0.1, gy: 0.1, gz: 0.1 },
  { durationMs: 150,
    ax: 0.2, ay: 0.1, az: 9.0, gx: 0.1, gy: 0.1, gz: 0.1,
    ax2: 3,  ay2: 2,  az2: 5,  gx2: 0,  gy2: 10, gz2: 2 },
  { durationMs: 60,  ax: 3, ay: 2, az: 5, gx: 0, gy: 10, gz: 2 },
  // Sharp forward jerk spike (intentional step)
  { durationMs: 20,  ax: 23, ay: 14, az: 3, gx: 1, gy: 7, gz: 1 },
  // Gradual decel from the same start value, same direction (no reversal).
  // Per-sample vectorJerk ≈ 45 m/s³ < effectiveJerk×0.4 = 72. dot stays > 0.
  { durationMs: 600, ax: 23, ay: 14, az: 3, gx: 1, gy: 7, gz: 1,
                     ax2: 1, ay2: 0.5, az2: 3, gx2: 0.1, gy2: 0.5, gz2: 0.1 },
]);

// ─── NON-CRACK FIXTURE 3: dropped phone (free-fall) ───────────────────────────

export const NON_CRACK_FREE_FALL: IMUSample[] = buildTrace(6000, [
  { durationMs: 100, ax: 0.1, ay: 0.1, az: 9.8, gx: 0, gy: 0, gz: 0 },
  { durationMs: 300, ax: 0.1, ay: 0.1, az: 0.1, gx: 0.1, gy: 0.1, gz: 0.1 },
  { durationMs: 50,  ax: 20, ay: 10, az: 30, gx: 5, gy: 8, gz: 3 },
]);
