import React, { useEffect, useState, useRef } from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, AppState, Animated, Easing } from 'react-native';
import * as Updates from 'expo-updates';
import { Ionicons } from '@expo/vector-icons';

type UpdateStep = 'hidden' | 'prompt' | 'downloading' | 'ready' | 'error';

export default function UpdateHandler() {
  const { isUpdatePending } = Updates.useUpdates();
  const [step, setStep] = useState<UpdateStep>('hidden');
  const [statusMsg, setStatusMsg] = useState('');
  
  const animatedValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active' && !__DEV__ && step === 'hidden') {
        handleUpdateCheck();
      }
    });
    
    if (!__DEV__) handleUpdateCheck();
    
    return () => subscription.remove();
  }, []);

  // If the app downloaded an update in the background organically
  useEffect(() => {
    if (isUpdatePending && step === 'hidden') {
      setStep('ready');
      setStatusMsg('A new update was downloaded in the background.');
    }
  }, [isUpdatePending]);

  const startProgressBar = () => {
    animatedValue.setValue(0);
    Animated.loop(
      Animated.timing(animatedValue, {
        toValue: 1,
        duration: 1500,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false, 
      })
    ).start();
  };

  const handleUpdateCheck = async () => {
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setStep('prompt');
        setStatusMsg('A new version of the app is available.');
      }
    } catch (error) {
      console.log("Update check failed quietly:", error);
      // Fail silently for checks so we don't bother the user with network errors
    }
  };

  const executeDownload = async () => {
    setStep('downloading');
    setStatusMsg('Downloading latest payload...');
    startProgressBar();
    
    try {
      await Updates.fetchUpdateAsync();
      animatedValue.stopAnimation();
      setStep('ready');
      setStatusMsg('Update ready to install.');
    } catch (error) {
      animatedValue.stopAnimation();
      setStep('error');
      setStatusMsg('Failed to download the update. Please check your network.');
    }
  };

  const handleDismiss = () => {
    setStep('hidden');
  };

  if (step === 'hidden') return null;

  const progressInterpolation = animatedValue.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['0%', '70%', '100%']
  });

  return (
    <Modal visible={step !== 'hidden'} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.alertBox}>
          
          <Ionicons 
            name={step === 'error' ? "warning" : (step === 'ready' ? "checkmark-circle" : "cloud-download")} 
            size={56} 
            color={step === 'error' ? "#EF4444" : "#3B82F6"} 
            style={styles.icon} 
          />
          
          <Text style={styles.title}>
            {step === 'prompt' ? 'Update Available' : 
             step === 'error' ? 'Update Failed' : 
             step === 'ready' ? 'System Updated' : 'Updating...'}
          </Text>
          
          <Text style={styles.message}>{statusMsg}</Text>

          {step === 'downloading' && (
             <View style={styles.progressBarBg}>
               <Animated.View style={[styles.progressBarFill, { width: progressInterpolation, opacity: animatedValue.interpolate({ inputRange: [0, 0.8, 1], outputRange: [1, 1, 0] }) }]} />
             </View>
          )}

          {/* Action Buttons based on state */}
          <View style={styles.buttonRow}>
            {(step === 'prompt' || step === 'error' || step === 'ready') && (
              <TouchableOpacity style={styles.buttonCancel} onPress={handleDismiss}>
                <Text style={styles.buttonTextCancel}>
                  {step === 'ready' ? 'Later' : 'Not Now'}
                </Text>
              </TouchableOpacity>
            )}

            {step === 'prompt' && (
              <TouchableOpacity style={styles.buttonPrimary} onPress={executeDownload}>
                <Text style={styles.buttonTextPrimary}>Update Now</Text>
              </TouchableOpacity>
            )}

            {step === 'ready' && (
              <TouchableOpacity style={styles.buttonPrimary} onPress={() => Updates.reloadAsync()}>
                <Ionicons name="refresh" size={18} color="#FFF" style={{ marginRight: 8 }} />
                <Text style={styles.buttonTextPrimary}>Restart</Text>
              </TouchableOpacity>
            )}

            {step === 'error' && (
              <TouchableOpacity style={styles.buttonPrimary} onPress={executeDownload}>
                <Text style={styles.buttonTextPrimary}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>

        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  alertBox: { width: '100%', maxWidth: 400, backgroundColor: '#1E293B', padding: 30, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  icon: { marginBottom: 15 },
  title: { fontSize: 20, fontWeight: 'bold', color: '#FFF', marginBottom: 10, textAlign: 'center' },
  message: { fontSize: 14, color: '#94A3B8', textAlign: 'center', marginBottom: 25, lineHeight: 20, paddingHorizontal: 10 },
  progressBarBg: { width: '100%', height: 6, backgroundColor: '#334155', borderRadius: 3, overflow: 'hidden', marginBottom: 10 },
  progressBarFill: { height: '100%', backgroundColor: '#3B82F6', borderRadius: 3 },
  
  buttonRow: { flexDirection: 'row', width: '100%', gap: 10 },
  buttonPrimary: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#3B82F6', paddingVertical: 14, borderRadius: 8, justifyContent: 'center' },
  buttonCancel: { flex: 1, backgroundColor: 'transparent', borderWidth: 1, borderColor: '#475569', paddingVertical: 14, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  
  buttonTextPrimary: { color: '#FFF', fontWeight: 'bold', fontSize: 15 },
  buttonTextCancel: { color: '#94A3B8', fontWeight: 'bold', fontSize: 15 },
});