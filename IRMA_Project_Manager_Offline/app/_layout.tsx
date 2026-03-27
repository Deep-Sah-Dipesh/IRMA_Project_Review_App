import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, Alert, StyleSheet, TouchableOpacity } from 'react-native';
import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import * as SplashScreen from 'expo-splash-screen';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { Ionicons } from '@expo/vector-icons';

import { downloadAndInitDatabase, wipeSecureDatabase, DB_NAME } from '../utils/dbManager';
import { verifyUserAccess, registerDeviceToUser } from '../utils/accessManager';
import AuthScreen from '../components/AuthScreen';
import UpdateHandler from '../components/UpdateHandler';

SplashScreen.preventAutoHideAsync();

const AUTH_KEY = 'irma_device_auth_session';

// UI adapted to handle both Progress and Error/Retry states
const DatabaseLoadingScreen = ({ progress, hasError, onRetry }: { progress: number, hasError: boolean, onRetry: () => void }) => (
  <View style={styles.migrationContainer}>
    <View style={styles.migrationBox}>
      <Ionicons name={hasError ? "warning" : "server"} size={56} color={hasError ? "#EF4444" : "#3B82F6"} style={{ marginBottom: 15 }} />
      <Text style={styles.migrationTitle}>
        {hasError ? 'Sync Failed' : (progress === 1 ? 'Ready to Go!' : 'Syncing Database')}
      </Text>
      <Text style={styles.migrationSub}>
        {hasError 
          ? 'Network interrupted or unable to fetch the secure payload from the cloud.' 
          : 'Please wait while the latest secure database is downloaded to your device sandbox.'}
      </Text>
      
      {!hasError ? (
        <>
          <View style={styles.migrationProgressBarBg}>
            <View style={[styles.migrationProgressBarFill, { width: `${progress * 100}%` }]} />
          </View>
          <Text style={{ color: '#64748B', fontSize: 12, marginTop: 10, fontWeight: '600' }}>
            {(progress * 100).toFixed(0)}% Completed
          </Text>
        </>
      ) : (
        <TouchableOpacity style={styles.retryBtn} onPress={onRetry}>
          <Ionicons name="refresh" size={18} color="#FFF" style={{ marginRight: 6 }} />
          <Text style={styles.retryBtnText}>Retry Sync</Text>
        </TouchableOpacity>
      )}
    </View>
  </View>
);

export default function RootLayout() {
  const [isAuth, setIsAuth] = useState<boolean | null>(null);
  const [isDbReady, setIsDbReady] = useState(false);
  const [dbError, setDbError] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  useEffect(() => { checkAuthAndInitDB(); }, []);

  const triggerLogoutAndWipe = async (message: string) => {
    await wipeSecureDatabase(); 
    await SecureStore.deleteItemAsync(AUTH_KEY);
    setIsAuth(false);
    setIsDbReady(false);
    Alert.alert("Access Revoked", message);
  };

  const checkAuthAndInitDB = async () => {
    try {
      const sessionStr = await SecureStore.getItemAsync(AUTH_KEY);
      const currentDeviceId = Device.osBuildId || Device.designName || 'unknown_device';

      if (sessionStr) {
        const session = JSON.parse(sessionStr);
        if (!session.userId) {
          await SecureStore.deleteItemAsync(AUTH_KEY);
          setIsAuth(false);
          await SplashScreen.hideAsync();
          return;
        }

        const accessStatus = await verifyUserAccess(session.userId, currentDeviceId);

        if (accessStatus === 'inactive') return triggerLogoutAndWipe("Account deactivated by administrator.");
        if (accessStatus === 'device_mismatch') return triggerLogoutAndWipe("Session Expired: You logged into another device.");

        if (accessStatus === 'allowed') {
          setIsAuth(true);
          await initDB();
          return;
        }
      }
      setIsAuth(false);
      await SplashScreen.hideAsync();
    } catch (e) { 
      setIsAuth(false); 
      await SplashScreen.hideAsync();
    }
  };

  const initDB = async () => {
    setDbError(false);
    setDownloadProgress(0);
    
    // Will attempt 3 background retries automatically via dbManager
    const success = await downloadAndInitDatabase(setDownloadProgress);
    
    if (success) {
      setIsDbReady(true);
      await SplashScreen.hideAsync();
    } else { 
      setDbError(true); 
    }
  };

  const handleLoginSuccess = async (userId: string) => {
    const currentDeviceId = Device.osBuildId || Device.designName || 'unknown_device';
    const accessStatus = await verifyUserAccess(userId, currentDeviceId);

    if (accessStatus === 'inactive') return Alert.alert('Denied', 'Account is inactive. Contact Admin @Deep_Sah_Dipesh.');

    if (accessStatus === 'device_mismatch') {
      Alert.alert(
        "Device Access Warning",
        "Logging into this device will revoke access on your previous device.\n\nFor multi-device access, contact admin @Deep_Sah_Dipesh.",
        [
          { text: "Cancel", style: "cancel" },
          { 
            text: "Proceed", style: "destructive",
            onPress: async () => {
              await registerDeviceToUser(userId, currentDeviceId);
              await finalizeLogin(userId, currentDeviceId);
            }
          }
        ]
      );
      return;
    }

    if (accessStatus === 'allowed' || accessStatus === 'not_found') {
      await registerDeviceToUser(userId, currentDeviceId);
      await finalizeLogin(userId, currentDeviceId);
    }
  };

  const finalizeLogin = async (userId: string, deviceId: string) => {
    await SecureStore.setItemAsync(AUTH_KEY, JSON.stringify({ userId, deviceId, timestamp: Date.now() }));
    setIsAuth(true);
    await initDB();
  };

  // Render Logic
  let mainContent = null;

  if (isAuth === null) {
    mainContent = null;
  } else if (!isAuth) {
    mainContent = <AuthScreen onLoginSuccess={handleLoginSuccess} />; 
  } else if (!isDbReady) {
    mainContent = <DatabaseLoadingScreen progress={downloadProgress} hasError={dbError} onRetry={initDB} />;
  } else {
    mainContent = (
      <SQLiteProvider databaseName={DB_NAME}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="project/[id]" options={{ presentation: 'card' }} />
        </Stack>
      </SQLiteProvider>
    );
  }

  // Mounts the UpdateHandler at the root level so it overlays everything,
  // including AuthScreen and DatabaseLoadingScreen.
  return (
    <>
      <UpdateHandler />
      {mainContent}
    </>
  );
}

const styles = StyleSheet.create({
  migrationContainer: { flex: 1, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', padding: 20 },
  migrationBox: { backgroundColor: '#1E293B', padding: 30, borderRadius: 16, alignItems: 'center', width: '100%', maxWidth: 400, borderWidth: 1, borderColor: '#334155' },
  migrationTitle: { fontSize: 20, fontWeight: 'bold', color: '#FFF', marginBottom: 10 },
  migrationSub: { fontSize: 13, color: '#94A3B8', textAlign: 'center', marginBottom: 20, lineHeight: 20 },
  migrationProgressBarBg: { width: '100%', height: 6, backgroundColor: '#334155', borderRadius: 3, overflow: 'hidden' },
  migrationProgressBarFill: { height: '100%', backgroundColor: '#3B82F6', borderRadius: 3 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#3B82F6', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8, marginTop: 10 },
  retryBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 }
});