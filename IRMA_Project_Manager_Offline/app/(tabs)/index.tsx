import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, FlatList, TextInput, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Modal, TouchableWithoutFeedback, Keyboard, Alert } from 'react-native';
import * as SQLite from 'expo-sqlite';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { doc, getDoc } from 'firebase/firestore';
import * as Linking from 'expo-linking';

import { db as firestoreDb } from '../../utils/firebaseConfig';
import { globalStyles } from '../../styles/globalStyles';
import { useUserStore } from '../../store/userStore';

interface Tender {
  project_id: string;
  tender_id: string;
  project_title: string;
  project_type: string;
  state: string;
  district: string;
  ulb: string;
  physical_progress: string;
  latitude?: string;
  longitude?: string;
}

const getShortSortName = (val: string) => {
  const map: Record<string, string> = {
    'title': 'Title',
    'id': 'PR ID',
    'type': 'PR Type',
    'progress': 'Progress'
  };
  return map[val] || 'Sort By';
};

const getActiveUserId = async () => {
  try {
    const sessionStr = await SecureStore.getItemAsync('irma_device_auth_session');
    if (sessionStr) {
      const parsedSession = JSON.parse(sessionStr);
      let uId = parsedSession.uniqueUserId || parsedSession.userId;
      try {
        const userSnap = await getDoc(doc(firestoreDb, 'users', parsedSession.userId));
        if (userSnap.exists() && userSnap.data().uniqueUserId) {
            uId = userSnap.data().uniqueUserId;
            if (parsedSession.uniqueUserId !== uId) {
                parsedSession.uniqueUserId = uId;
                await SecureStore.setItemAsync('irma_device_auth_session', JSON.stringify(parsedSession));
            }
        }
      } catch (e) { console.warn(e); }
      return uId || 'AnonymousUser';
    }
  } catch(e) { console.warn(e); }
  return 'AnonymousUser';
};

const scanForKmls = async (userId: string) => {
  const kmlSet = new Set<string>();
  const baseDir = `${FileSystem.documentDirectory}projects/${userId}/`;
  try {
    const info = await FileSystem.getInfoAsync(baseDir);
    if (!info.exists) return kmlSet;
    const folders = await FileSystem.readDirectoryAsync(baseDir);
    for (const folder of folders) {
      if (folder === 'SQLite' || folder.endsWith('.json')) continue;
      let hasKml = false;
      const checkDir = async (dirPath: string) => {
        if (hasKml) return;
        try {
            const dInfo = await FileSystem.getInfoAsync(dirPath);
            if (!dInfo.exists || !dInfo.isDirectory) return;
            const items = await FileSystem.readDirectoryAsync(dirPath);
            for (const item of items) {
                if (hasKml) return;
                if (item.toLowerCase().endsWith('.kml')) { hasKml = true; return; }
                const subPath = `${dirPath}${item}`;
                const subInfo = await FileSystem.getInfoAsync(subPath);
                if (subInfo.isDirectory) await checkDir(`${subPath}/`);
            }
        } catch(e) {}
      };
      await checkDir(`${baseDir}${folder}/`);
      if (hasKml) kmlSet.add(folder);
    }
  } catch(e) {}
  return kmlSet;
};

const getFolderName = (pId: string, tId: string) => {
  return `${pId}_${tId || 'UNKNOWN_TENDER'}`.replace(/[^a-zA-Z0-9_-]/g, '_');
};

