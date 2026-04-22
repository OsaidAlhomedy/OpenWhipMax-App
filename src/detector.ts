// Gaming gesture detector: "whip swing → arc → snap/crack"
// Fuses accelerometer + gyroscope at ~100 Hz.
//
// Design philosophy: perceptual correctness over physics accuracy.
// Optimized for responsiveness and low false-negatives.
//
// State machine: IDLE → SWING → CRACK_WATCH
//   IDLE        – waiting for meaningful rotation
//   SWING       – tracking motion energy building toward a crack
//   CRACK_WATCH – jerk spike seen; confirming snap within a short window

export interface IMUSample {
  ts: number;        // epoch ms
  // Accelerometer (m/s², includes gravity)
  ax: number; ay: number; az: number;
  // Gyroscope (rad/s)
  gx: number; gy: number; gz: number;
}

export interface Crack {
  ts: number;
  peakJerk: number;
  peakGyro: number;
  confidence: number;
  durationMs: number;
}

export interface DetectorConfig {
  gyroThreshold: number;   // rad/s, default 8
  jerkThreshold: number;   // m/s³, default 180
  sensitivity: number;     // 0..1 — maps slider to threshold multipliers
}

export const DEFAULT_CONFIG: DetectorConfig = {
  gyroThreshold: 8,
  jerkThreshold: 180,
  sensitivity: 0.5,
};

// ─── Internal state ──────────────────────────────────────────────────────────

type Phase = 'IDLE' | 'SWING' | 'CRACK_WATCH';

interface Vec3 { x: number; y: number; z: number }

interface State {
  phase: Phase;
  swingStartTs: number;
  peakGyro: number;
  peakJerk: number;
  peakLinAccel: number;
  gyroAtEntry: number;         // gyroMag when SWING started, used for buildup scoring
  prevLinAccel: Vec3;
  prevLinAccelTs: number;
  // Crack-watch state
  jerkSpikeTs: number;
  crackAccelAtSpike: Vec3;     // linAccel direction at the jerk spike
  // Debounce
  lastCrackTs: number;
  // Free-fall
  freeFallStartTs: number;
  // Rate limiter
  recentCrackTs: number[];
  // Armed
  armed: boolean;
  armTs: number;
  config: DetectorConfig;
  // Per-instance gravity low-pass
  gravity: Vec3;
}

function makeState(config: DetectorConfig = DEFAULT_CONFIG): State {
  return {
    phase: 'IDLE',
    swingStartTs: 0,
    peakGyro: 0,
    peakJerk: 0,
    peakLinAccel: 0,
    gyroAtEntry: 0,
    prevLinAccel: { x: 0, y: 0, z: 0 },
    prevLinAccelTs: 0,
    jerkSpikeTs: 0,
    crackAccelAtSpike: { x: 0, y: 0, z: 0 },
    lastCrackTs: 0,
    freeFallStartTs: 0,
    recentCrackTs: [],
    armed: false,
    armTs: 0,
    config,
    gravity: { x: 0, y: 0, z: 9.81 },
  };
}

// ─── Detector class ───────────────────────────────────────────────────────────

export type DisarmReason = 'free_fall' | 'rate_limit';

