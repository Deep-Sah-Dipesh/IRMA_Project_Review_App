import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList, TextInput, StyleSheet, Keyboard, Modal, TouchableWithoutFeedback, Linking, Alert } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store'; 
import { useRouter, useFocusEffect } from 'expo-router';
import { doc, getDoc } from 'firebase/firestore';

import { db as firestoreDb } from '../../utils/firebaseConfig';
import { useUserStore } from '../../store/userStore';
import { getActiveUserId } from '../../utils/userSession';
import { getQuarterStr, getQuarterFromYYYYMMDD } from '../../utils/period';

const getFolderName = (pId: string, tId: string) => {
  return `${pId}_${tId || 'UNKNOWN_TENDER'}`.replace(/[^a-zA-Z0-9_-]/g, '_');
};

type SortOption = 'Project Title' | 'Physical Progress';



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

const PlannerCard = React.memo(({ item, hasKml, isVisited, isPlanned, activeTab, onPressCard, onTogglePlan, onOpenKml }: any) => {
  const hasMapPin = !!(item.latitude && item.longitude);
  const hasBoth = hasMapPin && hasKml;

  let iconName: keyof typeof Ionicons.glyphMap = "add";
  let iconColor = "#2563EB";
  let btnStyle = { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' };
  let btnLabel = "Add";

  if (activeTab === 'pending') {
    iconName = "close-circle";
    iconColor = "#EF4444";
    btnStyle = { backgroundColor: '#FEF2F2', borderColor: '#FECACA' };
    btnLabel = "Remove";
  } else if (isVisited) {
    iconName = "checkmark";
    iconColor = "#16A34A";
    btnStyle = { backgroundColor: '#DCFCE7', borderColor: '#BBF7D0' };
    btnLabel = "Visited";
  } else if (isPlanned) {
    iconName = "calendar";
    iconColor = "#CA8A04";
    btnStyle = { backgroundColor: '#FEF9C3', borderColor: '#FDE047' };
    btnLabel = "Planned";
  }

  return (
    <TouchableOpacity 
      style={[
        styles.card, 
        isVisited ? styles.visitedCard : (isPlanned ? styles.plannedCard : null),
        isVisited && activeTab !== 'pending' && { opacity: 0.9 }
      ]}
      activeOpacity={0.7}
      onPress={() => onPressCard(item)}
    >
      <View style={styles.cardHeaderRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={styles.cardId}>{item.project_id}</Text>
          {isVisited && (
            <View style={styles.visitedBadge}>
              <Ionicons name="checkmark-circle" size={12} color="#15803D" style={{ marginRight: 2 }} />
              <Text style={styles.visitedBadgeText}>Visited</Text>
            </View>
          )}
        </View>
        <Text style={styles.progressBadge}>{item.physical_progress || '0'}%</Text>
      </View>

      <Text style={styles.tenderId}>Tender: {item.tender_id}</Text>
      <Text style={styles.cardTitle}>{item.project_title}</Text>

      <View style={styles.cardBottomRow}>
        <Text style={styles.cardType}>{item.project_type}</Text>
        
        <TouchableOpacity 
          style={[styles.actionBtn, btnStyle]} 
          onPress={() => onTogglePlan(item)}
          disabled={isVisited && activeTab !== 'pending'}
        >
          <Ionicons name={iconName} size={16} color={iconColor} />
          <Text style={[styles.actionBtnLabel, { color: iconColor }]}>{btnLabel}</Text>
        </TouchableOpacity>
      </View>

      {(hasMapPin || hasKml) && (
        <View style={styles.pinBtnRow}>
          {hasMapPin && (
            <TouchableOpacity 
              style={[styles.pinBtnHalf, { backgroundColor: '#EAB308', flex: hasBoth ? 1 : 0, width: hasBoth ? undefined : '50%' }]} 
              onPress={() => Linking.openURL(`https://maps.google.com/?q=${item.latitude},${item.longitude}`)}
            >
              <Ionicons name="navigate-circle-outline" size={18} color="#FFF" style={{ marginRight: 6 }} />
              <Text style={styles.pinBtnText}>Map Pin</Text>
            </TouchableOpacity>
          )}
          {hasKml && (
            <TouchableOpacity 
              style={[styles.pinBtnHalf, { backgroundColor: '#10B981', flex: hasBoth ? 1 : 0, width: hasBoth ? undefined : '50%' }]} 
              onPress={() => onOpenKml(item.project_id, item.tender_id)}
            >
              <Ionicons name="earth" size={18} color="#FFF" style={{ marginRight: 6 }} />
              <Text style={styles.pinBtnText}>KML Pin</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
});

export default function PlannerTab() {
  const store = useUserStore();
  const db = SQLite.useSQLiteContext();
  const router = useRouter(); 
  
  const [activeTab, setActiveTab] = useState<'pending' | 'planning'>('pending');
  const [district, setDistrict] = useState('');
  
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('Project Title');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [activeModal, setActiveModal] = useState<{type: 'sort', options: string[], title: string} | null>(null);
  
  const [allProjects, setAllProjects] = useState<any[]>([]);
  const [visitedSet, setVisitedSet] = useState<Set<string>>(new Set());
  const [kmlProjects, setKmlProjects] = useState<Set<string>>(new Set());
  const [plannerItems, setPlannerItems] = useState<any[]>([]); 

  const [collapsedPendingUlbs, setCollapsedPendingUlbs] = useState<Set<string>>(new Set());
  const [expandedPlanningUlbs, setExpandedPlanningUlbs] = useState<Set<string>>(new Set());

  const checkIsVisited = useCallback((p: any) => {
    if (!p) return false;
    const fName = getFolderName(p.project_id, p.tender_id);
    const cleanId = (p.project_id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (visitedSet.has(fName) || visitedSet.has(p.project_id) || visitedSet.has(cleanId)) return true;
    return false;
  }, [visitedSet]);

  const handleOpenKml = useCallback(async (projectId: string, tenderId: string) => {
    try {
      let uid = await getActiveUserId();
      const folderName = getFolderName(projectId, tenderId);
      const sourcePath = `${FileSystem.documentDirectory}projects/${uid}/${folderName}/`;
      
      let latestKmlUri = '';
      let latestTime = 0;
      
      const findLatestKml = async (currentPath: string) => {
        try {
          const info = await FileSystem.getInfoAsync(currentPath);
          if (!info.exists || !info.isDirectory) return;
          const files = await FileSystem.readDirectoryAsync(currentPath);
          for (const file of files) {
            const fullPath = `${currentPath}${file}`;
            const fileInfo = await FileSystem.getInfoAsync(fullPath);
            if (fileInfo.exists && fileInfo.isDirectory) { await findLatestKml(`${fullPath}/`); }
            else if (fileInfo.exists && !fileInfo.isDirectory && file.toLowerCase().endsWith('.kml')) {
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

  const scanVisitedAndPlanner = useCallback(async () => {
    try {
      const userId = await getActiveUserId();
      const baseDir = `${FileSystem.documentDirectory}projects/${userId}/`;
      
      const validVisited = new Set<string>();
      let loadedPlanner = [];
      const currentQuarter = getQuarterStr();

      try {
        const info = await FileSystem.getInfoAsync(baseDir);
        if (info.exists) {
          const folders = await FileSystem.readDirectoryAsync(baseDir);
          for (const folder of folders) {
             if (folder === 'SQLite' || folder.endsWith('.json')) continue;
             
             try {
                 const visitDirs = await FileSystem.readDirectoryAsync(`${baseDir}${folder}/`).catch(()=>[]);
                 const hasCurrentQuarterVisit = visitDirs.some(vDir => {
                     if (vDir.startsWith('VISIT_')) {
                         const match = vDir.match(/_(\d{8})_/);
                         if (match && getQuarterFromYYYYMMDD(match[1]) === currentQuarter) {
                             return true;
                         }
                     }
                     return false;
                 });
                 if (hasCurrentQuarterVisit) {
                     validVisited.add(folder);
                     const lastUnderscore = folder.lastIndexOf('_');
                     if (lastUnderscore > 0) {
                         validVisited.add(folder.substring(0, lastUnderscore));
                     }
                     const firstUnderscore = folder.indexOf('_');
                     if (firstUnderscore > 0) {
                         validVisited.add(folder.substring(0, firstUnderscore));
                     }
                 }
             } catch(e) {}
          }
        }
        
        const path = `${baseDir}planner_cache.json`;
        const pInfo = await FileSystem.getInfoAsync(path);
        if (pInfo.exists) loadedPlanner = JSON.parse(await FileSystem.readAsStringAsync(path));
      } catch(e) {}
      
      const kmls = await scanForKmls(userId);
      setKmlProjects(kmls);
      setVisitedSet(validVisited);
      setPlannerItems(loadedPlanner);
    } catch(e) {}
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      let query = `
        SELECT t.*, pd.latitude, pd.longitude 
        FROM tenders t
        LEFT JOIN project_details pd ON t.project_id = pd.project_id
        WHERE t.ulb IS NOT NULL AND t.ulb != ''
      `;
      let params: string[] = [];
      if (store.selectedState && store.selectedState !== 'All States') {
        query += " AND t.state = ?"; params.push(store.selectedState);
      }
      if (district) {
        query += " AND t.district = ?"; params.push(district);
      }
      const res = await db.getAllAsync<any>(query, params);
      setAllProjects(res || []);
    } catch(e) {
      console.warn("Failed to load planner projects:", e);
    }
  }, [db, store.selectedState, district]);

  useFocusEffect(
    useCallback(() => {
      scanVisitedAndPlanner();
      loadProjects();
    }, [scanVisitedAndPlanner, loadProjects, activeTab]) 
  );

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    setSearch('');
    setIsSearchActive(false);
  }, [activeTab]);

  const toggleUlb = useCallback((ulbName: string) => {
    if (activeTab === 'pending') {
      setCollapsedPendingUlbs(prev => {
        const newSet = new Set(prev);
        newSet.has(ulbName) ? newSet.delete(ulbName) : newSet.add(ulbName);
        return newSet;
      });
    } else {
      setExpandedPlanningUlbs(prev => {
        const newSet = new Set(prev);
        newSet.has(ulbName) ? newSet.delete(ulbName) : newSet.add(ulbName);
        return newSet;
      });
    }
  }, [activeTab]);

  const togglePlanState = useCallback(async (proj: any) => {
    if (checkIsVisited(proj)) return;

    let items = [...plannerItems];
    const existingIdx = items.findIndex(i => i.projectId === proj.project_id && i.tenderId === proj.tender_id);

    if (existingIdx > -1) {
      items.splice(existingIdx, 1);
    } else {
      items.push({
        id: getFolderName(proj.project_id, proj.tender_id),
        projectId: proj.project_id,
        tenderId: proj.tender_id,
        title: proj.project_title,
        type: proj.project_type,
        progress: proj.physical_progress,
        ulb: proj.ulb
      });
    }
    
    setPlannerItems(items);
    
    const userId = await getActiveUserId();
    const userDir = `${FileSystem.documentDirectory}projects/${userId}/`;
    await FileSystem.makeDirectoryAsync(userDir, { intermediates: true }).catch(()=>{});
    const cachePath = `${userDir}planner_cache.json`;
    await FileSystem.writeAsStringAsync(cachePath, JSON.stringify(items));
  }, [plannerItems, checkIsVisited]);

  const handlePressCard = useCallback((item: any) => {
     router.push(`/project/${encodeURIComponent(item.project_id)}?tender_id=${encodeURIComponent(item.tender_id || 'UNKNOWN')}` as any);
  }, [router]);

  const handleSelectModal = (selection: string) => {
    setSortBy(selection as SortOption);
    setSortOrder('asc');
    setActiveModal(null);
  };

  // Dynamic count logic that accurately maps state filters with user's planner data
  const pendingCount = useMemo(() => {
    let count = 0;
    const pendingProjKeys = new Set(plannerItems.map(i => `${i.projectId}_${i.tenderId}`));
    allProjects.forEach(p => {
      const isPending = pendingProjKeys.has(`${p.project_id}_${p.tender_id}`);
      const isVisited = checkIsVisited(p);
      if (isPending && !isVisited) count++;
    });
    return count;
  }, [allProjects, plannerItems, checkIsVisited]);

  const listData = useMemo(() => {
    const q = search.toLowerCase();
    const pendingProjKeys = new Set(plannerItems.map(i => `${i.projectId}_${i.tenderId}`));

    const groups: Record<string, any[]> = {};

    allProjects.forEach(p => {
      const isPending = pendingProjKeys.has(`${p.project_id}_${p.tender_id}`);
      const isVisited = checkIsVisited(p);

      let shouldInclude = false;
      if (activeTab === 'pending') {
        shouldInclude = isPending && !isVisited;
      } else {
        shouldInclude = true;
      }

      if (shouldInclude) {
        const match = !q ||
          (p.project_id || '').toLowerCase().includes(q) ||
          (p.tender_id || '').toLowerCase().includes(q) ||
          (p.project_type || '').toLowerCase().includes(q) ||
          (p.project_title || '').toLowerCase().includes(q) ||
          (p.ulb || '').toLowerCase().includes(q);

        if (match) {
          if (!groups[p.ulb]) groups[p.ulb] = [];
          groups[p.ulb].push(p);
        }
      }
    });

    const flattenedData: any[] = [];
    
    Object.keys(groups).sort().forEach(ulb => {
      const projects = groups[ulb];
      
      projects.sort((a, b) => {
        if (activeTab === 'planning') {
          const aVisited = checkIsVisited(a);
          const bVisited = checkIsVisited(b);
          const aPlanned = pendingProjKeys.has(`${a.project_id}_${a.tender_id}`);
          const bPlanned = pendingProjKeys.has(`${b.project_id}_${b.tender_id}`);

          const weightA = aVisited ? 3 : (aPlanned ? 1 : 2);
          const weightB = bVisited ? 3 : (bPlanned ? 1 : 2);
          if (weightA !== weightB) return weightA - weightB;
        }

        let res = 0;
        if (sortBy === 'Physical Progress') {
          res = (parseFloat(a.physical_progress) || 0) - (parseFloat(b.physical_progress) || 0);
        } else {
          res = (a.project_title || '').localeCompare(b.project_title || '');
        }
        return sortOrder === 'asc' ? res : -res;
      });

      flattenedData.push({
        isHeader: true,
        id: `header_${ulb}`,
        ulb,
        count: projects.length
      });

      const isExpanded = activeTab === 'pending' 
        ? !collapsedPendingUlbs.has(ulb) 
        : expandedPlanningUlbs.has(ulb);

      if (isExpanded) {
        projects.forEach(p => {
          flattenedData.push({
            ...p,
            isHeader: false,
            id: getFolderName(p.project_id, p.tender_id)
          });
        });
      }
    });

    return flattenedData;
  }, [allProjects, search, sortBy, sortOrder, activeTab, checkIsVisited, plannerItems, collapsedPendingUlbs, expandedPlanningUlbs]);


  const renderItem = useCallback(({ item }: { item: any }) => {
    if (item.isHeader) {
      const isExpanded = activeTab === 'pending' 
        ? !collapsedPendingUlbs.has(item.ulb) 
        : expandedPlanningUlbs.has(item.ulb);

      return (
        <TouchableOpacity style={styles.ulbHeader} onPress={() => toggleUlb(item.ulb)} activeOpacity={0.7}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name={isExpanded ? "folder-open" : "folder"} size={20} color="#2563EB" style={{ marginRight: 8 }} />
            <Text style={styles.ulbHeaderText} numberOfLines={1}>{item.ulb}</Text>
          </View>
          <Text style={styles.ulbCountBadge}>{item.count}</Text>
        </TouchableOpacity>
      );
    }

    const isVisited = checkIsVisited(item);
    const isPlanned = !isVisited && plannerItems.some(i => i.projectId === item.project_id && i.tenderId === item.tender_id);
    const folder = getFolderName(item.project_id, item.tender_id);
    const hasKml = kmlProjects.has(folder);

    return (
      <PlannerCard 
         item={item} 
         hasKml={hasKml}
         isVisited={isVisited} 
         isPlanned={isPlanned} 
         activeTab={activeTab} 
         onPressCard={handlePressCard} 
         onTogglePlan={togglePlanState} 
         onOpenKml={handleOpenKml}
      />
    );
  }, [activeTab, collapsedPendingUlbs, expandedPlanningUlbs, checkIsVisited, plannerItems, kmlProjects, toggleUlb, togglePlanState, handlePressCard, handleOpenKml]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>Field Visit Planner</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
          <View style={styles.trimesterBadge}>
             <Ionicons name="calendar-outline" size={13} color="#1D4ED8" style={{ marginRight: 4 }} />
             <Text style={styles.trimesterText}>Current Trimester: {getQuarterStr()}</Text>
          </View>
          <View style={styles.locationBadge}>
             <Ionicons name="location" size={12} color="#2563EB" style={{ marginRight: 2 }} />
             <Text style={styles.locationText}>{store.selectedState}</Text>
          </View>
        </View>
      </View>

      <View style={styles.tabContainer}>
         <TouchableOpacity onPress={() => setActiveTab('pending')} style={[styles.tabBtn, activeTab === 'pending' && styles.tabBtnActive]}>
            <Ionicons name="list-circle" size={18} color={activeTab === 'pending' ? "#2563EB" : "#64748B"} style={{marginRight: 6}} />
            <Text style={[styles.tabText, activeTab === 'pending' && styles.tabTextActive]}>Pending Visits ({pendingCount})</Text>
         </TouchableOpacity>
         <TouchableOpacity onPress={() => setActiveTab('planning')} style={[styles.tabBtn, activeTab === 'planning' && styles.tabBtnActive]}>
            <Ionicons name="map" size={18} color={activeTab === 'planning' ? "#2563EB" : "#64748B"} style={{marginRight: 6}} />
            <Text style={[styles.tabText, activeTab === 'planning' && styles.tabTextActive]}>Plan to Visit</Text>
         </TouchableOpacity>
      </View>

      <View style={styles.searchSortRow}>
        {isSearchActive ? (
          <View style={styles.activeSearchContainer}>
            <Ionicons name="search" size={18} color="#64748B" style={{ marginLeft: 10 }} />
            <TextInput 
              placeholder="Search ID, Title, Type..." 
              style={styles.searchInput} 
              value={search} 
              onChangeText={setSearch} 
              autoFocus 
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')} style={{ padding: 5 }}>
                <Ionicons name="close-circle" size={18} color="#94A3B8" />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => { setIsSearchActive(false); setSearch(''); Keyboard.dismiss(); }} style={{ paddingHorizontal: 10 }}>
              <Text style={{ color: '#EF4444', fontWeight: 'bold' }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity onPress={() => setIsSearchActive(true)} style={[styles.toolbarBtn, { flex: 1, justifyContent: 'flex-start' }]}>
            <Ionicons name="search" size={16} color="#64748B" />
            <Text style={[styles.toolbarBtnText, { color: '#64748B' }]}>Search Projects...</Text>
          </TouchableOpacity>
        )}

        {!isSearchActive && (
          <View style={styles.sortGroup}>
            <TouchableOpacity 
              style={[styles.toolbarBtn, { borderTopRightRadius: 0, borderBottomRightRadius: 0, marginRight: 0 }]} 
              onPress={() => setActiveModal({ type: 'sort', options: ['Project Title', 'Physical Progress'], title: 'Sort Projects By' })}
            >
              <Ionicons name="swap-vertical" size={16} color="#475569" />
              <Text style={styles.toolbarBtnText}>{sortBy === 'Project Title' ? 'Title' : 'Progress'}</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.toolbarBtn, { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingHorizontal: 6, marginLeft: 1 }]} 
              onPress={() => setSortOrder(p => p === 'asc' ? 'desc' : 'asc')}
            >
              <Ionicons name={sortOrder === 'asc' ? 'arrow-up' : 'arrow-down'} size={16} color="#2563EB" />
            </TouchableOpacity>
          </View>
        )}
      </View>

      <FlatList
        data={listData}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        removeClippedSubviews={true}
        initialNumToRender={8}
        maxToRenderPerBatch={10}
        windowSize={5}
        contentContainerStyle={{ padding: 15, paddingBottom: 100 }}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {activeTab === 'pending' ? 'No pending visits.' : 'No projects match your search.'}
          </Text>
        }
      />

      <Modal visible={!!activeModal} transparent animationType="fade">
        <TouchableWithoutFeedback onPress={() => setActiveModal(null)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{activeModal?.title}</Text>
                  <TouchableOpacity onPress={() => setActiveModal(null)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
                </View>
                <FlatList 
                  data={activeModal?.options} 
                  keyExtractor={(item) => item} 
                  renderItem={({ item }) => (
                    <TouchableOpacity style={styles.modalItem} onPress={() => handleSelectModal(item)}>
                      <Text style={[styles.modalItemText, sortBy === item && { color: '#2563EB', fontWeight: 'bold' }]}>{item}</Text>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { paddingHorizontal: 15, paddingTop: 60, paddingBottom: 15, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  title: { fontSize: 24, fontWeight: '900', color: '#1E293B' },
  trimesterBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EFF6FF', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#BFDBFE' },
  trimesterText: { fontSize: 11, fontWeight: '700', color: '#1D4ED8' },
  locationBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#DBEAFE', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#BFDBFE' },
  locationText: { color: '#1D4ED8', fontWeight: 'bold', marginLeft: 2, fontSize: 11 },
  
  tabContainer: { flexDirection: 'row', backgroundColor: '#FFF', paddingHorizontal: 10, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  tabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderBottomWidth: 3, borderColor: 'transparent' },
  tabBtnActive: { borderColor: '#2563EB' },
  tabText: { fontSize: 14, fontWeight: '700', color: '#64748B' },
  tabTextActive: { color: '#2563EB' },

  searchSortRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 10, paddingTop: 10, gap: 10 },
  sortGroup: { flexDirection: 'row', alignItems: 'center' },
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0', elevation: 1 },
  toolbarBtnText: { fontSize: 13, color: '#475569', marginLeft: 6, fontWeight: '700' },
  activeSearchContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 8, borderWidth: 1, borderColor: '#2563EB', elevation: 1 },
  searchInput: { flex: 1, paddingVertical: 10, paddingHorizontal: 10, fontSize: 14 },

  ulbHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F1F5F9', padding: 12, borderRadius: 8, marginTop: 15, marginBottom: 5, borderWidth: 1, borderColor: '#E2E8F0' },
  ulbHeaderText: { fontSize: 14, fontWeight: 'bold', color: '#334155', flexShrink: 1 },
  ulbCountBadge: { fontSize: 12, color: '#2563EB', fontWeight: 'bold', backgroundColor: '#DBEAFE', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, marginLeft: 10 },
  
  card: { backgroundColor: '#FFF', borderRadius: 12, padding: 12, marginBottom: 10, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, borderWidth: 1, borderColor: '#F1F5F9' },
  visitedCard: { borderColor: '#10B981', borderWidth: 1.5, backgroundColor: '#F0FDF4' },
  plannedCard: { borderColor: '#F59E0B', borderWidth: 1.5, backgroundColor: '#FFFBEB' },
  visitedBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#DCFCE7', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginLeft: 8 },
  visitedBadgeText: { fontSize: 10, fontWeight: 'bold', color: '#15803D' },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardId: { color: '#2563EB', fontWeight: 'bold', fontSize: 13 },
  progressBadge: { fontSize: 12, fontWeight: 'bold', color: '#16A34A', backgroundColor: '#DCFCE7', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  tenderId: { fontSize: 12, color: '#64748B', fontWeight: '600', marginBottom: 2 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#1E293B', marginBottom: 4, lineHeight: 22 },
  cardBottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', borderTopWidth: 1, borderColor: '#F1F5F9', paddingTop: 8 },
  cardType: { fontSize: 11, color: '#94A3B8', fontWeight: '700', textTransform: 'uppercase', flex: 1, paddingRight: 10 },
  
  actionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
  actionBtnLabel: { fontSize: 11, fontWeight: 'bold', marginLeft: 4 },
  pinBtnRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 10, width: '100%' },
  pinBtnHalf: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, elevation: 1 },
  pinBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },

  emptyText: { textAlign: 'center', marginTop: 40, color: '#94A3B8', fontSize: 14 },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%', paddingBottom: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  modalItem: { padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  modalItemText: { fontSize: 16, color: '#334155' }
});