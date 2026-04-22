import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { useStore } from './src/store';
import PairScreen from './src/screens/Pair';
import WhipScreen from './src/screens/Whip';
import SettingsScreen from './src/screens/Settings';


const Tab = createBottomTabNavigator();

export default function App() {
  const { loadPersistedData, pairInfo, wsClient, setConnectionState } = useStore();

  useEffect(() => {
    loadPersistedData().then(() => {
      const { pairInfo: info } = useStore.getState();
      if (info) wsClient.connect({ ...info, deviceName: 'OpenWhipMax Phone' });
    });
  }, []);

  useEffect(() => {
    return wsClient.on((evt) => {
      if (evt.kind === 'state') setConnectionState(evt.state);
    });
  }, [wsClient, setConnectionState]);

  return (
    <NavigationContainer
      theme={{
        dark: true,
        colors: {
          background: '#0d0d0d', card: '#111', text: '#fff',
          border: '#222', primary: '#e74c3c', notification: '#e74c3c',
        },
        fonts: {
          regular: { fontFamily: 'System', fontWeight: '400' },
          medium: { fontFamily: 'System', fontWeight: '500' },
          bold: { fontFamily: 'System', fontWeight: '700' },
          heavy: { fontFamily: 'System', fontWeight: '900' },
        },
      }}
    >
      <StatusBar style="light" />
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: { backgroundColor: '#111', borderTopColor: '#222' },
          tabBarActiveTintColor: '#e74c3c',
          tabBarInactiveTintColor: '#666',
        }}
      >
        <Tab.Screen
          name="Pair"
          component={PairScreen}
          options={{
            tabBarButton: pairInfo ? () => null : undefined,
            tabBarIcon: () => <Text style={{ fontSize: 18 }}>🤝</Text>
          }}
        />
        <Tab.Screen
          name="Whip"
          component={WhipScreen}
          options={{ tabBarIcon: () => <Text style={{ fontSize: 18 }}>🪃</Text> }}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ tabBarIcon: () => <Text style={{ fontSize: 18 }}>⚙️</Text> }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
