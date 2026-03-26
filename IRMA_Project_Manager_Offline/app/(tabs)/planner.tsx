import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, FlatList, TextInput, StyleSheet, Modal, useColorScheme, Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUserStore } from '../../store/userStore';

export default function PlannerTab() {
  const store = useUserStore();
  const db = SQLite.useSQLiteContext();
  const router = useRouter();
  const systemTheme = useColorScheme();
  const isDark = store.theme === 'dark' || (store.theme === 'system' && systemTheme === 'dark');
  
  const [search, setSearch] = useState('');
  const [district, setDistrict] = useState('');
  const [ulbs, setUlbs] = useState<{name: string, count: number}[]>([]);
  const [expandedUlb, setExpandedUlb] = useState<string | null>(null);
  const [ulbProjects, setUlbProjects] = useState<any[]>([]);
  const [visitedSet, setVisitedSet] = useState<Set<string>>(new Set());

  // Date picker state
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [pendingScheduleItem, setPendingScheduleItem] = useState<any>(null);
  const [customDateStr, setCustomDateStr] = useState('');

  // 1. Scan for visited projects to auto-hide them from To-Do
  useEffect(() => {
    const scanVisited = async () => {
      try {
        const baseDir = FileSystem.documentDirectory + 'projects/';
        const folders = await FileSystem.readDirectoryAsync(baseDir).catch(() => []);
        setVisitedSet(new Set(folders));
      } catch(e) {}
    };
    scanVisited();
  }, []);

  // 2. Load ULBs for the selected state
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

  // 3. Load Projects when a ULB is expanded
  const toggleUlb = async (ulbName: string) => {
    if (expandedUlb === ulbName) { setExpandedUlb(null); return; }
    setExpandedUlb(ulbName);
    let q = "SELECT * FROM tenders WHERE ulb = ?";
    let p = [ulbName];
    if (store.selectedState && store.selectedState !== 'All States') { q += " AND state = ?"; p.push(store.selectedState); }
    const projs = await db.getAllAsync(q, p);
    setUlbProjects(projs);
  };

  const handleSchedule = (proj: any, date: string) => {
    store.addPlannerItem({
      id: `${proj.project_id}_${proj.tender_id}`,
      projectId: proj.project_id,
      tenderId: proj.tender_id,
      title: proj.project_title,
      ulb: proj.ulb,
      date
    });
  };

  // 4. Process To-Do List (Group by Date, exclude visited)
  const todoGroups = useMemo(() => {
    const validItems = store.plannerItems.filter(i => {
      const fName = `${i.projectId.replace(/[\/\\]/g, '-')}_${i.tenderId.replace(/[\/\\]/g, '-')}`;
      return !visitedSet.has(fName); // Auto-hide visited
    });

    const groups: Record<string, any[]> = {};
    validItems.forEach(item => {
      if (!groups[item.date]) groups[item.date] = [];
      groups[item.date].push(item);
    });
    
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, items }));
  }, [store.plannerItems, visitedSet]);

  // Search logic for Right Side
  const filteredUlbs = ulbs.filter(u => !search || u.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <View style={[styles.container, { backgroundColor: isDark ? '#0F172A' : '#F8FAFC' }]}>
      {/* Top Header */}
      <View style={[styles.header, { backgroundColor: isDark ? '#1E293B' : '#FFF', borderBottomColor: isDark ? '#334155' : '#E2E8F0' }]}>
        <Text style={[styles.title, { color: isDark ? '#F8FAFC' : '#1E293B', fontSize: 24 * store.fontScale }]}>Field Planner</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
           <Ionicons name="location" size={16} color="#2563EB" />
           <Text style={{ color: '#2563EB', fontWeight: 'bold', marginLeft: 4 }}>{store.selectedState}</Text>
        </View>
      </View>

      <View style={styles.splitView}>
        {/* LEFT SIDE: TO-DO LIST */}
        <View style={[styles.leftPane, { borderRightColor: isDark ? '#334155' : '#E2E8F0' }]}>
          <View style={[styles.paneHeader, { backgroundColor: isDark ? '#1E293B' : '#F1F5F9' }]}>
            <Ionicons name="list-circle" size={20} color={isDark ? '#F8FAFC' : '#1E293B'} style={{marginRight: 8}} />
            <Text style={{ fontSize: 16 * store.fontScale, fontWeight: 'bold', color: isDark ? '#F8FAFC' : '#1E293B' }}>To-Do List</Text>
          </View>
          
          <FlatList
            data={todoGroups}
            keyExtractor={g => g.date}
            contentContainerStyle={{ padding: 10 }}
            ListEmptyComponent={<Text style={{ textAlign: 'center', color: '#64748B', marginTop: 20 }}>No pending tasks.</Text>}
            renderItem={({ item: group }) => (
              <View style={{ marginBottom: 15 }}>
                <View style={{ backgroundColor: '#DBEAFE', alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, marginBottom: 8 }}>
                   <Text style={{ color: '#1E40AF', fontWeight: 'bold', fontSize: 12 * store.fontScale }}>📅 {group.date}</Text>
                </View>
                {group.items.map(proj => (
                  <TouchableOpacity key={proj.id} style={[styles.todoCard, { backgroundColor: isDark ? '#1E293B' : '#FFF', borderColor: isDark ? '#334155' : '#E2E8F0' }]} onPress={() => router.push({ pathname: '/project/[id]', params: { id: proj.projectId, tender_id: proj.tenderId } })}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                       <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 12 * store.fontScale, color: '#2563EB', fontWeight: 'bold' }}>{proj.projectId}</Text>
                          <Text style={{ fontSize: 14 * store.fontScale, color: isDark ? '#F8FAFC' : '#1E293B', fontWeight: 'bold', marginVertical: 4 }} numberOfLines={2}>{proj.title}</Text>
                          <Text style={{ fontSize: 11 * store.fontScale, color: '#64748B' }}>📍 {proj.ulb}</Text>
                       </View>
                       <TouchableOpacity onPress={() => store.removePlannerItem(proj.id)} style={{ padding: 5 }}><Ionicons name="close-circle" size={20} color="#EF4444" /></TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          />
        </View>

        {/* RIGHT SIDE: PLANNER / FOLDERS */}
        <View style={styles.rightPane}>
          <View style={[styles.paneHeader, { backgroundColor: isDark ? '#1E293B' : '#F1F5F9' }]}>
            <TextInput style={[styles.searchInput, { backgroundColor: isDark ? '#0F172A' : '#FFF', color: isDark ? '#F8FAFC' : '#1E293B', borderColor: isDark ? '#334155' : '#E2E8F0' }]} placeholder="Search ULB or Project..." placeholderTextColor="#64748B" value={search} onChangeText={setSearch} />
          </View>
          
          <FlatList
            data={filteredUlbs}
            keyExtractor={u => u.name}
            contentContainerStyle={{ padding: 10 }}
            renderItem={({ item }) => (
              <View style={{ marginBottom: 8 }}>
                <TouchableOpacity style={[styles.ulbCard, { backgroundColor: isDark ? '#1E293B' : '#FFF', borderColor: isDark ? '#334155' : '#E2E8F0' }]} onPress={() => toggleUlb(item.name)}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name={expandedUlb === item.name ? "folder-open" : "folder"} size={20} color="#2563EB" style={{ marginRight: 10 }} />
                    <Text style={{ fontSize: 15 * store.fontScale, fontWeight: 'bold', color: isDark ? '#F8FAFC' : '#1E293B' }}>{item.name}</Text>
                  </View>
                  <Text style={{ fontSize: 12 * store.fontScale, color: '#64748B', fontWeight: 'bold', backgroundColor: isDark ? '#334155' : '#F1F5F9', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>{item.count}</Text>
                </TouchableOpacity>
                
                {/* Expanded Projects inside ULB */}
                {expandedUlb === item.name && (
                  <View style={{ marginLeft: 20, borderLeftWidth: 2, borderColor: isDark ? '#334155' : '#E2E8F0', paddingLeft: 10, marginTop: 5 }}>
                    {ulbProjects.map(proj => {
                      const isScheduled = store.plannerItems.some(i => i.id === `${proj.project_id}_${proj.tender_id}`);
                      return (
                        <View key={proj.tender_id} style={[styles.projRow, { backgroundColor: isDark ? '#0F172A' : '#F8FAFC' }]}>
                          <View style={{ flex: 1, marginRight: 10 }}>
                            <Text style={{ fontSize: 12 * store.fontScale, color: '#2563EB', fontWeight: 'bold' }}>{proj.project_id}</Text>
                            <Text style={{ fontSize: 13 * store.fontScale, color: isDark ? '#F8FAFC' : '#1E293B' }} numberOfLines={1}>{proj.project_title}</Text>
                          </View>
                          <View style={{ flexDirection: 'row', gap: 5 }}>
                            <TouchableOpacity style={styles.actionBtn} onPress={() => handleSchedule(proj, 'Unscheduled')} disabled={isScheduled}>
                              <Ionicons name="add" size={18} color={isScheduled ? "#94A3B8" : "#2563EB"} />
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.actionBtn} onPress={() => { setPendingScheduleItem(proj); setCustomDateStr(''); setShowDatePicker(true); }} disabled={isScheduled}>
                              <Ionicons name="calendar-outline" size={18} color={isScheduled ? "#94A3B8" : "#10B981"} />
                            </TouchableOpacity>
                          </View>
                        </View>
                      )
                    })}
                  </View>
                )}
              </View>
            )}
          />
        </View>
      </View>

      {/* Basic Date Picker Modal */}
      <Modal visible={showDatePicker} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ backgroundColor: isDark ? '#1E293B' : '#FFF', padding: 20, borderRadius: 12, width: '80%' }}>
            <Text style={{ fontSize: 16 * store.fontScale, fontWeight: 'bold', color: isDark ? '#F8FAFC' : '#1E293B', marginBottom: 15 }}>Schedule Visit</Text>
            <TextInput style={[styles.searchInput, { backgroundColor: isDark ? '#0F172A' : '#FFF', color: isDark ? '#F8FAFC' : '#1E293B', borderColor: isDark ? '#334155' : '#E2E8F0', marginBottom: 15 }]} placeholder="YYYY-MM-DD" placeholderTextColor="#64748B" value={customDateStr} onChangeText={setCustomDateStr} />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
               <TouchableOpacity onPress={() => setShowDatePicker(false)} style={{ padding: 10 }}><Text style={{ color: '#64748B', fontWeight: 'bold' }}>Cancel</Text></TouchableOpacity>
               <TouchableOpacity onPress={() => { handleSchedule(pendingScheduleItem, customDateStr || 'Unscheduled'); setShowDatePicker(false); }} style={{ backgroundColor: '#2563EB', paddingHorizontal: 15, paddingVertical: 10, borderRadius: 8 }}><Text style={{ color: '#FFF', fontWeight: 'bold' }}>Schedule</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 20, paddingTop: 60, borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontWeight: '900' },
  splitView: { flex: 1, flexDirection: 'row' }, // Native split view
  leftPane: { flex: 1, borderRightWidth: 1 },
  rightPane: { flex: 1 },
  paneHeader: { flexDirection: 'row', alignItems: 'center', padding: 10, borderBottomWidth: 1, borderColor: 'transparent' },
  searchInput: { flex: 1, paddingVertical: 8, paddingHorizontal: 15, borderRadius: 8, borderWidth: 1, fontSize: 14 },
  ulbCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderRadius: 8, borderWidth: 1 },
  projRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 10, borderRadius: 6, marginBottom: 5 },
  actionBtn: { padding: 6, backgroundColor: 'rgba(0,0,0,0.05)', borderRadius: 6 },
  todoCard: { padding: 12, borderRadius: 8, borderWidth: 1, marginBottom: 8, elevation: 1 }
});