// Global app state using zustand.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WhipWSClient, ConnectionState } from './ws';
import { DEFAULT_CONFIG, DetectorConfig } from './detector';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PairInfo {
  host: string;
  port: number;
  token: string;
}

export interface CalibrationData {
  gyroThreshold: number;
  jerkThreshold: number;
}

export interface Settings {
  sensitivity: number;     // 0..1
  hapticsEnabled: boolean;
  soundEnabled: boolean;
  wristStrapReminder: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  sensitivity: 0.5,
  hapticsEnabled: true,
  soundEnabled: true,
  wristStrapReminder: true,
};

export interface AppState {
  // Connection
  pairInfo: PairInfo | null;
  connectionState: ConnectionState;
  wsClient: WhipWSClient;

  // Session
  crackCount: number;
  lastConfidence: number;
  isArmed: boolean;
  droppedModalVisible: boolean;
  wristStrapModalVisible: boolean;
  sessionStarted: boolean;

  // Settings
  settings: Settings;

  // Calibration
  calibration: CalibrationData | null;

  // Computed detector config
  detectorConfig: DetectorConfig;

  // Actions
  setPairInfo: (info: PairInfo) => void;
  setConnectionState: (s: ConnectionState) => void;
  setArmed: (armed: boolean) => void;
  incrementCrack: (confidence: number) => void;
  showDroppedModal: () => void;
  hideDroppedModal: () => void;
  showWristStrapModal: () => void;
  hideWristStrapModal: () => void;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  setCalibration: (cal: CalibrationData) => Promise<void>;
  loadPersistedData: () => Promise<void>;
  resetSession: () => void;
}

const STORAGE_KEY_PAIR = 'openwhipmax:pair';
const STORAGE_KEY_SETTINGS = 'openwhipmax:settings';
const STORAGE_KEY_CALIBRATION = 'openwhipmax:calibration';

function buildDetectorConfig(settings: Settings, cal: CalibrationData | null): DetectorConfig {
  return {
    gyroThreshold: cal?.gyroThreshold ?? DEFAULT_CONFIG.gyroThreshold,
    jerkThreshold: cal?.jerkThreshold ?? DEFAULT_CONFIG.jerkThreshold,
    sensitivity: settings.sensitivity,
  };
}

export const useStore = create<AppState>((set, get) => ({
  pairInfo: null,
  connectionState: 'disconnected',
  wsClient: new WhipWSClient(),
  crackCount: 0,
  lastConfidence: 0,
  isArmed: false,
  droppedModalVisible: false,
  wristStrapModalVisible: false,
  sessionStarted: false,
  settings: DEFAULT_SETTINGS,
  calibration: null,
  detectorConfig: buildDetectorConfig(DEFAULT_SETTINGS, null),

  setPairInfo: (info) => {
    set({ pairInfo: info });
    AsyncStorage.setItem(STORAGE_KEY_PAIR, JSON.stringify(info)).catch(() => {});
  },

  setConnectionState: (s) => set({ connectionState: s }),

  setArmed: (armed) => set({ isArmed: armed }),

  incrementCrack: (confidence) =>
    set((s) => ({ crackCount: s.crackCount + 1, lastConfidence: confidence })),

  showDroppedModal: () => set({ droppedModalVisible: true }),
  hideDroppedModal: () => set({ droppedModalVisible: false }),

  showWristStrapModal: () => set({ wristStrapModalVisible: true }),
  hideWristStrapModal: () => set({ wristStrapModalVisible: false }),

  updateSettings: async (patch) => {
    const next = { ...get().settings, ...patch };
    const config = buildDetectorConfig(next, get().calibration);
    set({ settings: next, detectorConfig: config });
    await AsyncStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(next));
  },

  setCalibration: async (cal) => {
    const config = buildDetectorConfig(get().settings, cal);
    set({ calibration: cal, detectorConfig: config });
    await AsyncStorage.setItem(STORAGE_KEY_CALIBRATION, JSON.stringify(cal));
  },

  loadPersistedData: async () => {
    try {
      const [pairRaw, settingsRaw, calRaw] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY_PAIR),
        AsyncStorage.getItem(STORAGE_KEY_SETTINGS),
        AsyncStorage.getItem(STORAGE_KEY_CALIBRATION),
      ]);
      const pairInfo = pairRaw ? JSON.parse(pairRaw) as PairInfo : null;
      const settings = settingsRaw ? { ...DEFAULT_SETTINGS, ...JSON.parse(settingsRaw) } : DEFAULT_SETTINGS;
      const calibration = calRaw ? JSON.parse(calRaw) as CalibrationData : null;
      const detectorConfig = buildDetectorConfig(settings, calibration);
      set({ pairInfo, settings, calibration, detectorConfig });
    } catch { /* use defaults */ }
  },

  resetSession: () => set({ crackCount: 0, lastConfidence: 0, isArmed: false, sessionStarted: false }),
}));
