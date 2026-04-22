import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal,
  Animated,
} from 'react-native';
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import { useStore } from '../store';
import { Detector, DisarmReason, IMUSample } from '../detector';

// Calibration state machine
type CalibStep = 'idle' | 'still' | 'swing' | 'done';

const CALIBRATION_STILL_MS = 5000;
const CALIBRATION_SWING_MS = 5000;

export default function WhipScreen() {
  useKeepAwake();

  const {
    pairInfo, connectionState, wsClient, crackCount, lastConfidence,
    isArmed, setArmed, incrementCrack, detectorConfig, settings,
    showDroppedModal, droppedModalVisible, hideDroppedModal,
    wristStrapModalVisible, showWristStrapModal, hideWristStrapModal,
    setCalibration, sessionStarted, updateSettings,
  } = useStore();

  const detectorRef = useRef<Detector | null>(null);
  const sensorSubRef = useRef<{ remove: () => void } | null>(null);
  const accelRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const gyroRef = useRef<{ x: number; y: number; z: number } | null>(null);

  // Calibration
  const [calStep, setCalStep] = useState<CalibStep>('idle');
  const calDataRef = useRef<{ peakJerk: number; peakGyro: number } | null>(null);

  // Arm animation
  const armScale = useRef(new Animated.Value(1)).current;

  // ── Sensor subscription ─────────────────────────────────────────────────────

  const startSensors = useCallback(() => {
    Accelerometer.setUpdateInterval(10);
    Gyroscope.setUpdateInterval(10);

    const accelSub = Accelerometer.addListener((data) => { accelRef.current = data; });
    const gyroSub  = Gyroscope.addListener((data)  => { gyroRef.current  = data; });

    // Fuse at ~100 Hz using a single interval
    const timer = setInterval(() => {
      const a = accelRef.current;
      const g = gyroRef.current;
      if (!a || !g) return;

      const sample: IMUSample = {
        ts: Date.now(),
        // expo-sensors reports accel in g — convert to m/s²
        ax: a.x * 9.81, ay: a.y * 9.81, az: a.z * 9.81,
        gx: g.x, gy: g.y, gz: g.z,
      };

      const detector = detectorRef.current;
      if (!detector) return;

      const crack = detector.feedSample(sample);
      if (crack) {
        incrementCrack(crack.confidence);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        wsClient.sendCrack(crack);
      }
    }, 10);

    sensorSubRef.current = {
      remove: () => {
        clearInterval(timer);
        accelSub.remove();
        gyroSub.remove();
      },
    };
  }, [incrementCrack, wsClient]);

  const stopSensors = useCallback(() => {
    sensorSubRef.current?.remove();
    sensorSubRef.current = null;
  }, []);

  // ── Arm / Disarm ─────────────────────────────────────────────────────────────

  const handleArm = useCallback(() => {
    if (!useStore.getState().sessionStarted) {
      useStore.setState({ sessionStarted: true });
      if (settings.wristStrapReminder) showWristStrapModal();
    }

    const detector = new Detector(detectorConfig);
    detector.onDisarm = (reason: DisarmReason) => {
      stopSensors();
      setArmed(false);
      if (reason === 'free_fall') showDroppedModal();
    };

    detectorRef.current = detector;
    detector.arm(Date.now());
    setArmed(true);
    startSensors();

    Animated.sequence([
      Animated.timing(armScale, { toValue: 1.15, duration: 80, useNativeDriver: true }),
      Animated.timing(armScale, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
  }, [detectorConfig, settings.wristStrapReminder, showWristStrapModal, stopSensors, setArmed, showDroppedModal, startSensors, armScale]);

  const handleDisarm = useCallback(() => {
    detectorRef.current?.disarm();
    stopSensors();
    setArmed(false);
  }, [stopSensors, setArmed]);

  // Stop sensors on unmount
  useEffect(() => {
    return () => {
      detectorRef.current?.disarm();
      stopSensors();
    };
  }, [stopSensors]);

  // ── Calibration ─────────────────────────────────────────────────────────────

  const runCalibration = useCallback(async () => {
    if (isArmed) handleDisarm();
    calDataRef.current = null;
    setCalStep('still');

    // Phase 1: hold still for 5 s (noise floor — but we don't use it currently)
    await new Promise(r => setTimeout(r, CALIBRATION_STILL_MS));
    setCalStep('swing');

    // Phase 2: one practice swing
    const calDetector = new Detector({ ...detectorConfig, sensitivity: 1 }); // easy sensitivity
    let peakJerk = 0;
    let peakGyro = 0;

    calDetector.arm(Date.now());
    const accelSub = Accelerometer.addListener((a) => { accelRef.current = a; });
    const gyroSub  = Gyroscope.addListener((g) => { gyroRef.current  = g; });

    const calTimer = setInterval(() => {
      const a = accelRef.current;
      const g = gyroRef.current;
      if (!a || !g) return;
      const sample: IMUSample = {
        ts: Date.now(),
        ax: a.x * 9.81, ay: a.y * 9.81, az: a.z * 9.81,
        gx: g.x, gy: g.y, gz: g.z,
      };
      const crack = calDetector.feedSample(sample);
      if (crack) {
        peakJerk = Math.max(peakJerk, crack.peakJerk);
        peakGyro = Math.max(peakGyro, crack.peakGyro);
      }
    }, 10);

    await new Promise(r => setTimeout(r, CALIBRATION_SWING_MS));
    clearInterval(calTimer);
    accelSub.remove();
    gyroSub.remove();

    if (peakJerk > 0 && peakGyro > 0) {
      await setCalibration({
        jerkThreshold: peakJerk * 0.7,
        gyroThreshold: peakGyro * 0.7,
      });
    }
    setCalStep('done');
    setTimeout(() => setCalStep('idle'), 1500);
  }, [isArmed, handleDisarm, detectorConfig, setCalibration]);

  // ── WS events ────────────────────────────────────────────────────────────────

  useEffect(() => {
    return wsClient.on((evt) => {
      if (evt.kind === 'struck') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    });
  }, [wsClient]);

  // ── Reconnect ────────────────────────────────────────────────────────────────

  const handleReconnect = useCallback(() => {
    if (pairInfo) {
      wsClient.disconnect();
      wsClient.connect({ ...pairInfo, deviceName: 'OpenWhipMax Phone' });
    }
  }, [pairInfo, wsClient]);

  // ── Render ───────────────────────────────────────────────────────────────────

  const connected = connectionState === 'connected';

  const calLabel = calStep === 'still'
    ? 'Hold still...'
    : calStep === 'swing'
    ? 'Do one whip crack!'
    : calStep === 'done'
    ? 'Calibrated ✓'
    : null;

  return (
    <SafeAreaView style={styles.container}>
      {/* Status bar */}
      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: connected ? '#2ecc71' : '#e74c3c' }]} />
        <Text style={styles.statusText}>{connected ? 'Connected' : 'Disconnected'}</Text>
        {!connected && (
          <TouchableOpacity onPress={handleReconnect} style={styles.reconnectBtn}>
            <Text style={styles.reconnectText}>Reconnect</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Whip graphic */}
      <View style={styles.graphicArea}>
        {/* <Text style={styles.whipEmoji}></Text> */}
        <Text style={styles.crackCount}>{crackCount}</Text>
        <Text style={styles.crackLabel}>cracks this session</Text>
      </View>

      {/* Confidence bar */}
      <View style={styles.confBar}>
        <View style={[styles.confFill, { width: `${lastConfidence * 100}%` }]} />
      </View>
      <Text style={styles.confLabel}>
        {lastConfidence > 0 ? `Confidence: ${(lastConfidence * 100).toFixed(0)}%` : 'No crack yet'}
      </Text>

      {/* Calibration status */}
      {calLabel && (
        <Text style={styles.calStatus}>{calLabel}</Text>
      )}

      {/* ARM / DISARM button */}
      <Animated.View style={{ transform: [{ scale: armScale }] }}>
        <TouchableOpacity
          style={[styles.armBtn, isArmed ? styles.armBtnActive : {}]}
          onPress={isArmed ? handleDisarm : handleArm}
          activeOpacity={0.8}
        >
          <Text style={styles.armBtnText}>{isArmed ? 'DISARM' : 'ARM'}</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Calibrate & Disconnect */}
      <View style={styles.footerRow}>
        <TouchableOpacity
          style={styles.footerBtn}
          onPress={runCalibration}
          disabled={calStep !== 'idle'}
        >
          <Text style={styles.footerBtnText}>Calibrate</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.footerBtn}
          onPress={() => {
            handleDisarm();
            wsClient.disconnect();
            useStore.setState({ pairInfo: null });
          }}
        >
          <Text style={styles.footerBtnText}>Disconnect</Text>
        </TouchableOpacity>
      </View>

      {/* Dropped modal */}
      <Modal visible={droppedModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>⚠️ DROPPED?</Text>
            <Text style={styles.modalBody}>
              Free-fall detected. Detector disarmed for safety.{'\n'}
              Please use a wrist strap before re-arming.
            </Text>
            <TouchableOpacity style={styles.modalBtn} onPress={hideDroppedModal}>
              <Text style={styles.btnText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Wrist-strap reminder modal */}
      <Modal visible={wristStrapModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>👋 Safety First</Text>
            <Text style={styles.modalBody}>
              Please attach your wrist strap before swinging to prevent dropping your phone.
            </Text>
            <TouchableOpacity
              style={styles.modalBtn}
              onPress={() => {
                hideWristStrapModal();
                updateSettings({ wristStrapReminder: false });
              }}
            >
              <Text style={styles.btnText}>Got it, don't remind me</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalBtn, styles.modalBtnSecondary]} onPress={hideWristStrapModal}>
              <Text style={styles.btnText}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d0d', alignItems: 'center', paddingHorizontal: 24 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  statusText: { color: '#ccc', fontSize: 14 },
  reconnectBtn: { marginLeft: 12, backgroundColor: '#333', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 },
  reconnectText: { color: '#fff', fontSize: 13 },

  graphicArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  whipEmoji: { fontSize: 80 },
  crackCount: { color: '#fff', fontSize: 72, fontWeight: 'bold', marginTop: 12 },
  crackLabel: { color: '#888', fontSize: 16 },

  confBar: { width: '100%', height: 8, backgroundColor: '#222', borderRadius: 4, overflow: 'hidden', marginBottom: 6 },
  confFill: { height: 8, backgroundColor: '#e74c3c', borderRadius: 4 },
  confLabel: { color: '#888', fontSize: 13, marginBottom: 20 },

  calStatus: { color: '#f39c12', fontSize: 16, marginBottom: 12 },

  armBtn: {
    width: 180, height: 180, borderRadius: 90,
    backgroundColor: '#1a1a1a', borderWidth: 4, borderColor: '#c0392b',
    alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  armBtnActive: { backgroundColor: '#c0392b', borderColor: '#e74c3c' },
  armBtnText: { color: '#fff', fontSize: 28, fontWeight: 'bold', letterSpacing: 3 },

  footerRow: { flexDirection: 'row', gap: 16, marginBottom: 24 },
  footerBtn: { backgroundColor: '#1a1a1a', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12 },
  footerBtnText: { color: '#ccc', fontSize: 15 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 24, width: '100%', alignItems: 'center' },
  modalTitle: { color: '#fff', fontSize: 22, fontWeight: 'bold', marginBottom: 12 },
  modalBody: { color: '#ccc', fontSize: 15, textAlign: 'center', marginBottom: 24, lineHeight: 22 },
  modalBtn: { backgroundColor: '#c0392b', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 14, marginBottom: 10, width: '100%', alignItems: 'center' },
  modalBtnSecondary: { backgroundColor: '#333' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
