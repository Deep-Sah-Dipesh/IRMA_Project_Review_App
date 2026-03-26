import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput, Keyboard, Alert, Share, Modal, TouchableWithoutFeedback } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { zip } from 'react-native-zip-archive';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { generateCloudLinkAndUpload } from '../../utils/cloudUploader';
import { globalStyles } from '../../styles/globalStyles';
import { shareLocalKml, getProjectsWithLocalKmls } from '../../utils/locationHelpers';

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export default function DashboardTab() {
  const router = useRouter();
  const db = SQLite.useSQLiteContext();
  const flatListRef = useRef<FlatList>(null);

  const [loading, setLoading] = useState(true);
  const [recentProjects, setRecentProjects] = useState<any[]>([]);
  
  // NEW: State to track which folders contain KML files
  const [kmlProjects, setKmlProjects] = useState<Set<string>>(new Set());
  
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'Date' | 'Project ID' | 'Tender ID'>('Date');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [activeModal, setActiveModal] = useState<{type: 'sort', options: string[], title: string} | null>(null);
  
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isProcessingAction, setIsProcessingAction] = useState(false);
  const [bulkExportStatus, setBulkExportStatus] = useState('');

  const sortOptions = ['Date', 'Project ID', 'Tender ID'];

  // Refresh data every time the tab gains focus
  useFocusEffect(
    useCallback(() => {
      let isMounted = true;
      loadRecentProjects(isMounted);
      return () => { isMounted = false; };
    }, [])
  );

  const getFolderDatesAndSize = async (folderName: string) => {
    let totalSize = 0, totalFiles = 0, maxModTime = 0;
    const dates: string[] = [];
    const baseProjDir = `${FileSystem.documentDirectory}projects/${folderName}/`;
    
    const traverse = async (currentPath: string) => {
      const files = await FileSystem.readDirectoryAsync(currentPath);
      for (const file of files) {
        const fullPath = `${currentPath}${file}`;
        const info = await FileSystem.getInfoAsync(fullPath);
        if (info.isDirectory) {
          if (file.startsWith('VISIT_')) {
            const parts = file.split('_');
            if (parts.length >= 3) {
              const d = parts[2];
              if (d.length === 8) dates.push(`${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`);
            }
          }
          await traverse(`${fullPath}/`);
        } else {
          totalSize += info.size || 0; totalFiles++;
          if (info.modificationTime && info.modificationTime > maxModTime) maxModTime = info.modificationTime;
        }
      }
    };

    await traverse(baseProjDir);
    const uniqueDates = [...new Set(dates)].sort((a,b) => b.localeCompare(a));
    return { uniqueDates, totalSize, totalFiles, maxModTime };
  };

  const loadRecentProjects = async (isMounted: boolean) => {
    setLoading(true);
    try {
      // Fetch KML presence locally alongside project loads
      const kmls = await getProjectsWithLocalKmls();
      if (isMounted) setKmlProjects(kmls);

      const baseUri = `${FileSystem.documentDirectory}projects/`;
      const dirInfo = await FileSystem.getInfoAsync(baseUri);
      if (!dirInfo.exists) { if (isMounted) { setRecentProjects([]); setLoading(false); } return; }

      const activeFolders = await FileSystem.readDirectoryAsync(baseUri);
      if (activeFolders.length === 0) { if (isMounted) { setRecentProjects([]); setLoading(false); } return; }

      const allTenders = await db.getAllAsync("SELECT * FROM tenders") as any[];
      const activeTenders = [];

      for (const t of allTenders) {
         const expectedFolder = `${t.project_id}_${t.tender_id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
         if (activeFolders.includes(expectedFolder)) {
            const meta = await getFolderDatesAndSize(expectedFolder);
            if (meta.uniqueDates.length > 0 && meta.totalFiles > 0) {
               activeTenders.push({ 
                 ...t, folderName: expectedFolder, visitDates: meta.uniqueDates, 
                 latestDate: meta.uniqueDates[0], totalSize: meta.totalSize,
                 totalFiles: meta.totalFiles, maxModTime: meta.maxModTime
               });
            }
         }
      }

      if (isMounted) { setRecentProjects(activeTenders); setSelectedIds(new Set()); setIsSelectionMode(false); }
    } catch (e) {
      console.error(e);
    } finally {
      if (isMounted) setLoading(false);
    }
  };

  // Complex Sort/Group logic for the UI FlatList
  const processedData = useMemo(() => {
    let filtered = recentProjects.filter(p => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (p.project_title || '').toLowerCase().includes(q) || (p.project_id || '').toLowerCase().includes(q) || (p.ulb || '').toLowerCase().includes(q);
    });

    if (sortBy === 'Project ID') filtered.sort((a, b) => sortOrder === 'asc' ? a.project_id.localeCompare(b.project_id) : b.project_id.localeCompare(a.project_id));
    else if (sortBy === 'Tender ID') filtered.sort((a, b) => sortOrder === 'asc' ? a.tender_id.localeCompare(b.tender_id) : b.tender_id.localeCompare(a.tender_id));
    else filtered.sort((a, b) => sortOrder === 'asc' ? a.latestDate.localeCompare(b.latestDate) : b.latestDate.localeCompare(a.latestDate));

    if (sortBy === 'Date') {
      const grouped = [];
      let currentDate = '';
      filtered.forEach(p => {
         if (p.latestDate !== currentDate) {
            grouped.push({ isHeader: true, date: p.latestDate, id: `header_${p.latestDate}` });
            currentDate = p.latestDate;
         }
         grouped.push({ ...p, isHeader: false, id: p.folderName });
      });
      return grouped;
    }
    return filtered.map(p => ({ ...p, isHeader: false, id: p.folderName }));
  }, [recentProjects, search, sortBy, sortOrder]);

  const totalSelectedBytes = useMemo(() => {
    return recentProjects.filter(p => selectedIds.has(p.folderName)).reduce((acc, curr) => acc + curr.totalSize, 0);
  }, [selectedIds, recentProjects]);

  // Checkbox interactions
  const toggleSelection = (folderName: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(folderName)) newSet.delete(folderName);
    else newSet.add(folderName);
    setSelectedIds(newSet);
  };

  const isDateFullySelected = (date: string) => {
    const projectsForDate = recentProjects.filter(p => p.latestDate === date);
    if (projectsForDate.length === 0) return false;
    return projectsForDate.every(p => selectedIds.has(p.folderName));
  };

  const toggleDateSelection = (date: string) => {
    const projectsForDate = recentProjects.filter(p => p.latestDate === date);
    const newSet = new Set(selectedIds);
    if (isDateFullySelected(date)) projectsForDate.forEach(p => newSet.delete(p.folderName));
    else projectsForDate.forEach(p => newSet.add(p.folderName));
    setSelectedIds(newSet);
  };

  const handleSelectModal = (selection: string) => {
    if (selection === 'Date' || selection === 'Project ID' || selection === 'Tender ID') {
      setSortBy(selection as any); setSortOrder('asc');
    }
    setActiveModal(null);
  };

  const handleBulkDelete = () => {
    Alert.alert("Erase Selected Projects?", "This will permanently delete all photos, videos, and comments inside these visit folders.", [
      { text: "Cancel", style: "cancel" },
      { text: "Erase Completely", style: "destructive", onPress: async () => {
          setIsProcessingAction(true);
          try {
            for (const folder of Array.from(selectedIds)) {
               await FileSystem.deleteAsync(`${FileSystem.documentDirectory}projects/${folder}/`, { idempotent: true });
            }
            setSelectedIds(new Set()); setIsSelectionMode(false); loadRecentProjects(true);
          } catch(e) { Alert.alert("Error", "Could not delete all files."); }
          setIsProcessingAction(false);
      }}
    ]);
  };

  const handleBulkShare = async () => {
    const selectedData = recentProjects.filter(p => selectedIds.has(p.folderName));
    const totalBytes = selectedData.reduce((acc, curr) => acc + curr.totalSize, 0);
    const totalFiles = selectedData.reduce((acc, curr) => acc + curr.totalFiles, 0);
    
    const allSelectedDates = selectedData.flatMap(p => p.visitDates).sort();
    let exportName = `Export_${Date.now()}`;
    if (allSelectedDates.length > 0) {
      const minDate = allSelectedDates[0].replace(/-/g, '');
      const maxDate = allSelectedDates[allSelectedDates.length - 1].replace(/-/g, '');
      exportName = minDate === maxDate ? `Export_${minDate}` : `Export_${minDate}_to_${maxDate}`;
    }

    Alert.alert("Share Multiple Projects", `You selected ${selectedIds.size} projects.\nTotal Size: ~${formatBytes(totalBytes)}`, [
      { text: "Cancel", style: "cancel" },
      { text: "Share as Link (Cloud)", onPress: () => executeBulkShare('link', exportName, totalBytes, totalFiles) },
      { text: "Share as ZIP (Local)", onPress: () => executeBulkShare('local', exportName, totalBytes, totalFiles) }
    ]);
  };

  const executeBulkShare = async (type: 'link' | 'local', exportName: string, totalSize: number, totalFiles: number) => {
    setIsProcessingAction(true); setBulkExportStatus('Preparing files...');
    const stagingPath = `${FileSystem.cacheDirectory}staging_${exportName}/`;
    
    try {
      await FileSystem.makeDirectoryAsync(stagingPath, { intermediates: true });
      for (const folder of Array.from(selectedIds)) {
        await FileSystem.copyAsync({ from: `${FileSystem.documentDirectory}projects/${folder}/`, to: `${stagingPath}${folder}/` });
      }

      if (type === 'link') {
        const currentMeta = { totalFiles, totalSize, maxModTime: Date.now() };
        const { expectedUrl, startBackgroundUpload } = await generateCloudLinkAndUpload(exportName, stagingPath, currentMeta, (status) => {
           setBulkExportStatus(status);
        });
        
        await Share.share({ message: `Multi-Project Export (${selectedIds.size} Projects):\n${expectedUrl}\n\nNote: The link might not be fully ready until the files are uploaded completely by the sender.` });
        
        startBackgroundUpload().finally(async () => {
          await FileSystem.deleteAsync(stagingPath, { idempotent: true });
          setIsProcessingAction(false); setBulkExportStatus('');
        });
      } else {
        setBulkExportStatus('Compressing directory...\nThis may take a while depending on the total size.');
        const targetZip = `${FileSystem.cacheDirectory}${exportName}.zip`;
        setTimeout(async () => {
          try {
            await zip(stagingPath, targetZip);
            await Sharing.shareAsync(targetZip);
          } finally {
            await FileSystem.deleteAsync(stagingPath, { idempotent: true });
            setIsProcessingAction(false); setBulkExportStatus('');
          }
        }, 300);
      }
    } catch (e) {
      await FileSystem.deleteAsync(stagingPath, { idempotent: true }).catch(() => {});
      Alert.alert("Export Failed", "Failed to package multiple projects.");
      setIsProcessingAction(false); setBulkExportStatus('');
    }
  };

  const renderItem = ({ item }: { item: any }) => {
    // Render Header (Grouped by Date)
    if (item.isHeader) {
       const [yyyy, mm, dd] = item.date.split('-');
       const dObj = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
       const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
       const dayStr = days[dObj.getDay()];

       return (
         <View style={styles.dateHeaderContainer}>
           {isSelectionMode && (
             <TouchableOpacity style={{ padding: 10, marginRight: 5 }} onPress={() => toggleDateSelection(item.date)}>
               <Ionicons name={isDateFullySelected(item.date) ? "checkbox" : "square-outline"} size={22} color={isDateFullySelected(item.date) ? "#2563EB" : "#94A3B8"} />
             </TouchableOpacity>
           )}
           <View style={styles.dateHeader}><Text style={styles.dateHeaderText}>{dayStr}, {dd}-{mm}-{yyyy}</Text></View>
         </View>
       );
    }

    const isSelected = selectedIds.has(item.folderName);
    const hasKml = kmlProjects.has(item.folderName);

    return (
      <TouchableOpacity 
        style={[globalStyles.card, isSelectionMode && isSelected && styles.cardSelected]} 
        activeOpacity={0.7} 
        onLongPress={() => { setIsSelectionMode(true); toggleSelection(item.folderName); }}
        onPress={() => {
          if (isSelectionMode) toggleSelection(item.folderName);
          else router.push({ pathname: '/project/[id]', params: { id: item.project_id, tender_id: item.tender_id || 'UNKNOWN' } });
        }}
      >
        <View style={styles.cardHeader}>
          {isSelectionMode && <Ionicons name={isSelected ? "checkbox" : "square-outline"} size={22} color={isSelected ? "#2563EB" : "#94A3B8"} style={{marginRight: 10}} />}
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="folder-open" size={18} color="#2563EB" style={{marginRight: 6}} />
            <Text style={globalStyles.cardTitle}>{item.project_id}</Text>
          </View>
        </View>

        <Text style={[globalStyles.cardTitle, { color: '#334155', marginBottom: 10 }]}>{item.project_title}</Text>
        
        {/* DOV Swapped Up */}
        <View style={[styles.dovContainer, { marginBottom: 12 }]}>
          <Ionicons name="calendar" size={12} color="#059669" style={{marginRight: 4}} />
          <Text style={styles.dovText}>Visited: {item.visitDates.map((d:string) => { const [y,m,day]=d.split('-'); return `${day}-${m}-${y}`; }).join(', ')}</Text>
        </View>

        {/* Location/Tender info row & Green KML Button */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderColor: '#F1F5F9', paddingTop: 10 }}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
              <Ionicons name="location-outline" size={14} color="#64748B" />
              <Text style={globalStyles.textMuted} numberOfLines={1}> {item.ulb}, {item.state}</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="document-text-outline" size={14} color="#64748B" />
              <Text style={globalStyles.textMuted} numberOfLines={1}> Tender: {item.tender_id || 'N/A'}</Text>
            </View>
          </View>

          {hasKml && (
             <TouchableOpacity 
               style={[globalStyles.locateGreenBtn, { flex: 0, paddingHorizontal: 12, paddingVertical: 8 }]} 
               onPress={() => shareLocalKml(item.project_id, item.tender_id)}
             >
               <Ionicons name="earth" size={16} color="white" />
               <Text style={globalStyles.locateBtnText}>KML</Text>
             </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) return <View style={styles.centerLoading}><ActivityIndicator size="large" color="#2563EB" /><Text style={{marginTop: 10, color: '#64748B'}}>Scanning local workspace...</Text></View>;

  return (
    <View style={globalStyles.container}>
      <View style={styles.header}>
        {/* ROW 1: Titles & Select Button aligned to Top Right */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <Text style={styles.title}>Dashboard</Text>
            <Text style={styles.subTitle}>Recently visited/reported projects</Text>
          </View>
          <TouchableOpacity 
             style={[styles.toolbarBtn, isSelectionMode ? { backgroundColor: '#FEE2E2', borderColor: '#FECACA' } : { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }]} 
             onPress={() => { setIsSelectionMode(!isSelectionMode); setSelectedIds(new Set()); }}
          >
             <Ionicons name={isSelectionMode ? "close" : "checkbox-outline"} size={16} color={isSelectionMode ? "#EF4444" : "#2563EB"} />
             <Text style={[styles.toolbarBtnText, isSelectionMode ? { color: '#EF4444' } : { color: '#2563EB' }]}>{isSelectionMode ? 'Cancel' : 'Select Projects'}</Text>
          </TouchableOpacity>
        </View>

        {/* ROW 2: Dynamic Search & Sort */}
        <View style={styles.searchSortRow}>
          {isSearchActive ? (
            <View style={styles.activeSearchContainer}>
              <Ionicons name="search" size={18} color="#64748B" style={{ marginLeft: 10 }} />
              <TextInput placeholder="Search ID, Title..." style={styles.searchInput} value={search} onChangeText={setSearch} autoFocus />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')} style={{ padding: 5 }}><Ionicons name="close-circle" size={18} color="#94A3B8" /></TouchableOpacity>
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
              <TouchableOpacity style={[styles.toolbarBtn, { borderTopRightRadius: 0, borderBottomRightRadius: 0, marginRight: 0 }]} onPress={() => setActiveModal({ type: 'sort', options: sortOptions, title: 'Sort Projects By' })}>
                <Ionicons name="swap-vertical" size={16} color="#475569" />
                <Text style={styles.toolbarBtnText}>{sortBy}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.toolbarBtn, { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingHorizontal: 6, marginLeft: 1 }]} onPress={() => setSortOrder(p => p === 'asc' ? 'desc' : 'asc')}>
                <Ionicons name={sortOrder === 'asc' ? 'arrow-up' : 'arrow-down'} size={16} color="#2563EB" />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      <FlatList 
        ref={flatListRef}
        data={processedData}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 15, paddingBottom: 100 }}
        onScroll={(e) => setShowScrollTop(e.nativeEvent.contentOffset.y > 300)}
        scrollEventThrottle={16}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Ionicons name="documents-outline" size={64} color="#CBD5E1" />
            <Text style={styles.emptyText}>No Active Projects</Text>
            <Text style={styles.emptySubText}>Visit the Projects tab and create reports to see them here.</Text>
          </View>
        }
      />

      {isSelectionMode && (
         <View style={styles.bulkActionBar}>
            <View style={{ flex: 1 }}>
               <Text style={styles.bulkCount}>{selectedIds.size} Selected</Text>
               <Text style={styles.bulkSize}>~{formatBytes(totalSelectedBytes)}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end', flex: 2 }}>
               <TouchableOpacity style={[styles.bulkBtn, { backgroundColor: '#FEE2E2', paddingHorizontal: 12 }]} onPress={handleBulkDelete} disabled={selectedIds.size === 0}>
                 <Ionicons name="trash" size={18} color="#EF4444" />
               </TouchableOpacity>
               <TouchableOpacity style={[styles.bulkBtn, { backgroundColor: '#2563EB', paddingHorizontal: 20 }]} onPress={handleBulkShare} disabled={selectedIds.size === 0}>
                 <Ionicons name="share-social" size={18} color="#FFF" style={{marginRight: 6}} />
                 <Text style={{ color: '#FFF', fontWeight: 'bold' }}>Share Projects</Text>
               </TouchableOpacity>
            </View>
         </View>
      )}

      {showScrollTop && !isSelectionMode && (
        <TouchableOpacity style={styles.fab} onPress={() => flatListRef.current?.scrollToOffset({ offset: 0, animated: true })}>
          <Ionicons name="arrow-up" size={24} color="#FFF" />
        </TouchableOpacity>
      )}

      {isProcessingAction && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#FFF" />
          <Text style={{color: '#FFF', marginTop: 15, fontWeight: 'bold', textAlign: 'center', paddingHorizontal: 20, lineHeight: 24}}>{bulkExportStatus || 'Processing Folders...'}</Text>
        </View>
      )}

      <Modal visible={!!activeModal} transparent animationType="fade">
        <TouchableWithoutFeedback onPress={() => setActiveModal(null)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>{activeModal?.title}</Text>
                  <TouchableOpacity onPress={() => setActiveModal(null)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
                </View>
                <FlatList data={activeModal?.options} keyExtractor={(item, idx) => `${item}_${idx}`} renderItem={({ item }) => (
                    <TouchableOpacity style={styles.modalItem} onPress={() => handleSelectModal(item)}>
                      <Text style={[styles.modalItemText, sortBy === item && { color: '#2563EB', fontWeight: 'bold' }]}>{item}</Text>
                    </TouchableOpacity>
                )} />
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  centerLoading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: '900', color: '#1E293B' },
  subTitle: { fontSize: 12, color: '#64748B', fontWeight: '600', marginTop: 2 },
  
  searchSortRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 15, gap: 10 },
  sortGroup: { flexDirection: 'row', alignItems: 'center' },
  
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F5F9', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  toolbarBtnText: { fontSize: 13, color: '#475569', marginLeft: 6, fontWeight: '700' },
  
  activeSearchContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  searchInput: { flex: 1, paddingVertical: 8, paddingHorizontal: 10, fontSize: 14 },
  
  dateHeaderContainer: { flexDirection: 'row', alignItems: 'center', marginVertical: 15 },
  dateHeader: { alignItems: 'center' },
  dateHeaderText: { backgroundColor: '#E2E8F0', color: '#475569', fontSize: 12, fontWeight: 'bold', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, overflow: 'hidden' },
  
  cardSelected: { borderColor: '#2563EB', backgroundColor: '#EFF6FF', borderWidth: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  
  dovContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#DCFCE7', alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  dovText: { color: '#065F46', fontSize: 11, fontWeight: 'bold' },
  
  emptyBox: { alignItems: 'center', marginTop: 80 },
  emptyText: { fontSize: 18, fontWeight: 'bold', color: '#475569', marginTop: 15 },
  emptySubText: { fontSize: 14, color: '#94A3B8', textAlign: 'center', marginTop: 8, paddingHorizontal: 20 },
  
  bulkActionBar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#FFF', padding: 20, paddingBottom: 30, borderTopWidth: 1, borderColor: '#E2E8F0', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', elevation: 10 },
  bulkCount: { fontSize: 16, fontWeight: 'bold', color: '#1E293B' },
  bulkSize: { fontSize: 12, color: '#64748B', fontWeight: '600', marginTop: 2 },
  bulkBtn: { flexDirection: 'row', paddingVertical: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  
  fab: { position: 'absolute', bottom: 30, right: 20, backgroundColor: '#2563EB', width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 3 },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 100 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%', paddingBottom: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  modalItem: { padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  modalItemText: { fontSize: 16, color: '#334155' }
});