export class Detector {
  private s: State;
  onDisarm?: (reason: DisarmReason) => void;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.s = makeState({ ...DEFAULT_CONFIG, ...config });
  }

  arm(ts: number = Date.now()): void {
    this.s.armed = true;
    this.s.armTs = ts;
    this.s.phase = 'IDLE';
  }

  disarm(): void {
    this.s.armed = false;
    this.s.phase = 'IDLE';
  }

  get isArmed(): boolean { return this.s.armed; }

  updateConfig(patch: Partial<DetectorConfig>): void {
    this.s.config = { ...this.s.config, ...patch };
  }

  feedSample(sample: IMUSample): Crack | null {
    const s = this.s;

    // Gravity removal (low-pass per instance)
    const lin = gravityRemove(sample, s.gravity);
    const linMag = mag3v(lin);
    const gyroMag = mag3(sample.gx, sample.gy, sample.gz);
    const accelMag = mag3(sample.ax, sample.ay, sample.az);

    // ── Free-fall detection
    if (accelMag < FREE_FALL_THRESHOLD) {
      if (s.freeFallStartTs === 0) s.freeFallStartTs = sample.ts;
      if (sample.ts - s.freeFallStartTs > FREE_FALL_DURATION_MS) {
        if (s.armed) {
          s.armed = false;
          s.phase = 'IDLE';
          this.onDisarm?.('free_fall');
        }
        return null;
      }
    } else {
      s.freeFallStartTs = 0;
    }

    if (!s.armed) return null;
    if (sample.ts - s.armTs < ARM_GRACE_MS) {
      s.prevLinAccel = lin;
      s.prevLinAccelTs = sample.ts;
      return null;
    }

    // ── Vector jerk: |Δ(linAccel)| / dt
    // Captures direction reversals that scalar derivative misses.
    let vectorJerk = 0;
    if (s.prevLinAccelTs > 0) {
      const dt = (sample.ts - s.prevLinAccelTs) / 1000;
      if (dt > 0) {
        vectorJerk = mag3(
          lin.x - s.prevLinAccel.x,
          lin.y - s.prevLinAccel.y,
          lin.z - s.prevLinAccel.z,
        ) / dt;
      }
    }
    s.prevLinAccel = lin;
    s.prevLinAccelTs = sample.ts;

    // ── Effective thresholds (sensitivity-adjusted)
    const effectiveGyro = sensitivityToThreshold(s.config.gyroThreshold, s.config.sensitivity, GYRO_RANGE);
    const effectiveJerk = sensitivityToThreshold(s.config.jerkThreshold, s.config.sensitivity, JERK_RANGE);

    const now = sample.ts;

    switch (s.phase) {

      case 'IDLE': {
        // Enter SWING as soon as meaningful rotation is detected — no orientation
        // requirement, no stillness prerequisite. The snap is what confirms the gesture.
        if (gyroMag >= SWING_ENTRY_GYRO) {
          s.phase = 'SWING';
          s.swingStartTs = now;
          s.peakGyro = gyroMag;
          s.peakJerk = 0;
          s.peakLinAccel = linMag;
          s.gyroAtEntry = gyroMag;
        }
        break;
      }

      case 'SWING': {
        const elapsed = now - s.swingStartTs;
        if (gyroMag > s.peakGyro) s.peakGyro = gyroMag;
        if (linMag > s.peakLinAccel) s.peakLinAccel = linMag;
        if (vectorJerk > s.peakJerk) s.peakJerk = vectorJerk;

        // Stale swing: rotation has been decelerating for too long without a snap.
        // Reset so we don't carry stale peak values into the next real gesture.
        if (elapsed > SWING_MAX_MS) {
          s.phase = 'IDLE';
          break;
        }

        // Jerk spike = candidate crack moment; enter confirmation window
        if (elapsed >= SWING_MIN_MS && vectorJerk >= effectiveJerk) {
          s.phase = 'CRACK_WATCH';
          s.jerkSpikeTs = now;
          s.crackAccelAtSpike = { ...lin };
        }
        break;
      }

      case 'CRACK_WATCH': {
        const elapsed = now - s.jerkSpikeTs;
        if (vectorJerk > s.peakJerk) s.peakJerk = vectorJerk;

        if (elapsed > SNAPBACK_MS) {
          s.phase = 'IDLE';
          break;
        }

        if (elapsed > 0) {
          // dot < 0 means linear accel reversed direction → classic snap-back
          const dot = lin.x * s.crackAccelAtSpike.x +
                      lin.y * s.crackAccelAtSpike.y +
                      lin.z * s.crackAccelAtSpike.z;

          const isReversal  = vectorJerk >= effectiveJerk * REVERSAL_JERK_RATIO && dot < 0;
          // Hard snap: jerk is so large that we don't require a direction reversal.
          // Covers stiff wrist-snaps and short sharp flicks.
          const isHardSnap  = vectorJerk >= effectiveJerk * HARD_SNAP_JERK_RATIO;

          if (isReversal || isHardSnap) {
            s.phase = 'IDLE';

            if (now - s.lastCrackTs < DEBOUNCE_MS) break;

            s.recentCrackTs = s.recentCrackTs.filter(t => now - t < RATE_WINDOW_MS);
            s.recentCrackTs.push(now);
            if (s.recentCrackTs.length >= RATE_LIMIT_COUNT) {
              s.armed = false;
              this.onDisarm?.('rate_limit');
              break;
            }

            s.lastCrackTs = now;
            const durationMs = now - s.swingStartTs;
            const confidence = computeConfidence(
              s.peakJerk, effectiveJerk,
              s.peakGyro, effectiveGyro,
              durationMs,
              s.gyroAtEntry,
              isHardSnap,
            );
            return { ts: now, peakJerk: s.peakJerk, peakGyro: s.peakGyro, confidence, durationMs };
          }
        }
        break;
      }
    }

    return null;
  }

  reset(): void {
    const config = this.s.config;
    this.s = makeState(config);
  }
}

