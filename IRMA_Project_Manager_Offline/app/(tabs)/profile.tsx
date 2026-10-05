import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Modal, FlatList, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../../utils/firebaseConfig';
import { wipeSecureDatabase } from '../../utils/dbManager';
import { useUserStore } from '../../store/userStore';
import { registerAndSavePushToken, sendTestNotification } from '../../utils/pushNotifications';

export default function ProfileTab() {
  const store = useUserStore();
  const sqlDb = SQLite.useSQLiteContext();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [userId, setUserId] = useState('');

  const [pushToken, setPushToken] = useState<string | null>(null);

  // Added uniqueUserId and made email state editable
  const [name, setName] = useState('');
  const [uniqueUserId, setUniqueUserId] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [isEditingEmail, setIsEditingEmail] = useState(false);

  // Password Change
  const [showPassModal, setShowPassModal] = useState(false);
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');

  // States List
  const [states, setStates] = useState<string[]>(['All States']);
  const [showStateModal, setShowStateModal] = useState(false);

  useEffect(() => {
    fetchUserData();
  }, []);

  const fetchUserData = async () => {
    try {
      const sessionStr = await SecureStore.getItemAsync('irma_device_auth_session');
      if (sessionStr) {
        const session = JSON.parse(sessionStr);
        setUserId(session.userId);

        const token = await registerAndSavePushToken(session.userId);
        if (token) setPushToken(token);

        const userRef = doc(db, 'users', session.userId);
        const snap = await getDoc(userRef);
        if (snap.exists()) {
          const data = snap.data();
          setName(data.fullName || data.username || ''); // Support updated naming convention
          setUniqueUserId(data.uniqueUserId || ''); // Fetches unique handle
          setEmail(data.email || '');
          setPhone(data.phone || '');
        }
      }

      const res = await sqlDb.getAllAsync<{ state: string }>("SELECT DISTINCT state FROM tenders WHERE state IS NOT NULL AND state != ''");
      setStates(['All States', ...res.map(r => r.state).sort()]);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleSavePhone = async () => {
    if (!phone || phone.length < 10) return Alert.alert("Invalid", "Please enter a valid contact number.");
    setSaving(true);
    try {
      await updateDoc(doc(db, 'users', userId), { phone });
      setIsEditingPhone(false);
      Alert.alert("Success", "Contact number updated securely.");
    } catch (e) {
      Alert.alert("Error", "Could not update phone number.");
    } finally {
      setSaving(false);
    }
  };

  // Dedicated save handler for editing the email address
  const handleSaveEmail = async () => {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) return Alert.alert("Invalid", "Please enter a valid email address.");

    setSaving(true);
    try {
      await updateDoc(doc(db, 'users', userId), { email: email.toLowerCase().trim() });
      setIsEditingEmail(false);
      Alert.alert("Success", "Email address updated securely.");
    } catch (e) {
      Alert.alert("Error", "Could not update email address.");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateWorkRegion = async (newState: string) => {
    store.updateProfile({ selectedState: newState });
    setShowStateModal(false);
    if (!userId) return;

    try {
      await updateDoc(doc(db, 'users', userId), { workRegion: newState });
    } catch (e) {
      console.error("Failed to sync work region to cloud", e);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPass || !newPass) return Alert.alert("Required", "All fields must be filled.");
    setSaving(true);
    try {
      const userRef = doc(db, 'users', userId);
      const snap = await getDoc(userRef);
      if (snap.exists() && snap.data().password === currentPass) {
        await updateDoc(userRef, { password: newPass });
        Alert.alert("Success", "Password updated successfully.");
        setShowPassModal(false);
        setCurrentPass(''); setNewPass('');
      } else {
        Alert.alert("Denied", "Current password is incorrect.");
      }
    } catch (e) {
      Alert.alert("Error", "Failed to change password.");
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = () => {
    Alert.alert("Logout Securely", "Keep your visit data secure by logging out of the app. \n\nNote: Just make sure you remember your password before logging out or contact @admin for support!", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Logout", style: "destructive", onPress: async () => {
          await wipeSecureDatabase();
          await SecureStore.deleteItemAsync('irma_device_auth_session');
          await Updates.reloadAsync();
        }
      }
    ]);
  };

  const handleTestNotification = async () => {
    if (!pushToken) {
      Alert.alert("No Alerts Yet!", "You'll get app update notification if needed you need to do so in the future.");
      return;
    }
    try {
      await sendTestNotification(pushToken);
      Alert.alert("No alerts!", "You'll get app update notification if needed to do so in the future.");
    } catch (e) {
      Alert.alert("Error", "Failed to send test notification.");
    }
  };

  if (loading) return <View style={styles.center}><ActivityIndicator size="large" color="#2563EB" /></View>;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingTop: 60, paddingBottom: 60 }}>
      <View style={styles.header}>
        <Text style={styles.title}>User Profile</Text>
        <TouchableOpacity
          style={styles.bellBtn}
          onPress={handleTestNotification}
        >
          <Ionicons name="notifications-outline" size={24} color="#1E293B" />
          <View style={styles.notificationBadge} />
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 }}>
          <Text style={styles.sectionLabel}>Identity Details</Text>
          <TouchableOpacity onPress={() => Alert.alert("Locked Fields", "Identity details are locked to your user profile. Please contact the administrator to change these details.")}>
            <Ionicons name="lock-closed" size={18} color="#94A3B8" />
          </TouchableOpacity>
        </View>

        <View style={{ marginBottom: 15 }}>
          <Text style={styles.subLabel}>Full Name</Text>
          <View style={styles.lockedBox}><Text style={styles.lockedText}>{name}</Text></View>
        </View>

        {/* Added Unique User ID inside locked fields */}
        <View style={{ marginBottom: 15 }}>
          <Text style={styles.subLabel}>Unique User ID</Text>
          <View style={styles.lockedBox}><Text style={styles.lockedText}>@{uniqueUserId}</Text></View>
        </View>

        <View style={{ marginBottom: 15 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
            <Text style={styles.subLabel}>Registered Email</Text>
            <TouchableOpacity onPress={() => isEditingEmail ? handleSaveEmail() : setIsEditingEmail(true)}>
              <Text style={{ color: '#2563EB', fontWeight: 'bold', fontSize: 12 }}>{isEditingEmail ? "SAVE" : "EDIT"}</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={[styles.inputBox, isEditingEmail ? { backgroundColor: '#FFF', borderColor: '#2563EB', borderWidth: 1 } : styles.lockedBox]}
            value={email}
            onChangeText={setEmail}
            editable={isEditingEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>

        <View style={{ marginBottom: 5 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
            <Text style={styles.subLabel}>Contact Number</Text>
            <TouchableOpacity onPress={() => isEditingPhone ? handleSavePhone() : setIsEditingPhone(true)}>
              <Text style={{ color: '#2563EB', fontWeight: 'bold', fontSize: 12 }}>{isEditingPhone ? "SAVE" : "EDIT"}</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={[styles.inputBox, isEditingPhone ? { backgroundColor: '#FFF', borderColor: '#2563EB', borderWidth: 1 } : styles.lockedBox]}
            value={phone}
            onChangeText={setPhone}
            editable={isEditingPhone}
            keyboardType="phone-pad"
          />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionLabel}>Work Region (Default Filter)</Text>
        <TouchableOpacity style={[styles.inputBox, { backgroundColor: '#FFF', borderColor: '#E2E8F0', borderWidth: 1 }]} onPress={() => setShowStateModal(true)}>
          <Text style={{ color: '#1E293B', fontSize: 16 }}>{store.selectedState}</Text>
          <Ionicons name="chevron-down" size={20} color="#64748B" />
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionLabel}>Security & Access</Text>

        <TouchableOpacity style={styles.actionRow} onPress={() => setShowPassModal(true)}>
          <Ionicons name="key" size={20} color="#475569" style={{ marginRight: 10 }} />
          <Text style={{ flex: 1, fontSize: 16, color: '#1E293B', fontWeight: '600' }}>Change Password</Text>
          <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.centeredLogoutBtn} onPress={handleLogout}>
        <Ionicons name="log-out" size={20} color="#EF4444" style={{ marginRight: 10 }} />
        <Text style={{ fontSize: 16, color: '#EF4444', fontWeight: 'bold' }}>Secure Logout</Text>
      </TouchableOpacity>
      <Text style={{ fontSize: 11, color: '#94A3B8', marginTop: 10, textAlign: 'center', paddingHorizontal: 20 }}>
        Keep your visit data secure by logging out of the app after use to prevent unwanted access.
      </Text>

      <Modal visible={showStateModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#1E293B' }}>Select Default State</Text>
              <TouchableOpacity onPress={() => setShowStateModal(false)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
            </View>
            <FlatList data={states} keyExtractor={i => i} renderItem={({ item }) => (
              <TouchableOpacity style={styles.modalItem} onPress={() => handleUpdateWorkRegion(item)}>
                <Text style={{ fontSize: 16, color: store.selectedState === item ? '#2563EB' : '#1E293B', fontWeight: store.selectedState === item ? 'bold' : 'normal' }}>{item}</Text>
                {store.selectedState === item && <Ionicons name="checkmark" size={20} color="#2563EB" />}
              </TouchableOpacity>
            )} />
          </View>
        </View>
      </Modal>

      <Modal visible={showPassModal} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ backgroundColor: '#FFF', padding: 25, borderRadius: 16, width: '85%' }}>
            <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 20 }}>Change Password</Text>

            <TextInput style={[styles.inputBox, { backgroundColor: '#F1F5F9', marginBottom: 15 }]} placeholder="Current Password" secureTextEntry value={currentPass} onChangeText={setCurrentPass} />
            <TextInput style={[styles.inputBox, { backgroundColor: '#F1F5F9', marginBottom: 20 }]} placeholder="New Password" secureTextEntry value={newPass} onChangeText={setNewPass} />

            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 15 }}>
              <TouchableOpacity onPress={() => setShowPassModal(false)} style={{ padding: 10 }}><Text style={{ color: '#64748B', fontWeight: 'bold' }}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={handleChangePassword} style={{ backgroundColor: '#2563EB', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}>
                {saving ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={{ color: '#FFF', fontWeight: 'bold' }}>Update</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 24, fontWeight: '900', color: '#1E293B' },

  bellBtn: { position: 'relative', padding: 5 },
  notificationBadge: { position: 'absolute', top: 5, right: 6, backgroundColor: '#EF4444', width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: '#F8FAFC' },

  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 16, marginBottom: 15, borderWidth: 1, borderColor: '#E2E8F0', elevation: 2 },
  sectionLabel: { fontSize: 14, fontWeight: '800', color: '#475569', textTransform: 'uppercase', marginBottom: 10 },
  subLabel: { fontSize: 12, fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5 },
  lockedBox: { backgroundColor: '#F1F5F9', paddingHorizontal: 15, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  lockedText: { color: '#64748B', fontSize: 16, fontWeight: '600' },
  inputBox: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 12, borderRadius: 10, fontSize: 16, color: '#1E293B' },
  actionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderColor: '#F1F5F9' },

  centeredLogoutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FEF2F2', paddingVertical: 15, borderRadius: 12, borderWidth: 1, borderColor: '#FECACA', marginTop: 10 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalItem: { flexDirection: 'row', justifyContent: 'space-between', padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9' }
});