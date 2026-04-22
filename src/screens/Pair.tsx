import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator,
  Alert,
} from 'react-native';
import ZeroconfClass from 'react-native-zeroconf'
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

type Step = 'choose' | 'scan' | 'mdns_list' | 'mdns_scan';

interface MDNSService {
  name: string;
  host: string;
  port: number;
}

interface ZeroconfService {
  host: string;
  port: number;
  name?: string;
}

export default function PairScreen() {
  const [step, setStep] = useState<Step>('choose');
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [mdnsServices, setMdnsServices] = useState<MDNSService[]>([]);
  const [selectedService, setSelectedService] = useState<MDNSService | null>(null);
  const [scanning, setScanning] = useState(false);
  const zeroconfRef = useRef<{ start: () => void; stop: () => void } | null>(null);

  const { setPairInfo, wsClient, pairInfo } = useStore();

  // Start mDNS scan
  useEffect(() => {
    if (step !== 'mdns_list') return;
    setScanning(true);
    setMdnsServices([]);

    let ZeroconfClass: new () => any;
    try {
      ZeroconfClass = require('react-native-zeroconf');
    } catch {
      setScanning(false);
      return;
    }
    console.log("Before ZeroconfClass")

    const zc = new ZeroconfClass();

    zeroconfRef.current = zc;

    zc.on('resolved', (service: ZeroconfService) => {
      setMdnsServices((prev) => {
        if (prev.some(s => s.host === service.host && s.port === service.port)) return prev;
        return [...prev, { name: service.name ?? service.host, host: service.host, port: service.port }];
      });
    });

    zc.scan('openwhipmax', 'tcp', 'local.');
    const timeout = setTimeout(() => setScanning(false), 10_000);

    return () => {
      clearTimeout(timeout);
      zc.stop();
      zeroconfRef.current = null;
    };
  }, [step]);

  const handleQRScan = useCallback(({ data }: { data: string }) => {
    if (scanned) return;
    const info = parseQR(data);
    if (!info) {
      Alert.alert('Invalid QR', 'This QR code is not a valid OpenWhipMax pairing code.');
      return;
    }
    setScanned(true);
    setPairInfo(info);
    wsClient.connect({ ...info, deviceName: 'OpenWhipMax Phone' });
  }, [scanned, setPairInfo, wsClient]);

  const handleMDNSSelect = (service: MDNSService) => {
    setSelectedService(service);
    setStep('mdns_scan');
    setScanned(false);
  };

  const handleMDNSScan = useCallback(({ data }: { data: string }) => {
    if (!selectedService || scanned) return;
    const info = parseQR(data);
    if (!info) {
      Alert.alert('Invalid QR', 'Scan the QR code shown in openwhipmax-agent.');
      return;
    }
    // Override host/port from mDNS, use token from QR
    const merged: PairInfo = { host: selectedService.host, port: selectedService.port, token: info.token };
    setScanned(true);
    setPairInfo(merged);
    wsClient.connect({ ...merged, deviceName: 'OpenWhipMax Phone' });
  }, [selectedService, scanned, setPairInfo, wsClient]);

  // ── Already paired ──────────────────────────────────────────────────────────
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

  // ── Choose path ─────────────────────────────────────────────────────────────
  if (step === 'choose') {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>Pair with Agent</Text>
        <TouchableOpacity style={styles.btn} onPress={async () => {
          if (!cameraPermission?.granted) await requestCameraPermission();
          setScanned(false);
          setStep('scan');
        }}>
          <Text style={styles.btnText}>Scan QR Code</Text>
        </TouchableOpacity>
        {/* <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={() => setStep('mdns_list')}>
          <Text style={styles.btnText}>Discover on LAN</Text>
        </TouchableOpacity> */}
      </SafeAreaView>
    );
  }

  // ── QR scan ─────────────────────────────────────────────────────────────────
  if (step === 'scan') {
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
          <TouchableOpacity style={styles.btnSmall} onPress={() => setStep('choose')}>
            <Text style={styles.btnText}>Cancel</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </View>
    );
  }

  // // ── mDNS list ────────────────────────────────────────────────────────────────
  // if (step === 'mdns_list') {
  //   return (
  //     <SafeAreaView style={styles.container}>
  //       <Text style={styles.title}>Agents on LAN</Text>
  //       {scanning && <ActivityIndicator color="#fff" style={{ marginBottom: 12 }} />}
  //       {mdnsServices.length === 0 && !scanning && (
  //         <Text style={styles.body}>No agents found. Make sure openwhipmax-agent is running.</Text>
  //       )}
  //       <FlatList
  //         data={mdnsServices}
  //         keyExtractor={(item) => `${item.host}:${item.port}`}
  //         renderItem={({ item }) => (
  //           <TouchableOpacity style={styles.listItem} onPress={() => handleMDNSSelect(item)}>
  //             <Text style={styles.listItemText}>{item.name}</Text>
  //             <Text style={styles.listItemSub}>{item.host}:{item.port}</Text>
  //           </TouchableOpacity>
  //         )}
  //       />
  //       <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={() => setStep('choose')}>
  //         <Text style={styles.btnText}>Back</Text>
  //       </TouchableOpacity>
  //     </SafeAreaView>
  //   );
  // }

  // // ── mDNS token scan ──────────────────────────────────────────────────────────
  // if (step === 'mdns_scan') {
  //   if (!cameraPermission?.granted) {
  //     return (
  //       <SafeAreaView style={styles.container}>
  //         <Text style={styles.body}>Camera permission required.</Text>
  //         <TouchableOpacity style={styles.btn} onPress={requestCameraPermission}>
  //           <Text style={styles.btnText}>Grant Permission</Text>
  //         </TouchableOpacity>
  //       </SafeAreaView>
  //     );
  //   }
  //   return (
  //     <View style={StyleSheet.absoluteFill}>
  //       <CameraView
  //         style={StyleSheet.absoluteFill}
  //         barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
  //         onBarcodeScanned={scanned ? undefined : handleMDNSScan}
  //       />
  //       <SafeAreaView style={styles.overlay}>
  //         <Text style={styles.scanHint}>Scan QR to get token for {selectedService?.name}</Text>
  //         <TouchableOpacity style={styles.btnSmall} onPress={() => setStep('mdns_list')}>
  //           <Text style={styles.btnText}>Back</Text>
  //         </TouchableOpacity>
  //       </SafeAreaView>
  //     </View>
  //   );
  // }

  return null;
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
  btnSecondary: { backgroundColor: '#333' },
  btnSmall: {
    backgroundColor: '#333', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20,
    marginTop: 16,
  },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  overlay: { position: 'absolute', bottom: 40, left: 0, right: 0, alignItems: 'center' },
  scanHint: { color: '#fff', fontSize: 16, textAlign: 'center', marginBottom: 12, backgroundColor: 'rgba(0,0,0,0.6)', padding: 8, borderRadius: 8 },
  listItem: { backgroundColor: '#1a1a1a', borderRadius: 10, padding: 16, marginBottom: 10, width: '100%' },
  listItemText: { color: '#fff', fontSize: 18 },
  listItemSub: { color: '#888', fontSize: 13, marginTop: 4 },
});