const TenderCard = React.memo(({ item, onPress, hasKml, isVisited, isPlanned, onOpenKml }: { item: Tender, onPress: (pId: string, tId: string) => void, hasKml: boolean, isVisited: boolean, isPlanned: boolean, onOpenKml: (pId: string, tId: string) => void }) => (
  <TouchableOpacity style={[globalStyles.card, isVisited ? styles.visitedCard : (isPlanned ? styles.plannedCard : null)]} activeOpacity={0.7} onPress={() => onPress(item.project_id, item.tender_id)}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
      <Text style={styles.cardId}>{item.project_id}</Text>
      <Text style={styles.progressBadge}>{item.physical_progress || '0'}%</Text>
    </View>
    <Text style={styles.cardType}>{item.project_type}</Text>
    <Text style={styles.cardTitle}>{item.project_title}</Text>
    <View style={styles.cardFooter}>
      <View style={styles.footerItem}>
        <Ionicons name="location-outline" size={14} color="#64748B" style={{marginRight: 4, marginTop: 1}}/>
        <Text style={styles.cardMeta}>{item.ulb}, {item.district}</Text>
      </View>
      <View style={[styles.footerItem, { justifyContent: 'flex-end' }]}>
        <Text style={styles.tenderId}>Tender: {item.tender_id}</Text>
      </View>
    </View>

    <View style={globalStyles.btnRow}>
      <View style={{ flex: 1, marginRight: 5 }}>
        {item.latitude && item.longitude && (
          <TouchableOpacity style={globalStyles.locateYellowBtn} onPress={() => Linking.openURL(`https://maps.google.com/?q=${item.latitude},${item.longitude}`)}>
            <Ionicons name="navigate-circle-outline" size={20} color="white" />
            <Text style={globalStyles.locateBtnText}>Map Pin</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={{ flex: 1, marginLeft: 5 }}>
        {hasKml && (
          <TouchableOpacity style={globalStyles.locateGreenBtn} onPress={() => onOpenKml(item.project_id, item.tender_id)}>
            <Ionicons name="earth" size={20} color="white" />
            <Text style={globalStyles.locateBtnText}>KML Pin</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  </TouchableOpacity>
));

export default function ProjectsTab() {
  const router = useRouter();
  const db = SQLite.useSQLiteContext();
  const store = useUserStore();
  
  const [loading, setLoading] = useState(true);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [kmlProjects, setKmlProjects] = useState<Set<string>>(new Set());
  const [visitedProjects, setVisitedProjects] = useState<Set<string>>(new Set());
  const [plannerItems, setPlannerItems] = useState<any[]>([]); 
  
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [search, setSearch] = useState('');
  
  const [state, setState] = useState(store.selectedState === 'All States' ? '' : store.selectedState);
  const [district, setDistrict] = useState('');
  const [ulb, setUlb] = useState('');
  const [progressFilter, setProgressFilter] = useState('');
  
  const [sortBy, setSortBy] = useState<'title' | 'id' | 'type' | 'progress' | ''>('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const [activeModal, setActiveModal] = useState<{type: 'state' | 'district' | 'ulb' | 'sort' | 'progress', options: string[], title: string} | null>(null);
  
  const filterScrollRef = useRef<ScrollView>(null);
  const flatListRef = useRef<FlatList>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let isMounted = true;
      if (store.selectedState !== 'All States') setState(store.selectedState);
      
      loadTenders(isMounted);
      checkLocalWorkspace(isMounted);
      return () => { isMounted = false; };
    }, [store.selectedState])
  );

  const checkLocalWorkspace = async (isMounted: boolean) => {
    const userId = await getActiveUserId();
    const kmls = await scanForKmls(userId); 
    const visited = new Set<string>();
    let loadedPlanner = [];
    try {
      const baseDir = `${FileSystem.documentDirectory}projects/${userId}/`;
      const folders = await FileSystem.readDirectoryAsync(baseDir).catch(()=>[]);
      for (const f of folders) {
          if (f !== 'SQLite' && !f.endsWith('.json')) visited.add(f);
      }
      
      const path = `${baseDir}planner_cache.json`;
      const info = await FileSystem.getInfoAsync(path);
      if(info.exists) loadedPlanner = JSON.parse(await FileSystem.readAsStringAsync(path));
    } catch(e) {}
    
    if (isMounted) {
      setKmlProjects(kmls);
      setVisitedProjects(visited);
      setPlannerItems(loadedPlanner);
    }
  };

  const loadTenders = async (isMounted: boolean) => {
    try {
      setLoading(true);
      const data = await db.getAllAsync<Tender>(`
        SELECT t.*, pd.latitude, pd.longitude 
        FROM tenders t
        LEFT JOIN project_details pd ON t.project_id = pd.project_id
      `);
      if (isMounted) setTenders(data || []);
    } catch (e) {
      console.error(e);
    } finally {
      if (isMounted) setLoading(false);
    }
  };

  const handleOpenLocalKml = useCallback(async (pId: string, tId: string) => {
    const userId = await getActiveUserId();
    const folderName = getFolderName(pId, tId);
    const sourcePath = `${FileSystem.documentDirectory}projects/${userId}/${folderName}/`;
    try {
      let latestKmlUri = ''; let latestTime = 0;
      const findLatestKml = async (currentPath: string) => {
        try {
          const info = await FileSystem.getInfoAsync(currentPath);
          if (!info.exists || !info.isDirectory) return;
          const files = await FileSystem.readDirectoryAsync(currentPath);
          for (const file of files) {
            const fullPath = `${currentPath}${file}`;
            const fileInfo = await FileSystem.getInfoAsync(fullPath);
            if (fileInfo.isDirectory) { await findLatestKml(`${fullPath}/`); }
            else if (file.toLowerCase().endsWith('.kml')) {
              if (fileInfo.modificationTime && fileInfo.modificationTime >= latestTime) {
                latestTime = fileInfo.modificationTime; latestKmlUri = fullPath;
              }
            }
          }
        } catch(e) {}
      };
      
      await findLatestKml(sourcePath);

      if (latestKmlUri) {
         const content = await FileSystem.readAsStringAsync(latestKmlUri);
         const coordMatch = content.match(/<coordinates>[\s\S]*?([0-9.-]+)\s*,\s*([0-9.-]+)/i);
         if (coordMatch) {
             Linking.openURL(`https://maps.google.com/?q=${coordMatch[2].trim()},${coordMatch[1].trim()}`);
             return;
         }
         Alert.alert("Error", "Could not parse location data from the KML file.");
      }
      else Alert.alert("Not Found", "No KML file found for this project.");
    } catch (e) { Alert.alert("Error", "Could not open KML file."); }
  }, []);

  const handlePressTender = useCallback((projectId: string, tenderId: string) => {
    router.push(`/project/${encodeURIComponent(projectId)}?tender_id=${encodeURIComponent(tenderId || 'UNKNOWN')}` as any);
  }, [router]);

  const uniqueStates = ['All States', ...[...new Set(tenders.map(t => t.state).filter(Boolean))].sort()];
  const uniqueDistricts = ['All Districts', ...[...new Set(tenders.filter(t => !state || t.state === state).map(t => t.district).filter(Boolean))].sort()];
  const uniqueUlbs = ['All ULBs', ...[...new Set(tenders.filter(t => (!state || t.state === state) && (!district || t.district === district)).map(t => t.ulb).filter(Boolean))].sort()];
  
  const sortOptions = ['None', 'Project Title', 'Project ID', 'Project Type', 'Physical Progress'];
  const progressOptions = ['All Ranges', '100%', '90-99%', '80-89%', '70-79%', '60-69%', '50-59%', '40-49%', '30-39%', '20-29%', '0-19%'];

  const filteredAndSortedTenders = useMemo(() => {
    let filtered = tenders.filter(t => {
      const q = search.toLowerCase();
      const matchSearch = 
        (t.project_title || '').toLowerCase().includes(q) || 
        (t.project_id || '').toLowerCase().includes(q) ||
        (t.tender_id || '').toLowerCase().includes(q) ||
        (t.project_type || '').toLowerCase().includes(q) ||
        (t.ulb || '').toLowerCase().includes(q);
        
      const matchState = state ? t.state === state : true;
      const matchDistrict = district ? t.district === district : true;
      const matchUlb = ulb ? t.ulb === ulb : true;

      let matchProgress = true;
      if (progressFilter) {
        const p = parseFloat(t.physical_progress) || 0;
        if (progressFilter === '100%') matchProgress = p === 100;
        else if (progressFilter === '90-99%') matchProgress = p >= 90 && p < 100;
        else if (progressFilter === '80-89%') matchProgress = p >= 80 && p < 90;
        else if (progressFilter === '70-79%') matchProgress = p >= 70 && p < 80;
        else if (progressFilter === '60-69%') matchProgress = p >= 60 && p < 70;
        else if (progressFilter === '50-59%') matchProgress = p >= 50 && p < 60;
        else if (progressFilter === '40-49%') matchProgress = p >= 40 && p < 50;
        else if (progressFilter === '30-39%') matchProgress = p >= 30 && p < 40;
        else if (progressFilter === '20-29%') matchProgress = p >= 20 && p < 30;
        else if (progressFilter === '0-19%') matchProgress = p >= 0 && p < 20;
      }

      return matchSearch && matchState && matchDistrict && matchUlb && matchProgress;
    });

    if (sortBy) {
      filtered.sort((a, b) => {
        let res = 0;
        if (sortBy === 'title') res = (a.project_title || '').localeCompare(b.project_title || '');
        else if (sortBy === 'id') res = (a.project_id || '').localeCompare(b.project_id || '');
        else if (sortBy === 'type') res = (a.project_type || '').localeCompare(b.project_type || '');
        else if (sortBy === 'progress') {
          const progA = parseFloat(a.physical_progress) || 0;
          const progB = parseFloat(b.physical_progress) || 0;
          res = progA - progB; 
        }
        return sortOrder === 'asc' ? res : -res;
      });
    }

    return filtered;
  }, [search, state, district, ulb, progressFilter, sortBy, sortOrder, tenders]);

  const handleSelect = (selection: string) => {
    if (activeModal?.type === 'state') { setState(selection === 'All States' ? '' : selection); setDistrict(''); setUlb(''); }
    else if (activeModal?.type === 'district') { setDistrict(selection === 'All Districts' ? '' : selection); setUlb(''); }
    else if (activeModal?.type === 'ulb') { setUlb(selection === 'All ULBs' ? '' : selection); }
    else if (activeModal?.type === 'progress') { setProgressFilter(selection === 'All Ranges' ? '' : selection); }
    else if (activeModal?.type === 'sort') {
      if (selection === 'None') setSortBy('');
      else if (selection === 'Project Title') setSortBy('title');
      else if (selection === 'Project ID') setSortBy('id');
      else if (selection === 'Project Type') setSortBy('type');
      else if (selection === 'Physical Progress') setSortBy('progress');
      setSortOrder('asc');
    }
    setActiveModal(null);
  };

  const handleResetAll = () => {
    setState(store.selectedState === 'All States' ? '' : store.selectedState);
    setDistrict(''); setUlb(''); setSearch(''); setProgressFilter(''); setSortBy(''); setSortOrder('asc');
    setIsSearchActive(false);
    filterScrollRef.current?.scrollTo({ x: 0, animated: true });
    Keyboard.dismiss();
  };

  const renderItem = useCallback(({ item }: { item: Tender }) => {
    const fName = getFolderName(item.project_id, item.tender_id);
    const isVisited = visitedProjects.has(fName);
    const isPlanned = !isVisited && plannerItems.some(i => i.projectId === item.project_id);

    return (
      <TenderCard 
        item={item} 
        hasKml={kmlProjects.has(fName)}
        isVisited={isVisited}
        isPlanned={isPlanned}
        onOpenKml={handleOpenLocalKml}
        onPress={handlePressTender} 
      />
    );
  }, [kmlProjects, visitedProjects, plannerItems, handleOpenLocalKml, handlePressTender]);

  if (loading) {
    return (
      <View style={globalStyles.centerContainer}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={{ marginTop: 10 }}>Accessing Local Database...</Text>
      </View>
    );
  }

  return (
    <View style={globalStyles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title} numberOfLines={1}>All Projects</Text>
          <View style={styles.headerControls}>
            <TouchableOpacity onPress={() => setIsSearchActive(!isSearchActive)} style={styles.searchIconBtn}>
              <Ionicons name="search" size={16} color="#1E293B" />
              <Text style={{marginLeft: 4, fontSize: 13, fontWeight: '600', color: '#1E293B'}}>Search</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.sortBtn, sortBy ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : {}]} 
              onPress={() => setActiveModal({ type: 'sort', options: sortOptions, title: 'Sort Projects By' })}
            >
              <Ionicons name="swap-vertical" size={16} color="#475569" />
              <Text style={styles.sortBtnText} numberOfLines={1}>
                {sortBy ? getShortSortName(sortBy) : 'Sort By'}
              </Text>
            </TouchableOpacity>
            
            {sortBy !== '' && (
              <TouchableOpacity style={styles.sortDirectionBtn} onPress={() => setSortOrder(p => p === 'asc' ? 'desc' : 'asc')}>
                <Ionicons name={sortOrder === 'asc' ? 'arrow-up' : 'arrow-down'} size={16} color="#2563EB" />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {isSearchActive && (
          <View style={styles.activeSearchBar}>
            <Ionicons name="search" size={20} color="#64748B" />
            <TextInput 
              placeholder="Search ID, Title, Type, ULB..." 
              style={styles.input}
              value={search}
              onChangeText={setSearch}
              autoFocus
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')} style={{ padding: 5 }}>
                <Ionicons name="close-circle" size={20} color="#94A3B8" />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => { setIsSearchActive(false); setSearch(''); Keyboard.dismiss(); }} style={{ paddingLeft: 10 }}>
              <Text style={{ color: '#EF4444', fontWeight: 'bold' }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.filterBar}>
        <ScrollView ref={filterScrollRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 15 }}>
          <FilterChip label={state || 'All States'} value={state} onPress={() => setActiveModal({ type: 'state', options: uniqueStates, title: 'Select State' })} />
          <FilterChip label={district || (state ? 'All Districts' : 'District')} value={district} disabled={!state} onPress={() => setActiveModal({ type: 'district', options: uniqueDistricts, title: 'Select District' })} />
          <FilterChip label={ulb || (state ? 'All ULBs' : 'ULB')} value={ulb} disabled={!state} onPress={() => setActiveModal({ type: 'ulb', options: uniqueUlbs, title: 'Select ULB' })} />
          <FilterChip label={progressFilter || 'Progress Range'} value={progressFilter} onPress={() => setActiveModal({ type: 'progress', options: progressOptions, title: 'Filter by Progress' })} />
          
          {(state || district || ulb || progressFilter || search || sortBy) && (
            <TouchableOpacity onPress={handleResetAll} style={styles.clearBtn}>
              <Text style={{ color: '#EF4444', fontWeight: 'bold' }}>Reset All</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      </View>

      <FlatList 
        ref={flatListRef}
        data={filteredAndSortedTenders}
        keyExtractor={(item, idx) => `${item.project_id}_${item.tender_id}_${idx}`}
        initialNumToRender={8}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
        updateCellsBatchingPeriod={50}
        renderItem={renderItem}
        ListEmptyComponent={<Text style={styles.emptyText}>No projects match your current filters.</Text>}
        contentContainerStyle={{ padding: 15, paddingBottom: 100 }}
        onScroll={(e) => setShowScrollTop(e.nativeEvent.contentOffset.y > 300)}
        scrollEventThrottle={16}
      />

      {showScrollTop && (
        <TouchableOpacity style={globalStyles.fab} onPress={() => flatListRef.current?.scrollToOffset({ offset: 0, animated: true })}>
          <Ionicons name="arrow-up" size={24} color="#FFF" />
        </TouchableOpacity>
      )}

      <Modal visible={!!activeModal} transparent animationType="fade">
        <TouchableWithoutFeedback onPress={() => setActiveModal(null)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{activeModal?.title}</Text>
                  <TouchableOpacity onPress={() => setActiveModal(null)}>
                    <Ionicons name="close" size={24} color="#64748B" />
                  </TouchableOpacity>
                </View>
                
                <FlatList
                  data={activeModal?.options}
                  keyExtractor={(item, idx) => `${item}_${idx}`}
                  renderItem={({ item }) => (
                    <TouchableOpacity style={styles.modalItem} onPress={() => handleSelect(item)}>
                      <Text style={[styles.modalItemText, (item.includes('All ') || item === 'None') && { color: '#2563EB', fontWeight: 'bold' }]}>
                        {item}
                      </Text>
                    </TouchableOpacity>
                  )}
                />
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

function FilterChip({ label, value, onPress, disabled }: any) {
  return (
    <TouchableOpacity 
      style={[styles.filterChip, disabled && { opacity: 0.4 }, value ? { backgroundColor: '#2563EB', borderColor: '#2563EB' } : null]} 
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={[styles.filterText, value ? { color: '#FFF' } : null]}>{label}</Text>
      <Ionicons name="chevron-down" size={14} color={value ? "#FFF" : "#2563EB"} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 },
  title: { fontSize: 24, fontWeight: '900', color: '#1E293B', flex: 1, paddingRight: 10 },
  searchIconBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, marginRight: 8, backgroundColor: '#F1F5F9', borderRadius: 8 },
  activeSearchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', padding: 10, borderRadius: 10, marginTop: 12 },
  sortBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, maxWidth: 110 },
  sortBtnText: { fontSize: 13, color: '#475569', marginLeft: 4, fontWeight: '600', flexShrink: 1 },
  sortDirectionBtn: { backgroundColor: '#EFF6FF', paddingHorizontal: 8, paddingVertical: 8, borderTopRightRadius: 8, borderBottomRightRadius: 8, marginLeft: 2 },
  input: { marginLeft: 10, flex: 1, fontSize: 16 },
  filterBar: { backgroundColor: '#FFF', paddingVertical: 12, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  filterChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EFF6FF', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, marginRight: 10, borderWidth: 1, borderColor: '#BFDBFE' },
  filterText: { color: '#2563EB', fontWeight: '600', marginRight: 6, fontSize: 13 },
  clearBtn: { paddingHorizontal: 10, justifyContent: 'center', marginRight: 20 },
  
  visitedCard: { backgroundColor: 'rgba(220, 252, 231, 0.7)', borderColor: '#86EFAC', borderWidth: 1 },
  plannedCard: { backgroundColor: 'rgba(254, 249, 195, 0.7)', borderColor: '#FDE047', borderWidth: 1 },
  
  cardId: { color: '#2563EB', fontWeight: 'bold', fontSize: 12 },
  progressBadge: { fontSize: 13, fontWeight: 'bold', color: '#16A34A', backgroundColor: '#DCFCE7', paddingHorizontal: 6, borderRadius: 4, overflow: 'hidden' },
  cardType: { fontSize: 12, color: '#64748B', marginBottom: 2, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#1E293B', marginBottom: 6 },
  cardFooter: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 4, paddingTop: 10, borderTopWidth: 1, borderColor: '#F1F5F9', gap: 10 },
  footerItem: { flexDirection: 'row', alignItems: 'flex-start', flexShrink: 1, minWidth: '45%' },
  cardMeta: { fontSize: 12, color: '#64748B', fontWeight: '500', lineHeight: 16 },
  tenderId: { fontSize: 12, color: '#94A3B8', lineHeight: 16, fontWeight: '500' },
  emptyText: { textAlign: 'center', marginTop: 40, color: '#94A3B8' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%', paddingBottom: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  modalItem: { padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  modalItemText: { fontSize: 16, color: '#334155' }
});