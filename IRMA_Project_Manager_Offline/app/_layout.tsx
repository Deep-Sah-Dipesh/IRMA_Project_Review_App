import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, TextInput, StyleSheet, Alert, KeyboardAvoidingView, Platform, Animated } from 'react-native';
import { Stack } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import * as SplashScreen from 'expo-splash-screen';
import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import { Ionicons } from '@expo/vector-icons';
import { syncStaticData } from '../utils/dbMigrator';

SplashScreen.preventAutoHideAsync();

const AUTH_KEY = 'irma_device_auth_session';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const MigrationLoadingScreen = () => {
  const [progress] = useState(new Animated.Value(0));

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(progress, { toValue: 1, duration: 2000, useNativeDriver: false }),
        Animated.timing(progress, { toValue: 0, duration: 0, useNativeDriver: false })
      ])
    ).start();
  }, []);

  const widthInterpolated = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={styles.migrationContainer}>
      <View style={styles.migrationBox}>
        <Ionicons name="server" size={56} color="#3B82F6" style={{ marginBottom: 15 }} />
        <Text style={styles.migrationTitle}>Importing Database</Text>
        <Text style={styles.migrationSub}>Please wait while the database is being signed digitally and set up locally to your device.</Text>
        
        <View style={styles.migrationProgressBarBg}>
          <Animated.View style={[styles.migrationProgressBarFill, { width: widthInterpolated }]} />
        </View>
      </View>
    </View>
  );
};

export default function RootLayout() {
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isVerified, setIsVerified] = useState(false);
  
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    const verifyDeviceSession = async () => {
      try {
        const sessionData = await SecureStore.getItemAsync(AUTH_KEY);
        if (sessionData) {
          const { timestamp, deviceId } = JSON.parse(sessionData);
          const currentDeviceId = Device.osBuildId || Device.designName || 'unknown_device';
          if (Date.now() - timestamp < SEVEN_DAYS_MS && deviceId === currentDeviceId) {
            setIsVerified(true);
          }
        }
      } catch (e) {
        console.error(e);
      } finally {
        setIsCheckingAuth(false);
        await SplashScreen.hideAsync();
      }
    };
    verifyDeviceSession();
  }, []);

  const handleSendOTP = async () => {
    if (phoneNumber.length < 10) return Alert.alert("Invalid Number", "Enter a valid 10-digit mobile number.");
    setIsAuthenticating(true);
    setTimeout(() => { 
      setIsAuthenticating(false); 
      setStep('otp'); 
    }, 1000);
  };

  const handleVerifyOTP = async () => {
    if (otpCode !== '123456') return Alert.alert("Invalid OTP", "Please enter 123456 for the demo.");
    setIsAuthenticating(true);

    setTimeout(async () => {
      try {
        const deviceId = Device.osBuildId || Device.designName || 'unknown_device';
        const sessionPayload = JSON.stringify({ phone: phoneNumber, deviceId, timestamp: Date.now() });
        await SecureStore.setItemAsync(AUTH_KEY, sessionPayload);
        setIsVerified(true);
      } catch (e) {
        Alert.alert("Verification Failed");
      } finally {
        setIsAuthenticating(false);
      }
    }, 800);
  };

  if (isCheckingAuth) return null;

  if (!isVerified) {
    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.authContainer}>
        <View style={styles.authBox}>
          <Ionicons name="shield-checkmark" size={64} color="#2563EB" style={{ marginBottom: 20 }} />
          <Text style={styles.authTitle}>Device Verification</Text>
          <Text style={styles.authSub}>Access expires every 7 days. Verify your number to bind this device securely.</Text>

          {step === 'phone' ? (
            <View style={{ width: '100%' }}>
              <TextInput style={styles.input} placeholder="Mobile Number (+91)" keyboardType="phone-pad" value={phoneNumber} onChangeText={setPhoneNumber} maxLength={10} />
              <TouchableOpacity style={styles.authBtn} onPress={handleSendOTP} disabled={isAuthenticating}>
                {isAuthenticating ? <ActivityIndicator color="#FFF" /> : <Text style={styles.authBtnText}>Send Secure OTP</Text>}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ width: '100%' }}>
              <View style={styles.demoInstructionBox}>
                 <Text style={styles.demoInstructionText}>[ DEMO MODE: ENTER 123456 ]</Text>
              </View>
              <TextInput style={styles.input} placeholder="Enter OTP (123456)" keyboardType="number-pad" value={otpCode} onChangeText={setOtpCode} maxLength={6} autoFocus />
              <TouchableOpacity style={styles.authBtn} onPress={handleVerifyOTP} disabled={isAuthenticating}>
                {isAuthenticating ? <ActivityIndicator color="#FFF" /> : <Text style={styles.authBtnText}>Verify & Bind Device</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setStep('phone')} style={{ marginTop: 15, alignItems: 'center' }}>
                <Text style={{ color: '#64748B', fontWeight: 'bold' }}>Change Number</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    );
  }

  // Database mounts here, strictly showing the fallback spinner during migration
  return (
    <SQLite.SQLiteProvider databaseName="civil_projects.db" onInit={syncStaticData} fallback={<MigrationLoadingScreen />}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="project/[id]" options={{ presentation: 'card' }} />
      </Stack>
    </SQLite.SQLiteProvider>
  );
}

const styles = StyleSheet.create({
  authContainer: { flex: 1, backgroundColor: '#1E293B', justifyContent: 'center', alignItems: 'center', padding: 20 },
  authBox: { backgroundColor: '#FFF', padding: 30, borderRadius: 20, width: '100%', maxWidth: 400, alignItems: 'center', elevation: 10 },
  authTitle: { fontSize: 24, fontWeight: '900', color: '#0F172A', marginBottom: 10 },
  authSub: { fontSize: 13, color: '#64748B', textAlign: 'center', marginBottom: 30, lineHeight: 20 },
  input: { backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: '#CBD5E1', padding: 15, borderRadius: 12, fontSize: 16, marginBottom: 20, width: '100%', textAlign: 'center', letterSpacing: 2 },
  authBtn: { backgroundColor: '#2563EB', padding: 16, borderRadius: 12, width: '100%', alignItems: 'center' },
  authBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 },
  demoInstructionBox: { backgroundColor: '#FEF2F2', padding: 10, borderRadius: 8, marginBottom: 15, borderWidth: 1, borderColor: '#FECACA' },
  demoInstructionText: { color: '#EF4444', fontWeight: '900', textAlign: 'center', fontSize: 12 },
  
  migrationContainer: { flex: 1, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', padding: 20 },
  migrationBox: { backgroundColor: '#1E293B', padding: 30, borderRadius: 16, alignItems: 'center', width: '100%', maxWidth: 400, borderWidth: 1, borderColor: '#334155' },
  migrationTitle: { fontSize: 20, fontWeight: 'bold', color: '#FFF', marginBottom: 10 },
  migrationSub: { fontSize: 13, color: '#94A3B8', textAlign: 'center', marginBottom: 30, lineHeight: 20 },
  migrationProgressBarBg: { width: '100%', height: 6, backgroundColor: '#334155', borderRadius: 3, overflow: 'hidden' },
  migrationProgressBarFill: { height: '100%', backgroundColor: '#3B82F6', borderRadius: 3 }
});