import React from 'react';
import {
  View, Text, StyleSheet, Switch, ScrollView,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { SafeAreaView } from "react-native-safe-area-context";
import { useStore } from '../store';

export default function SettingsScreen() {
  const { settings, updateSettings, calibration } = useStore();

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Settings</Text>

        {/* Sensitivity */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Detection Sensitivity</Text>
          <Text style={styles.sectionSub}>
            Higher = easier to trigger. Lower = fewer false positives.
          </Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            step={0.05}
            value={settings.sensitivity}
            onSlidingComplete={(v) => updateSettings({ sensitivity: v })}
            minimumTrackTintColor="#e74c3c"
            maximumTrackTintColor="#444"
            thumbTintColor="#fff"
          />
          <Text style={styles.sliderValue}>{(settings.sensitivity * 100).toFixed(0)}%</Text>
        </View>

        {/* Haptics */}
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Haptic Feedback</Text>
          <Switch
            value={settings.hapticsEnabled}
            onValueChange={(v) => updateSettings({ hapticsEnabled: v })}
            trackColor={{ true: '#e74c3c', false: '#444' }}
            thumbColor="#fff"
          />
        </View>

        {/* Sound */}
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Sound on Crack</Text>
          <Switch
            value={settings.soundEnabled}
            onValueChange={(v) => updateSettings({ soundEnabled: v })}
            trackColor={{ true: '#e74c3c', false: '#444' }}
            thumbColor="#fff"
          />
        </View>

        {/* Wrist strap reminder */}
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Wrist Strap Reminder</Text>
          <Switch
            value={settings.wristStrapReminder}
            onValueChange={(v) => updateSettings({ wristStrapReminder: v })}
            trackColor={{ true: '#e74c3c', false: '#444' }}
            thumbColor="#fff"
          />
        </View>

        {/* Calibration info */}
        {calibration && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Calibration (from last run)</Text>
            <Text style={styles.calInfo}>
              Gyro threshold: {calibration.gyroThreshold.toFixed(1)} rad/s
            </Text>
            <Text style={styles.calInfo}>
              Jerk threshold: {calibration.jerkThreshold.toFixed(0)} m/s³
            </Text>
            <Text style={styles.sectionSub}>
              Run "Calibrate" on the Whip screen to update.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d0d0d' },
  scroll: { padding: 24 },
  title: { color: '#fff', fontSize: 26, fontWeight: 'bold', marginBottom: 32 },
  section: { marginBottom: 28 },
  sectionLabel: { color: '#fff', fontSize: 17, fontWeight: '600', marginBottom: 4 },
  sectionSub: { color: '#888', fontSize: 13, marginBottom: 12 },
  slider: { width: '100%', height: 40 },
  sliderValue: { color: '#ccc', fontSize: 14, textAlign: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222',
  },
  rowLabel: { color: '#fff', fontSize: 16 },
  calInfo: { color: '#aaa', fontSize: 14, marginTop: 4 },
});