// ─── Pure functional API ──────────────────────────────────────────────────────

export function createDetector(config?: Partial<DetectorConfig>): Detector {
  return new Detector(config);
}

export function runDetector(
  samples: IMUSample[],
  config?: Partial<DetectorConfig>,
  armAt?: number
): Crack | null {
  const d = new Detector(config);
  const armTs = armAt ?? (samples[0]?.ts ?? Date.now()) - 1000;
  d.arm(armTs);
  for (const s of samples) {
    const result = d.feedSample(s);
    if (result) return result;
  }
  return null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const FREE_FALL_THRESHOLD  = 2;
const FREE_FALL_DURATION_MS = 150;
const ARM_GRACE_MS          = 500;
const DEBOUNCE_MS           = 300;

// SWING_ENTRY_GYRO is intentionally lower than effectiveGyro — we enter SWING
// early to track buildup, and rely on the jerk threshold to confirm the gesture.
const SWING_ENTRY_GYRO = 4;  // rad/s
const SWING_MIN_MS     = 40; // minimum swing duration before a snap is credible
const SWING_MAX_MS     = 600; // stale after this; reset and wait for next gesture

// Snap confirmation window. Wider than before to accommodate natural snap timing.
const SNAPBACK_MS = 100;

// Reversal: moderate jerk + direction flip (classic snap-back)
const REVERSAL_JERK_RATIO  = 0.3;
// Hard snap: very high jerk alone, no reversal required (stiff wrist or short flick)
const HARD_SNAP_JERK_RATIO = 1.6;

const RATE_WINDOW_MS    = 3000;
const RATE_LIMIT_COUNT  = 10;

const GYRO_RANGE: [number, number] = [4, 14];
const JERK_RANGE: [number, number] = [80, 300];

const GRAVITY_ALPHA = 0.8;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mag3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function mag3v(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function gravityRemove(s: IMUSample, g: Vec3): Vec3 {
  g.x = GRAVITY_ALPHA * g.x + (1 - GRAVITY_ALPHA) * s.ax;
  g.y = GRAVITY_ALPHA * g.y + (1 - GRAVITY_ALPHA) * s.ay;
  g.z = GRAVITY_ALPHA * g.z + (1 - GRAVITY_ALPHA) * s.az;
  return { x: s.ax - g.x, y: s.ay - g.y, z: s.az - g.z };
}

function sensitivityToThreshold(base: number, sensitivity: number, range: [number, number]): number {
  const t = sensitivity * 2 - 1; // -1..1
  if (t < 0) return base + (range[1] - base) * (-t);
  return base + (range[0] - base) * t;
}

function computeConfidence(
  peakJerk: number,  jerkThresh: number,
  peakGyro: number,  gyroThresh: number,
  durationMs: number,
  gyroAtEntry: number,
  isHardSnap: boolean,
): number {
  // How sharp was the snap?
  const jerkScore = Math.min(peakJerk / jerkThresh, 2) / 2;
  // How much arc/rotation was there during the swing?
  const gyroScore = Math.min(peakGyro / gyroThresh, 2) / 2;
  // Did rotation build up (small at entry, large at snap)?
  // Ratio > 1 means it grew; capped at 3× for scoring purposes.
  const buildupScore = gyroAtEntry > 0
    ? Math.min((peakGyro / gyroAtEntry - 1) / 2, 1)
    : 0.5;
  // Duration: ideal whip crack is ~200–500 ms
  const durationScore = Math.max(0, 1 - Math.abs(durationMs - 350) / 300);
  // Hard snaps (unambiguous) get a small bonus
  const snapBonus = isHardSnap ? 0.08 : 0;

  return Math.min(1,
    0.40 * jerkScore +
    0.28 * gyroScore +
    0.17 * buildupScore +
    0.15 * durationScore +
    snapBonus,
  );
}
