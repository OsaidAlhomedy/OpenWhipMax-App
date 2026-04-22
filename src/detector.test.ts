import {
  Detector,
  runDetector,
  DEFAULT_CONFIG,
  IMUSample,
  Crack,
} from './detector';
import {
  CRACK_1,
  CRACK_2,
  CRACK_3,
  COMPACT_CRACK,
  NON_CRACK_SHAKE,
  NON_CRACK_NO_SNAPBACK,
  NON_CRACK_FREE_FALL,
} from './fixtures/imu';

// ─── Utility ──────────────────────────────────────────────────────────────────

// Arm 700 ms before the first sample so the grace period is well past
function armOffset(samples: IMUSample[]): number {
  return (samples[0]?.ts ?? 0) - 700;
}

// ─── CRACK FIXTURES: must detect ─────────────────────────────────────────────

describe('Crack detection — positive fixtures', () => {
  test('CRACK_1: clean overhead crack is detected', () => {
    const result = runDetector(CRACK_1, DEFAULT_CONFIG, armOffset(CRACK_1));
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0.4);
    expect(result!.peakJerk).toBeGreaterThan(0);
    expect(result!.peakGyro).toBeGreaterThan(0);
    expect(result!.durationMs).toBeGreaterThan(0);
    expect(result!.durationMs).toBeLessThan(700);
  });

  test('CRACK_2: aggressive fast crack is detected', () => {
    const result = runDetector(CRACK_2, DEFAULT_CONFIG, armOffset(CRACK_2));
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0.4);
  });

  test('CRACK_3: lower-confidence crack is still detected', () => {
    const result = runDetector(CRACK_3, DEFAULT_CONFIG, armOffset(CRACK_3));
    expect(result).not.toBeNull();
    // Confidence may be lower — just verify it fires
    expect(result!.confidence).toBeGreaterThan(0);
  });
});

// ─── NON-CRACK FIXTURES: must not detect ─────────────────────────────────────

describe('Crack detection — negative fixtures', () => {
  test('NON_CRACK_SHAKE: gentle phone wave does not trigger', () => {
    const result = runDetector(NON_CRACK_SHAKE, DEFAULT_CONFIG, armOffset(NON_CRACK_SHAKE));
    expect(result).toBeNull();
  });

  test('NON_CRACK_NO_SNAPBACK: fast swing without snap-back does not trigger', () => {
    const result = runDetector(NON_CRACK_NO_SNAPBACK, DEFAULT_CONFIG, armOffset(NON_CRACK_NO_SNAPBACK));
    expect(result).toBeNull();
  });

  test('NON_CRACK_FREE_FALL: dropped phone triggers disarm, not a crack', () => {
    let disarmed = false;
    const d = new Detector(DEFAULT_CONFIG);
    d.onDisarm = () => { disarmed = true; };
    d.arm(armOffset(NON_CRACK_FREE_FALL));

    let crackFired = false;
    for (const s of NON_CRACK_FREE_FALL) {
      if (d.feedSample(s)) crackFired = true;
    }

    expect(crackFired).toBe(false);
    expect(disarmed).toBe(true);
    expect(d.isArmed).toBe(false);
  });
});

// ─── Safety interlock: rate limit ────────────────────────────────────────────

