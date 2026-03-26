import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Modal, FlatList, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SQLite from 'expo-sqlite';
import { useUserStore } from '../../store/userStore';

export default function ProfileTab() {
  const store = useUserStore();
  const db = SQLite.useSQLiteContext();
  const systemTheme = useColorScheme();
  
  const isDark = store.theme === 'dark' || (store.theme === 'system' && systemTheme === 'dark');
  const baseStyle = { backgroundColor: isDark ? '#0F172A' : '#F8FAFC', color: isDark ? '#F8FAFC' : '#1E293B' };
  
  const [isEditing, setIsEditing] = useState(false);
  const [tempData, setTempData] = useState({ name: store.name, email: store.email, phone: store.phone });
  const [states, setStates] = useState<string[]>(['All States']);
  const [showStateModal, setShowStateModal] = useState(false);

  useEffect(() => {
    const fetchStates = async () => {
      try {
        const res = await db.getAllAsync<{state: string}>("SELECT DISTINCT state FROM tenders WHERE state IS NOT NULL AND state != ''");
        setStates(['All States', ...res.map(r => r.state).sort()]);
      } catch (e) {}
    };
    fetchStates();
  }, []);

  const handleSave = () => {
    store.updateProfile(tempData);
    setIsEditing(false);
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: baseStyle.backgroundColor }]} contentContainerStyle={{ padding: 20, paddingTop: 60 }}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: baseStyle.color, fontSize: 24 * store.fontScale }]}>User Profile</Text>
        <TouchableOpacity onPress={() => isEditing ? handleSave() : setIsEditing(true)}>
          <Ionicons name={isEditing ? "checkmark-circle" : "pencil"} size={28} color="#2563EB" />
        </TouchableOpacity>
      </View>

      <View style={[styles.card, { backgroundColor: isDark ? '#1E293B' : '#FFF', borderColor: isDark ? '#334155' : '#E2E8F0' }]}>
        <Text style={styles.sectionLabel}>Personal Details</Text>
        <InputField label="Full Name" value={isEditing ? tempData.name : store.name} onChange={(t) => setTempData({...tempData, name: t})} editable={isEditing} isDark={isDark} scale={store.fontScale} />
        <InputField label="Email Address" value={isEditing ? tempData.email : store.email} onChange={(t) => setTempData({...tempData, email: t})} editable={isEditing} isDark={isDark} scale={store.fontScale} />
        <InputField label="Contact Number" value={isEditing ? tempData.phone : store.phone} onChange={(t) => setTempData({...tempData, phone: t})} editable={isEditing} isDark={isDark} scale={store.fontScale} />
      </View>

      <View style={[styles.card, { backgroundColor: isDark ? '#1E293B' : '#FFF', borderColor: isDark ? '#334155' : '#E2E8F0' }]}>
        <Text style={styles.sectionLabel}>Work Region (Default Filter)</Text>
        <TouchableOpacity style={[styles.inputBox, { backgroundColor: isDark ? '#0F172A' : '#F1F5F9' }]} onPress={() => setShowStateModal(true)}>
          <Text style={{ color: baseStyle.color, fontSize: 16 * store.fontScale }}>{store.selectedState}</Text>
          <Ionicons name="chevron-down" size={20} color="#64748B" />
        </TouchableOpacity>
      </View>

      <View style={[styles.card, { backgroundColor: isDark ? '#1E293B' : '#FFF', borderColor: isDark ? '#334155' : '#E2E8F0' }]}>
        <Text style={styles.sectionLabel}>App Preferences</Text>
        
        <Text style={[styles.subLabel, { color: isDark ? '#94A3B8' : '#64748B', fontSize: 12 * store.fontScale }]}>Theme</Text>
        <View style={styles.btnGroup}>
          <ToggleBtn label="System" active={store.theme === 'system'} onPress={() => store.setTheme('system')} isDark={isDark} scale={store.fontScale} />
          <ToggleBtn label="Light" active={store.theme === 'light'} onPress={() => store.setTheme('light')} isDark={isDark} scale={store.fontScale} />
          <ToggleBtn label="Dark" active={store.theme === 'dark'} onPress={() => store.setTheme('dark')} isDark={isDark} scale={store.fontScale} />
        </View>

        <Text style={[styles.subLabel, { color: isDark ? '#94A3B8' : '#64748B', fontSize: 12 * store.fontScale, marginTop: 15 }]}>Font Size ({Math.round(store.fontScale * 100)}%)</Text>
        <View style={styles.btnGroup}>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: isDark ? '#334155' : '#E2E8F0' }]} onPress={() => store.setFontScale(store.fontScale - 0.1)}>
            <Ionicons name="remove" size={24} color={baseStyle.color} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: isDark ? '#334155' : '#E2E8F0' }]} onPress={() => store.setFontScale(1.0)}>
            <Text style={{ color: baseStyle.color, fontWeight: 'bold' }}>Reset</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionBtn, { backgroundColor: isDark ? '#334155' : '#E2E8F0' }]} onPress={() => store.setFontScale(store.fontScale + 0.1)}>
            <Ionicons name="add" size={24} color={baseStyle.color} />
          </TouchableOpacity>
        </View>
      </View>

      <Modal visible={showStateModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: isDark ? '#1E293B' : '#FFF' }]}>
            <View style={styles.modalHeader}>
              <Text style={{ fontSize: 18 * store.fontScale, fontWeight: 'bold', color: baseStyle.color }}>Select Default State</Text>
              <TouchableOpacity onPress={() => setShowStateModal(false)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
            </View>
            <FlatList data={states} keyExtractor={i => i} renderItem={({item}) => (
              <TouchableOpacity style={styles.modalItem} onPress={() => { store.updateProfile({ selectedState: item }); setShowStateModal(false); }}>
                <Text style={{ fontSize: 16 * store.fontScale, color: store.selectedState === item ? '#2563EB' : baseStyle.color, fontWeight: store.selectedState === item ? 'bold' : 'normal' }}>{item}</Text>
                {store.selectedState === item && <Ionicons name="checkmark" size={20} color="#2563EB" />}
              </TouchableOpacity>
            )} />
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const InputField = ({ label, value, onChange, editable, isDark, scale }: any) => (
  <View style={{ marginBottom: 15 }}>
    <Text style={[styles.subLabel, { color: isDark ? '#94A3B8' : '#64748B', fontSize: 12 * scale }]}>{label}</Text>
    <TextInput style={[styles.inputBox, { backgroundColor: editable ? (isDark ? '#0F172A' : '#F1F5F9') : 'transparent', color: isDark ? '#F8FAFC' : '#1E293B', fontSize: 16 * scale, borderWidth: editable ? 1 : 0, borderColor: isDark ? '#334155' : '#CBD5E1', paddingHorizontal: editable ? 15 : 0 }]} value={value} onChangeText={onChange} editable={editable} placeholder={`Enter ${label}`} placeholderTextColor="#94A3B8" />
  </View>
);

const ToggleBtn = ({ label, active, onPress, isDark, scale }: any) => (
  <TouchableOpacity style={[styles.toggleBtn, active ? { backgroundColor: '#2563EB', borderColor: '#2563EB' } : { backgroundColor: isDark ? '#0F172A' : '#F1F5F9', borderColor: isDark ? '#334155' : '#E2E8F0' }]} onPress={onPress}>
    <Text style={{ color: active ? '#FFF' : (isDark ? '#F8FAFC' : '#475569'), fontWeight: active ? 'bold' : '600', fontSize: 14 * scale }}>{label}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontWeight: '900' },
  card: { padding: 20, borderRadius: 16, marginBottom: 15, borderWidth: 1 },
  sectionLabel: { fontSize: 16, fontWeight: '800', color: '#2563EB', marginBottom: 15, textTransform: 'uppercase' },
  subLabel: { fontWeight: '700', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 },
  inputBox: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
  btnGroup: { flexDirection: 'row', gap: 10 },
  toggleBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8, borderWidth: 1 },
  actionBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalItem: { flexDirection: 'row', justifyContent: 'space-between', padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9' }
});