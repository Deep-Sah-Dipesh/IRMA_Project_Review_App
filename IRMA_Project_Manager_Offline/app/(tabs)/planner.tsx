import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, FlatList, TextInput, StyleSheet } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUserStore } from '../../store/userStore';

export default function PlannerTab() {
  const store = useUserStore();
  const db = SQLite.useSQLiteContext();
  const router = useRouter();
  
  const [activeTab, setActiveTab] = useState<'pending' | 'planning'>('pending');
  const [search, setSearch] = useState('');
  const [district, setDistrict] = useState('');
  const [ulbs, setUlbs] = useState<{name: string, count: number}[]>([]);
  const [expandedUlb, setExpandedUlb] = useState<string | null>(null);
  const [ulbProjects, setUlbProjects] = useState<any[]>([]);
  const [visitedSet, setVisitedSet] = useState<Set<string>>(new Set());

  // Scan for visited projects to auto-hide them from To-Do
  useEffect(() => {
    const scanVisited = async () => {
      try {
        const baseDir = FileSystem.documentDirectory + 'projects/';
        const folders = await FileSystem.readDirectoryAsync(baseDir).catch(() => []);
        setVisitedSet(new Set(folders));
      } catch(e) {}
    };
    scanVisited();
  }, [activeTab]);

  // Load ULBs for the selected state
  useEffect(() => {
    const loadUlbs = async () => {
      let query = "SELECT ulb, COUNT(*) as cnt FROM tenders WHERE ulb IS NOT NULL AND ulb != ''";
      let params: string[] = [];
      if (store.selectedState && store.selectedState !== 'All States') {
        query += " AND state = ?"; params.push(store.selectedState);
      }
      if (district) {
        query += " AND district = ?"; params.push(district);
      }
      query += " GROUP BY ulb ORDER BY ulb ASC";
      
      const res = await db.getAllAsync<{ulb: string, cnt: number}>(query, params);
      setUlbs(res.map(r => ({ name: r.ulb, count: r.cnt })));
    };
    loadUlbs();
  }, [store.selectedState, district]);

  const toggleUlb = async (ulbName: string) => {
    if (expandedUlb === ulbName) { setExpandedUlb(null); return; }
    setExpandedUlb(ulbName);
    let q = "SELECT * FROM tenders WHERE ulb = ?";
    let p = [ulbName];
    if (store.selectedState && store.selectedState !== 'All States') { q += " AND state = ?"; p.push(store.selectedState); }
    const projs = await db.getAllAsync(q, p);
    setUlbProjects(projs);
  };

  const handleSchedule = (proj: any) => {
    store.addPlannerItem({
      id: `${proj.project_id}_${proj.tender_id}`,
      projectId: proj.project_id,
      tenderId: proj.tender_id,
      title: proj.project_title,
      ulb: proj.ulb
    });
  };

  // Process To-Do List (Exclude visited)
  const pendingItems = useMemo(() => {
    return store.plannerItems.filter(i => {
      const fName = `${i.projectId.replace(/[\/\\]/g, '-')}_${i.tenderId.replace(/[\/\\]/g, '-')}`;
      return !visitedSet.has(fName); 
    });
  }, [store.plannerItems, visitedSet]);

  const filteredUlbs = ulbs.filter(u => !search || u.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Field Visit Planner</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#DBEAFE', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 }}>
           <Ionicons name="location" size={14} color="#2563EB" />
           <Text style={{ color: '#1D4ED8', fontWeight: 'bold', marginLeft: 4, fontSize: 12 }}>{store.selectedState}</Text>
        </View>
      </View>

      <View style={styles.tabContainer}>
         <TouchableOpacity onPress={() => setActiveTab('pending')} style={[styles.tabBtn, activeTab === 'pending' && styles.tabBtnActive]}>
            <Ionicons name="list-circle" size={18} color={activeTab === 'pending' ? "#2563EB" : "#64748B"} style={{marginRight: 6}} />
            <Text style={[styles.tabText, activeTab === 'pending' && styles.tabTextActive]}>Pending Visits ({pendingItems.length})</Text>
         </TouchableOpacity>
         <TouchableOpacity onPress={() => setActiveTab('planning')} style={[styles.tabBtn, activeTab === 'planning' && styles.tabBtnActive]}>
            <Ionicons name="map" size={18} color={activeTab === 'planning' ? "#2563EB" : "#64748B"} style={{marginRight: 6}} />
            <Text style={[styles.tabText, activeTab === 'planning' && styles.tabTextActive]}>Plan to Visit</Text>
         </TouchableOpacity>
      </View>

      {activeTab === 'pending' ? (
        <FlatList
          data={pendingItems}
          keyExtractor={i => i.id}
          contentContainerStyle={{ padding: 15 }}
          ListEmptyComponent={<Text style={{ textAlign: 'center', color: '#64748B', marginTop: 40 }}>No pending visits in your planner.</Text>}
          renderItem={({ item: proj }) => (
            <TouchableOpacity style={styles.todoCard} onPress={() => router.push(`/project/${encodeURIComponent(proj.projectId)}?tender_id=${encodeURIComponent(proj.tenderId || 'UNKNOWN')}` as any)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12, color: '#2563EB', fontWeight: 'bold' }}>{proj.projectId}</Text>
                    <Text style={{ fontSize: 14, color: '#1E293B', fontWeight: 'bold', marginVertical: 4 }} numberOfLines={2}>{proj.title}</Text>
                    <Text style={{ fontSize: 12, color: '#64748B' }}>📍 {proj.ulb}</Text>
                  </View>
                  <TouchableOpacity onPress={() => store.removePlannerItem(proj.id)} style={{ padding: 5 }}><Ionicons name="close-circle" size={24} color="#EF4444" /></TouchableOpacity>
              </View>
            </TouchableOpacity>
          )}
        />
      ) : (
        <View style={{ flex: 1 }}>
          <View style={{ padding: 15, borderBottomWidth: 1, borderColor: '#E2E8F0' }}>
            <View style={styles.searchBar}>
              <Ionicons name="search" size={18} color="#94A3B8" />
              <TextInput style={styles.searchInput} placeholder="Search ULB..." placeholderTextColor="#64748B" value={search} onChangeText={setSearch} />
            </View>
          </View>
          
          <FlatList
            data={filteredUlbs}
            keyExtractor={u => u.name}
            contentContainerStyle={{ padding: 15 }}
            renderItem={({ item }) => (
              <View style={{ marginBottom: 10 }}>
                <TouchableOpacity style={styles.ulbCard} onPress={() => toggleUlb(item.name)}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name={expandedUlb === item.name ? "folder-open" : "folder"} size={22} color="#2563EB" style={{ marginRight: 10 }} />
                    <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#1E293B' }}>{item.name}</Text>
                  </View>
                  <Text style={styles.countBadge}>{item.count}</Text>
                </TouchableOpacity>
                
                {/* Expanded Projects inside ULB */}
                {expandedUlb === item.name && (
                  <View style={styles.expandedProjectsContainer}>
                    {ulbProjects.map((proj, idx) => {
                      const isScheduled = store.plannerItems.some(i => i.id === `${proj.project_id}_${proj.tender_id}`);
                      return (
                        <View key={`${proj.project_id}_${proj.tender_id}_${idx}`} style={styles.projRow}>
                          <View style={{ flex: 1, marginRight: 10 }}>
                            <Text style={{ fontSize: 12, color: '#2563EB', fontWeight: 'bold' }}>{proj.project_id}</Text>
                            <Text style={{ fontSize: 13, color: '#334155' }} numberOfLines={1}>{proj.project_title}</Text>
                          </View>
                          <TouchableOpacity 
                            style={[styles.actionBtn, isScheduled ? { backgroundColor: '#DCFCE7', borderColor: '#BBF7D0' } : {}]} 
                            onPress={() => handleSchedule(proj)} 
                            disabled={isScheduled}
                          >
                            <Ionicons name={isScheduled ? "checkmark" : "add"} size={18} color={isScheduled ? "#16A34A" : "#2563EB"} />
                          </TouchableOpacity>
                        </View>
                      )
                    })}
                  </View>
                )}
              </View>
            )}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '900', color: '#1E293B' },
  
  tabContainer: { flexDirection: 'row', backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 15 },
  tabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 15, borderBottomWidth: 3, borderColor: 'transparent' },
  tabBtnActive: { borderColor: '#2563EB' },
  tabText: { fontSize: 14, fontWeight: '700', color: '#64748B' },
  tabTextActive: { color: '#2563EB' },

  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 8, paddingHorizontal: 10 },
  searchInput: { flex: 1, paddingVertical: 10, paddingHorizontal: 10, fontSize: 15 },
  
  ulbCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 15, backgroundColor: '#FFF', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', elevation: 1 },
  countBadge: { fontSize: 12, color: '#2563EB', fontWeight: 'bold', backgroundColor: '#DBEAFE', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  
  expandedProjectsContainer: { marginLeft: 20, borderLeftWidth: 2, borderColor: '#CBD5E1', paddingLeft: 12, marginTop: 8 },
  projRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, backgroundColor: '#FFF', borderRadius: 8, marginBottom: 8, borderWidth: 1, borderColor: '#F1F5F9' },
  actionBtn: { padding: 8, backgroundColor: '#EFF6FF', borderRadius: 8, borderWidth: 1, borderColor: '#BFDBFE' },
  
  todoCard: { padding: 15, backgroundColor: '#FFF', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4 }
});