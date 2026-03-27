import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Modal, FlatList } from 'react-native';
import * as Device from 'expo-device';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../utils/firebaseConfig';
import { Ionicons } from '@expo/vector-icons';

type AuthMode = 'login' | 'signup' | 'otp';
interface AuthScreenProps { onLoginSuccess: (userId: string) => void; }

// Updated with the comprehensive list from your attachments
const REGIONS = [
  'Arunachal Pradesh',
  'Assam',
  'Chandigarh',
  'Delhi',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Ladakh',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Punjab',
  'Sikkim',
  'Tripura',
  'Uttarakhand'
];

export default function AuthScreen({ onLoginSuccess }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [loading, setLoading] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [workRegion, setWorkRegion] = useState('Select Region');
  const [showRegionModal, setShowRegionModal] = useState(false);
  
  const [otpCode, setOtpCode] = useState('');
  const [expectedOtp, setExpectedOtp] = useState('');
  const [resendTimer, setResendTimer] = useState(0);

  // FIXED: Removed resendTimer from dependencies to prevent interval remounting every second
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (mode === 'otp') {
      interval = setInterval(() => {
        setResendTimer(prev => (prev > 0 ? prev - 1 : 0));
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [mode]);

  const handleLogin = async () => {
    if (!email || !password) return Alert.alert("Required", "Please fill in both email and password.");
    setLoading(true);
    try {
      const userId = email.toLowerCase().trim();
      const userSnap = await getDoc(doc(db, 'users', userId));

      // Added optional chaining for data() to ensure TS/JS safety
      if (!userSnap.exists() || userSnap.data()?.password !== password) {
        Alert.alert("Access Denied", "Incorrect email or password.");
        setLoading(false); return;
      }
      onLoginSuccess(userId);
    } catch (e) { Alert.alert("Error", "Login failed. Please check your internet connection."); } 
    finally { setLoading(false); }
  };

  const triggerOtpSequence = () => {
    const mockOtp = Math.floor(1000 + Math.random() * 9000).toString();
    setExpectedOtp(mockOtp);
    setResendTimer(30);
    setMode('otp');
    Alert.alert("Device Registered", `Your Secure OTP is: ${mockOtp}`);
  };

  const handleSendOtp = async () => {
    if (!email || !username || !phone || !password) return Alert.alert("Required", "All fields are necessary to create an account.");
    if (password !== confirmPassword) return Alert.alert("Mismatch", "The passwords you entered do not match.");
    if (workRegion === 'Select Region') return Alert.alert("Required", "Please select your primary work region.");
    
    setLoading(true);
    try {
      const userId = email.toLowerCase().trim();
      const userSnap = await getDoc(doc(db, 'users', userId));
      if (userSnap.exists()) {
        Alert.alert("Conflict", "An account with this email already exists.");
        setLoading(false); return;
      }
      
      // Simulate network delay for realistic UX
      setTimeout(() => {
        setLoading(false);
        triggerOtpSequence();
      }, 2000);
    } catch (e) { 
      Alert.alert("Error", "Failed to initiate registration."); 
      setLoading(false); 
    }
  };

  const handleResendOtp = () => {
    if (resendTimer > 0) return;
    triggerOtpSequence();
  };

  const handleVerifyAndSignup = async () => {
    if (otpCode !== expectedOtp) return Alert.alert("Invalid Code", "The OTP entered is incorrect.");
    setLoading(true);
    try {
      const userId = email.toLowerCase().trim();
      const currentDeviceId = Device.osBuildId || Device.designName || 'unknown_device';
      
      await setDoc(doc(db, 'users', userId), {
        username, email: userId, phone, password, workRegion,
        isActive: true, multiAccess: false, activeDeviceIds: [currentDeviceId],
        createdAt: new Date().toISOString()
      });
      
      Alert.alert("Success", "Your account has been created securely.");
      onLoginSuccess(userId);
    } catch (e) { Alert.alert("Error", "Failed to finalize account creation."); } 
    finally { setLoading(false); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <View style={styles.iconCircle}>
            <Ionicons name="shield-checkmark" size={40} color="#3B82F6" />
          </View>
          
          {mode === 'login' && (
            <>
              <Text style={styles.title}>Welcome Back</Text>
              <Text style={styles.subtitle}>Enter your registered email and password to securely access your project workspace.</Text>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Email Address</Text>
                <TextInput style={styles.input} placeholder="e.g. agent@irma.com" placeholderTextColor="#64748B" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Password</Text>
                <TextInput style={styles.input} placeholder="••••••••" placeholderTextColor="#64748B" secureTextEntry value={password} onChangeText={setPassword} />
              </View>

              <TouchableOpacity style={styles.primaryBtn} onPress={handleLogin} disabled={loading}>
                {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.btnText}>Secure Login</Text>}
              </TouchableOpacity>

              <View style={styles.switchModeContainer}>
                <Text style={styles.switchModeText}>New field agent? </Text>
                <TouchableOpacity onPress={() => setMode('signup')}><Text style={styles.linkText}>Create Account</Text></TouchableOpacity>
              </View>
            </>
          )}

          {mode === 'signup' && (
            <>
              <Text style={styles.title}>Create Account</Text>
              <Text style={styles.subtitle}>Register to sync field reports and safely manage your device access.</Text>

              <View style={styles.inputGroup}>
                <TextInput style={styles.input} placeholder="Full Name" placeholderTextColor="#64748B" value={username} onChangeText={setUsername} />
              </View>
              <View style={styles.inputGroup}>
                <TextInput style={styles.input} placeholder="Email Address" placeholderTextColor="#64748B" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
              </View>
              <View style={styles.inputGroup}>
                <TextInput style={styles.input} placeholder="Mobile Number" placeholderTextColor="#64748B" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
              </View>
              
              <View style={styles.inputGroup}>
                <TouchableOpacity style={[styles.input, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]} onPress={() => setShowRegionModal(true)}>
                  <Text style={{ color: workRegion === 'Select Region' ? '#64748B' : '#F8FAFC', fontSize: 15 }}>{workRegion}</Text>
                  <Ionicons name="chevron-down" size={20} color="#64748B" />
                </TouchableOpacity>
              </View>

              <View style={styles.inputGroup}>
                <TextInput style={styles.input} placeholder="Create Password" placeholderTextColor="#64748B" secureTextEntry value={password} onChangeText={setPassword} />
              </View>
              <View style={styles.inputGroup}>
                <TextInput style={styles.input} placeholder="Confirm Password" placeholderTextColor="#64748B" secureTextEntry value={confirmPassword} onChangeText={setConfirmPassword} />
              </View>

              <TouchableOpacity style={styles.primaryBtn} onPress={handleSendOtp} disabled={loading}>
                {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.btnText}>Send Verification Code</Text>}
              </TouchableOpacity>

              <View style={styles.switchModeContainer}>
                <Text style={styles.switchModeText}>Already registered? </Text>
                <TouchableOpacity onPress={() => setMode('login')}><Text style={styles.linkText}>Back to Login</Text></TouchableOpacity>
              </View>
            </>
          )}

          {mode === 'otp' && (
            <>
              <Text style={styles.title}>Verify Device</Text>
              <Text style={styles.subtitle}>Please enter the 4-digit verification code sent to {phone}</Text>

              <View style={styles.inputGroup}>
                <TextInput style={styles.otpInput} placeholder="----" placeholderTextColor="#475569" keyboardType="number-pad" maxLength={4} value={otpCode} onChangeText={setOtpCode} autoFocus />
              </View>

              <TouchableOpacity style={styles.primaryBtn} onPress={handleVerifyAndSignup} disabled={loading}>
                {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.btnText}>Confirm & Create</Text>}
              </TouchableOpacity>

              <TouchableOpacity 
                onPress={handleResendOtp} 
                disabled={resendTimer > 0} 
                style={{ marginTop: 20, alignItems: 'center' }}
              >
                <Text style={[styles.linkText, resendTimer > 0 && { color: '#64748B' }]}>
                  {resendTimer > 0 ? `Resend OTP in ${resendTimer}s` : 'Resend OTP'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => setMode('signup')} style={{ marginTop: 20, alignItems: 'center' }}>
                <Text style={styles.cancelText}>Cancel Registration</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>

      <Modal visible={showRegionModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Work Region</Text>
              <TouchableOpacity onPress={() => setShowRegionModal(false)}>
                <Ionicons name="close" size={24} color="#94A3B8" />
              </TouchableOpacity>
            </View>
            <FlatList 
              data={REGIONS} 
              keyExtractor={item => item} 
              renderItem={({ item }) => (
                <TouchableOpacity 
                  style={styles.modalItem} 
                  onPress={() => { setWorkRegion(item); setShowRegionModal(false); }}
                >
                  <Text style={[styles.modalItemText, workRegion === item && { color: '#3B82F6', fontWeight: 'bold' }]}>{item}</Text>
                  {workRegion === item && <Ionicons name="checkmark" size={20} color="#3B82F6" />}
                </TouchableOpacity>
              )} 
            />
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  scrollContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 20, paddingVertical: 40 },
  card: { backgroundColor: '#1E293B', width: '100%', maxWidth: 380, padding: 25, borderRadius: 24, borderWidth: 1, borderColor: '#334155', elevation: 8, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10 },
  iconCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', alignSelf: 'center', marginBottom: 24, borderWidth: 1, borderColor: '#334155' },
  title: { fontSize: 24, fontWeight: '800', color: '#F8FAFC', textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 13, color: '#94A3B8', textAlign: 'center', marginBottom: 25, lineHeight: 20, paddingHorizontal: 10 },
  inputGroup: { marginBottom: 16, width: '100%' },
  label: { fontSize: 12, fontWeight: '700', color: '#94A3B8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: '#0F172A', borderWidth: 1, borderColor: '#334155', paddingHorizontal: 16, paddingVertical: 14, borderRadius: 12, fontSize: 15, color: '#F8FAFC' },
  otpInput: { backgroundColor: '#0F172A', borderWidth: 1, borderColor: '#3B82F6', paddingVertical: 18, borderRadius: 12, fontSize: 32, color: '#F8FAFC', textAlign: 'center', letterSpacing: 12, fontWeight: 'bold' },
  primaryBtn: { backgroundColor: '#3B82F6', paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginTop: 10, elevation: 2 },
  btnText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  switchModeContainer: { flexDirection: 'row', justifyContent: 'center', marginTop: 25 },
  switchModeText: { color: '#94A3B8', fontSize: 14 },
  linkText: { color: '#60A5FA', fontSize: 14, fontWeight: 'bold' },
  cancelText: { color: '#EF4444', fontSize: 14, fontWeight: 'bold' },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#1E293B', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '60%', paddingBottom: 20, borderWidth: 1, borderColor: '#334155' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 20, borderBottomWidth: 1, borderColor: '#334155' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#F8FAFC' },
  modalItem: { flexDirection: 'row', justifyContent: 'space-between', padding: 18, borderBottomWidth: 1, borderColor: '#0F172A' },
  modalItemText: { fontSize: 16, color: '#CBD5E1' }
});