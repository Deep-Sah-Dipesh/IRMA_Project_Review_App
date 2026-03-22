import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';

export default function DashboardTab() {
  const router = useRouter();
  const db = SQLite.useSQLiteContext();
  const [loading, setLoading] = useState(true);
  const [recentProjects, setRecentProjects] = useState<any[]>([]);

  useFocusEffect(
    useCallback(() => {
      let isMounted = true;
      loadRecentProjects(isMounted);
      return () => { isMounted = false; };
    }, [])
  );

  const loadRecentProjects = async (isMounted: boolean) => {
    setLoading(true);
    try {
      const baseUri = `${FileSystem.documentDirectory}projects/`;
      const dirInfo = await FileSystem.getInfoAsync(baseUri);
      
      if (!dirInfo.exists) {
        if (isMounted) { setRecentProjects([]); setLoading(false); }
        return;
      }

      // Read all folder names (Format: projectId_tenderId)
      const activeFolders = await FileSystem.readDirectoryAsync(baseUri);
      if (activeFolders.length === 0) {
        if (isMounted) { setRecentProjects([]); setLoading(false); }
        return;
      }

      const allTenders = await db.getAllAsync("SELECT * FROM tenders") as any[];
      const activeTenders = allTenders.filter(t => {
         const expectedFolder = `${t.project_id}_${t.tender_id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
         return activeFolders.includes(expectedFolder);
      });

      if (isMounted) setRecentProjects(activeTenders);
    } catch (e) {
      console.error(e);
    } finally {
      if (isMounted) setLoading(false);
    }
  };

  const renderItem = ({ item }: { item: any }) => (
    <TouchableOpacity 
      style={styles.card} 
      activeOpacity={0.7} 
      onPress={() => router.push(`/project/${encodeURIComponent(item.project_id)}?tender_id=${encodeURIComponent(item.tender_id)}`)}
    >
      <View style={styles.cardHeader}>
        <Ionicons name="folder-open" size={20} color="#2563EB" style={{marginRight: 8}} />
        <Text style={styles.cardId}>{item.project_id}</Text>
      </View>
      <Text style={styles.cardTitle}>{item.project_title}</Text>
      <Text style={styles.cardMeta}>{item.ulb}, {item.state}</Text>
    </TouchableOpacity>
  );

  if (loading) {
    return <View style={styles.centerLoading}><ActivityIndicator size="large" color="#2563EB" /><Text style={{marginTop: 10, color: '#64748B'}}>Scanning local workspace...</Text></View>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Recent Activity</Text>
        <Text style={styles.subtitle}>Projects containing offline visits and saved files</Text>
      </View>
      <FlatList 
        data={recentProjects}
        keyExtractor={(item, idx) => `${item.project_id}_${idx}`}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 15 }}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Ionicons name="documents-outline" size={64} color="#CBD5E1" />
            <Text style={styles.emptyText}>No Active Projects</Text>
            <Text style={styles.emptySubText}>Visit the Projects tab and create reports to see them here.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  centerLoading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  title: { fontSize: 24, fontWeight: '900', color: '#1E293B' },
  subtitle: { fontSize: 13, color: '#64748B', marginTop: 4 },
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0', borderLeftWidth: 4, borderLeftColor: '#2563EB', elevation: 1 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  cardId: { color: '#1E293B', fontWeight: 'bold', fontSize: 14 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#334155', marginBottom: 6 },
  cardMeta: { fontSize: 12, color: '#64748B', fontWeight: '500' },
  emptyBox: { alignItems: 'center', marginTop: 80 },
  emptyText: { fontSize: 18, fontWeight: 'bold', color: '#475569', marginTop: 15 },
  emptySubText: { fontSize: 14, color: '#94A3B8', textAlign: 'center', marginTop: 8, paddingHorizontal: 20 }
});