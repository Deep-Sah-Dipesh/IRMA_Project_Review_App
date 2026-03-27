import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, FlatList, TextInput, StyleSheet, Keyboard, Modal, TouchableWithoutFeedback } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUserStore } from '../../store/userStore';

// Helper for consistent folder names
const getFolderName = (pId: string, tId: string) => {
  const safeId = String(pId).replace(/[\/\\]/g, '-');
  const safeTender = String(tId || 'NoTender').replace(/[\/\\]/g, '-');
  return `${safeId}_${safeTender}`.replace(/[^a-zA-Z0-9_-]/g, '_');
};

type SortOption = 'Project Title' | 'Physical Progress';

export default function PlannerTab() {
  const store = useUserStore();
  const db = SQLite.useSQLiteContext();
  const router = useRouter();
  
  const [activeTab, setActiveTab] = useState<'pending' | 'planning'>('pending');
  const [district, setDistrict] = useState('');
  
  // Dashboard-style Search & Sort State
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('Project Title');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [activeModal, setActiveModal] = useState<{type: 'sort', options: string[], title: string} | null>(null);
  
  const [allProjects, setAllProjects] = useState<any[]>([]);
  const [visitedSet, setVisitedSet] = useState<Set<string>>(new Set());

  // Expand/Collapse State
  const [collapsedPendingUlbs, setCollapsedPendingUlbs] = useState<Set<string>>(new Set());
  const [expandedPlanningUlbs, setExpandedPlanningUlbs] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    const loadProjects = async () => {
      let query = "SELECT * FROM tenders WHERE ulb IS NOT NULL AND ulb != ''";
      let params: string[] = [];
      if (store.selectedState && store.selectedState !== 'All States') {
        query += " AND state = ?"; params.push(store.selectedState);
      }
      if (district) {
        query += " AND district = ?"; params.push(district);
      }
      const res = await db.getAllAsync<any>(query, params);
      setAllProjects(res);
    };
    loadProjects();
  }, [store.selectedState, district]);

  // Reset UI states on tab switch
  useEffect(() => {
    setSearch('');
    setIsSearchActive(false);
  }, [activeTab]);

  const toggleUlb = (ulbName: string) => {
    if (activeTab === 'pending') {
      const newSet = new Set(collapsedPendingUlbs);
      if (newSet.has(ulbName)) newSet.delete(ulbName);
      else newSet.add(ulbName);
      setCollapsedPendingUlbs(newSet);
    } else {
      const newSet = new Set(expandedPlanningUlbs);
      if (newSet.has(ulbName)) newSet.delete(ulbName);
      else newSet.add(ulbName);
      setExpandedPlanningUlbs(newSet);
    }
  };

  const togglePlanState = (proj: any) => {
    const strictId = getFolderName(proj.project_id, proj.tender_id);
    const legacyId = `${proj.project_id}_${proj.tender_id}`;
    
    if (visitedSet.has(strictId)) return;

    const existingItem = store.plannerItems.find(i => i.id === strictId || i.id === legacyId);

    if (existingItem) {
      store.removePlannerItem(existingItem.id);
    } else {
      store.addPlannerItem({
        id: strictId,
        projectId: proj.project_id,
        tenderId: proj.tender_id,
        title: proj.project_title,
        type: proj.project_type,
        progress: proj.physical_progress,
        ulb: proj.ulb
      });
    }
  };

  const handleSelectModal = (selection: string) => {
    setSortBy(selection as SortOption);
    setSortOrder('asc');
    setActiveModal(null);
  };

  const pendingCount = useMemo(() => {
    return store.plannerItems.filter(i => !visitedSet.has(getFolderName(i.projectId, i.tenderId))).length;
  }, [store.plannerItems, visitedSet]);

  // Generate FlatList Data matching Dashboard's grouping style
  const listData = useMemo(() => {
    const q = search.toLowerCase();
    const groups: Record<string, any[]> = {};
    const pendingProjIds = new Set(store.plannerItems.map(i => i.id));

    allProjects.forEach(p => {
      const strictId = getFolderName(p.project_id, p.tender_id);
      const legacyId = `${p.project_id}_${p.tender_id}`;
      const isPending = pendingProjIds.has(strictId) || pendingProjIds.has(legacyId);
      const isVisited = visitedSet.has(strictId);

      // Filtering Logic based on active tab
      let shouldInclude = false;
      if (activeTab === 'pending') {
        shouldInclude = isPending && !isVisited;
      } else {
        shouldInclude = true; // Show all in Plan to Visit
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
      
      // Sort Projects
      projects.sort((a, b) => {
        // Planner specific weighting (Visited bottom, Planned top) only in Planning tab
        if (activeTab === 'planning') {
          const aVisited = visitedSet.has(getFolderName(a.project_id, a.tender_id));
          const bVisited = visitedSet.has(getFolderName(b.project_id, b.tender_id));
          const aPlanned = pendingProjIds.has(getFolderName(a.project_id, a.tender_id)) || pendingProjIds.has(`${a.project_id}_${a.tender_id}`);
          const bPlanned = pendingProjIds.has(getFolderName(b.project_id, b.tender_id)) || pendingProjIds.has(`${b.project_id}_${b.tender_id}`);

          const weightA = aVisited ? 3 : (aPlanned ? 1 : 2);
          const weightB = bVisited ? 3 : (bPlanned ? 1 : 2);
          if (weightA !== weightB) return weightA - weightB;
        }

        // Standard User Selected Sort
        let res = 0;
        if (sortBy === 'Physical Progress') {
          res = (parseFloat(a.physical_progress) || 0) - (parseFloat(b.physical_progress) || 0);
        } else {
          res = (a.project_title || '').localeCompare(b.project_title || '');
        }
        return sortOrder === 'asc' ? res : -res;
      });

      // Push Header
      flattenedData.push({
        isHeader: true,
        id: `header_${ulb}`,
        ulb,
        count: projects.length
      });

      // Push Projects conditionally based on expansion
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
  }, [allProjects, search, sortBy, sortOrder, activeTab, visitedSet, store.plannerItems, collapsedPendingUlbs, expandedPlanningUlbs]);


  const renderItem = ({ item }: { item: any }) => {
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

    const isVisited = visitedSet.has(item.id);
    const isPlanned = store.plannerItems.some(i => i.id === item.id || i.id === `${item.project_id}_${item.tender_id}`);

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
        style={[styles.card, isVisited && activeTab !== 'pending' && { opacity: 0.6 }]}
        activeOpacity={0.7}
        onPress={() => router.push(`/project/${encodeURIComponent(item.project_id)}?tender_id=${encodeURIComponent(item.tender_id || 'UNKNOWN')}` as any)}
      >
        {/* Top Row: Project ID & Progress */}
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardId}>{item.project_id}</Text>
          <Text style={styles.progressBadge}>{item.physical_progress || '0'}%</Text>
        </View>

        {/* Middle: Tender ID & Title */}
        <Text style={styles.tenderId}>Tender: {item.tender_id}</Text>
        <Text style={styles.cardTitle}>{item.project_title}</Text>

        {/* Bottom Row: Type & Action Button */}
        <View style={styles.cardBottomRow}>
          <Text style={styles.cardType}>{item.project_type}</Text>
          
          <TouchableOpacity 
            style={[styles.actionBtn, btnStyle]} 
            onPress={() => togglePlanState(item)}
            disabled={isVisited && activeTab !== 'pending'}
          >
            <Ionicons name={iconName} size={16} color={iconColor} />
            <Text style={[styles.actionBtnLabel, { color: iconColor }]}>{btnLabel}</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{ flex: 1, paddingRight: 10 }}>
          <Text style={styles.title}>Field Visit Planner</Text>
        </View>
        <View style={styles.locationBadge}>
           <Ionicons name="location" size={12} color="#2563EB" />
           <Text style={styles.locationText}>{store.selectedState}</Text>
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

      {/* Dashboard-Style Search and Sort Row */}
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
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  title: { fontSize: 24, fontWeight: '900', color: '#1E293B' },
  locationBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#DBEAFE', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12 },
  locationText: { color: '#1D4ED8', fontWeight: 'bold', marginLeft: 4, fontSize: 12 },
  
  tabContainer: { flexDirection: 'row', backgroundColor: '#FFF', paddingHorizontal: 15, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  tabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 15, borderBottomWidth: 3, borderColor: 'transparent' },
  tabBtnActive: { borderColor: '#2563EB' },
  tabText: { fontSize: 14, fontWeight: '700', color: '#64748B' },
  tabTextActive: { color: '#2563EB' },

  searchSortRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 15, paddingTop: 15, gap: 10 },
  sortGroup: { flexDirection: 'row', alignItems: 'center' },
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0', elevation: 1 },
  toolbarBtnText: { fontSize: 13, color: '#475569', marginLeft: 6, fontWeight: '700' },
  activeSearchContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 8, borderWidth: 1, borderColor: '#2563EB', elevation: 1 },
  searchInput: { flex: 1, paddingVertical: 10, paddingHorizontal: 10, fontSize: 14 },

  ulbHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F1F5F9', padding: 12, borderRadius: 8, marginTop: 15, marginBottom: 5, borderWidth: 1, borderColor: '#E2E8F0' },
  ulbHeaderText: { fontSize: 14, fontWeight: 'bold', color: '#334155', flexShrink: 1 },
  ulbCountBadge: { fontSize: 12, color: '#2563EB', fontWeight: 'bold', backgroundColor: '#DBEAFE', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, marginLeft: 10 },
  
  // Uniform Card Styles
  card: { backgroundColor: '#FFF', borderRadius: 12, padding: 15, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, borderWidth: 1, borderColor: '#F1F5F9' },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardId: { color: '#2563EB', fontWeight: 'bold', fontSize: 13 },
  progressBadge: { fontSize: 12, fontWeight: 'bold', color: '#16A34A', backgroundColor: '#DCFCE7', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  tenderId: { fontSize: 12, color: '#64748B', fontWeight: '600', marginBottom: 2 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#1E293B', marginBottom: 12, lineHeight: 22 },
  cardBottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', borderTopWidth: 1, borderColor: '#F1F5F9', paddingTop: 12 },
  cardType: { fontSize: 11, color: '#94A3B8', fontWeight: '700', textTransform: 'uppercase', flex: 1, paddingRight: 10 },
  
  actionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
  actionBtnLabel: { fontSize: 11, fontWeight: 'bold', marginLeft: 4 },

  emptyText: { textAlign: 'center', marginTop: 40, color: '#94A3B8', fontSize: 14 },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%', paddingBottom: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  modalItem: { padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  modalItemText: { fontSize: 16, color: '#334155' }
});