describe('Safety interlocks', () => {
  test('rate limit: auto-disarms after 10 cracks in 3 s', () => {
    // Feed COMPACT_CRACK repeatedly at 305 ms spacing (just past 300 ms debounce).
    // 10 cracks at t=0, 305, 610, ..., 2745 ms — all within 3 s window.
    // With push-first rate-limit logic, the 10th crack triggers disarm.
    const d = new Detector(DEFAULT_CONFIG);
    let disarmed = false;
    d.onDisarm = (r) => { if (r === 'rate_limit') disarmed = true; };
    d.arm(COMPACT_CRACK[0].ts - 700);

    let crackCount = 0;
    // 300 ms spacing: debounce check is `spacing < 300` which is `300 < 300` = false (passes).
    // With 9×300 = 2700 ms span, all 10 cracks fit inside the 3000 ms window, triggering
    // the rate limit at the 10th crack.
    const SPACING_MS = 300;
    for (let rep = 0; rep < 20 && !disarmed; rep++) {
      const offset = rep * SPACING_MS;
      for (const s of COMPACT_CRACK) {
        const shifted: IMUSample = { ...s, ts: s.ts + offset };
        if (d.feedSample(shifted)) crackCount++;
      }
    }

    expect(disarmed).toBe(true);
    expect(d.isArmed).toBe(false);
    // At most 9 cracks emitted — the 10th triggers disarm without emitting
    expect(crackCount).toBeLessThan(10);
  });

  test('arm grace: no crack fires within 500 ms of arm', () => {
    const d = new Detector(DEFAULT_CONFIG);
    d.arm(CRACK_1[0].ts); // arm exactly at trace start

    // Feed all CRACK_1 samples — they all fall within 500 ms grace window
    let fired = false;
    for (const s of CRACK_1) {
      if (d.feedSample(s)) fired = true;
    }
    expect(fired).toBe(false);
  });

  test('debounce: second crack within 300 ms is suppressed', () => {
    const d = new Detector(DEFAULT_CONFIG);
    d.arm(armOffset(CRACK_1));

    let crackCount = 0;
    // Feed trace once (should produce 1 crack)
    for (const s of CRACK_1) {
      if (d.feedSample(s)) crackCount++;
    }
    // Immediately feed same trace again — all within 300 ms debounce window
    for (const s of CRACK_1) {
      if (d.feedSample(s)) crackCount++;
    }

    expect(crackCount).toBe(1);
  });
});

// ─── Confidence range ─────────────────────────────────────────────────────────

describe('Confidence scoring', () => {
  test('confidence is in [0, 1]', () => {
    for (const trace of [CRACK_1, CRACK_2, CRACK_3]) {
      const r = runDetector(trace, DEFAULT_CONFIG, armOffset(trace));
      if (r) {
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  test('CRACK_1 and CRACK_3 confidence both above 0.4 (both are real cracks)', () => {
    const r1 = runDetector(CRACK_1, DEFAULT_CONFIG, armOffset(CRACK_1));
    const r3 = runDetector(CRACK_3, DEFAULT_CONFIG, armOffset(CRACK_3));
    expect(r1?.confidence).toBeGreaterThan(0.4);
    expect(r3?.confidence).toBeGreaterThan(0.4);
  });
});

// ─── Sensitivity config ───────────────────────────────────────────────────────

describe('Sensitivity configuration', () => {
  test('sensitivity=1 (easy) detects CRACK_3 which may miss on default', () => {
    // At max sensitivity, thresholds drop to the minimum of the range
    const result = runDetector(CRACK_3, { ...DEFAULT_CONFIG, sensitivity: 1 }, armOffset(CRACK_3));
    expect(result).not.toBeNull();
  });

  test('sensitivity=0 (hard) should not false-positive on NON_CRACK_SHAKE', () => {
    const result = runDetector(NON_CRACK_SHAKE, { ...DEFAULT_CONFIG, sensitivity: 0 }, armOffset(NON_CRACK_SHAKE));
    expect(result).toBeNull();
  });
});

// ─── Message schema fields ────────────────────────────────────────────────────

describe('Crack message fields', () => {
  test('crack result has all required fields for wire format', () => {
    const result = runDetector(CRACK_1, DEFAULT_CONFIG, armOffset(CRACK_1));
    expect(result).not.toBeNull();
    const r = result as Crack;
    expect(typeof r.ts).toBe('number');
    expect(typeof r.peakJerk).toBe('number');
    expect(typeof r.peakGyro).toBe('number');
    expect(typeof r.confidence).toBe('number');
    expect(typeof r.durationMs).toBe('number');
    expect(r.ts).toBeGreaterThan(0);
    expect(r.peakJerk).toBeGreaterThan(0);
    expect(r.peakGyro).toBeGreaterThan(0);
  });
});
