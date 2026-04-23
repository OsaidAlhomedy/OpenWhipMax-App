import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useStore } from '../store';
import { PairInfo } from '../store';

// QR format: openwhipmax://connect?host=<ip>&port=<p>&token=<t>
function parseQR(data: string): PairInfo | null {
  try {
    const url = new URL(data);
    if (url.protocol !== 'openwhipmax:') return null;
    const host = url.searchParams.get('host');
    const port = parseInt(url.searchParams.get('port') ?? '', 10);
    const token = url.searchParams.get('token');
    if (!host || !port || !token) return null;
    return { host, port, token };
  } catch {
    return null;
  }
}

export default function PairScreen() {
  const [scanning, setScanning] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  const { setPairInfo, wsClient, pairInfo } = useStore();

  const handleQRScan = useCallback(({ data }: { data: string }) => {
    if (scanned) return;
    const info = parseQR(data);
    if (!info) {
      Alert.alert('Invalid QR', 'This QR code is not a valid OpenWhipMax pairing code.');
      return;
    }
    console.log('[Pair] scanned info:', JSON.stringify(info));
    setScanned(true);
    setPairInfo(info);
    wsClient.connect({ ...info, deviceName: 'OpenWhipMax Phone' });
  }, [scanned, setPairInfo, wsClient]);

  if (pairInfo) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>Already Paired</Text>
        <Text style={styles.body}>{pairInfo.host}:{pairInfo.port}</Text>
        <TouchableOpacity style={styles.btn} onPress={() => useStore.setState({ pairInfo: null })}>
          <Text style={styles.btnText}>Pair Different Agent</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (!scanning) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>Pair with Agent</Text>
        <TouchableOpacity style={styles.btn} onPress={async () => {
          if (!cameraPermission?.granted) await requestCameraPermission();
          setScanned(false);
          setScanning(true);
        }}>
          <Text style={styles.btnText}>Scan QR Code</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (!cameraPermission?.granted) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.body}>Camera permission required.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestCameraPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleQRScan}
      />
      <SafeAreaView style={styles.overlay}>
        <Text style={styles.scanHint}>Point at the QR code shown in openwhipmax-agent</Text>
        <TouchableOpacity style={styles.btnSmall} onPress={() => setScanning(false)}>
          <Text style={styles.btnText}>Cancel</Text>
        </TouchableOpacity>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#0d0d0d', alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  title: { color: '#fff', fontSize: 26, fontWeight: 'bold', marginBottom: 32 },
  body: { color: '#aaa', fontSize: 16, textAlign: 'center', marginBottom: 24 },
  btn: {
    backgroundColor: '#c0392b', borderRadius: 12, paddingVertical: 16, paddingHorizontal: 32,
    marginBottom: 16, minWidth: 220, alignItems: 'center',
  },
  btnSmall: {
    backgroundColor: '#333', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20,
    marginTop: 16,
  },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  overlay: { position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center' },
  scanHint: { color: '#fff', fontSize: 16, textAlign: 'center', marginBottom: 12, backgroundColor: 'rgba(0,0,0,0.6)', padding: 8, borderRadius: 8 },
});
