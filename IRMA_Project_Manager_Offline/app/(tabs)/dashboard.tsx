import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput, Keyboard, Alert, Share, Modal, TouchableWithoutFeedback, ScrollView } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { zip } from 'react-native-zip-archive';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../utils/firebaseConfig';
import { generateCloudLinkAndUpload } from '../../utils/cloudUploader';
import { globalStyles } from '../../styles/globalStyles';
import { getProjectsWithLocalKmls } from '../../utils/locationHelpers';

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const getShortSortName = (val: string) => {
  const map: Record<string, string> = { 
    'Date-Time': 'Time', 
    'Project Title': 'Title', 
    'Project ID': 'PR ID', 
    'Tender ID': 'TD ID', 
    'Number of Files': 'Files' 
  };
  return map[val] || val;
};

type SortOption = 'Date-Time' | 'Project Title' | 'Project ID' | 'Tender ID' | 'Number of Files';

export default function DashboardTab() {
  const router = useRouter();
  const sqlDb = SQLite.useSQLiteContext();
  const flatListRef = useRef<FlatList>(null);

  const [loading, setLoading] = useState(true);
  const [recentProjects, setRecentProjects] = useState<any[]>([]);
  const [kmlProjects, setKmlProjects] = useState<Set<string>>(new Set());
  
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [search, setSearch] = useState('');
  
  const [sortBy, setSortBy] = useState<SortOption>('Date-Time');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [activeModal, setActiveModal] = useState<{type: 'sort', options: string[], title: string} | null>(null);
  
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isProcessingAction, setIsProcessingAction] = useState(false);
  const [bulkExportStatus, setBulkExportStatus] = useState('');

  const sortOptions: SortOption[] = ['Date-Time', 'Project Title', 'Project ID', 'Tender ID', 'Number of Files'];

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
    
    let mediaStats = { photos: 0, vids: 0, audio: 0, text: 0, docs: 0, geo: 0, kmls: 0 };
    
    const traverse = async (currentPath: string, parentDir: string = '') => {
      const files = await FileSystem.readDirectoryAsync(currentPath).catch(() => []);
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
          await traverse(`${fullPath}/`, file);
        } else {
          totalSize += info.size || 0; 
          totalFiles++;
          if (info.modificationTime && info.modificationTime > maxModTime) maxModTime = info.modificationTime;
          
          if (!file.endsWith('.json')) {
            const lowerFile = file.toLowerCase();
            const ext = lowerFile.split('.').pop() || '';
            const normalizedParent = parentDir.toLowerCase();
            
            if (lowerFile.endsWith('.kml')) {
               mediaStats.kmls++; 
            } else if (['txt'].includes(ext)) {
               mediaStats.text++;
            } else if (['m4a', 'wav', 'mp3'].includes(ext)) {
               mediaStats.audio++;
            } else if (['pdf', 'doc', 'docx', 'csv', 'xls', 'xlsx'].includes(ext)) {
               mediaStats.docs++;
            } else if (['mp4', 'mov'].includes(ext)) {
               mediaStats.vids++;
            } else if (['jpg', 'png', 'jpeg'].includes(ext)) {
               if (normalizedParent.includes('geotag')) {
                  mediaStats.geo++;
               } else {
                  mediaStats.photos++;
               }
            } else {
               if (normalizedParent.includes('attachment') || normalizedParent.includes('document')) {
                  mediaStats.docs++;
               }
            }
          }
        }
      }
    };

    await traverse(baseProjDir);
    const uniqueDates = [...new Set(dates)].sort((a,b) => b.localeCompare(a));
    return { uniqueDates, totalSize, totalFiles, maxModTime, mediaStats };
  };

  const loadRecentProjects = async (isMounted: boolean) => {
    setLoading(true);
    try {
      const kmls = await getProjectsWithLocalKmls();
      if (isMounted) setKmlProjects(kmls);

      const baseUri = `${FileSystem.documentDirectory}projects/`;
      const dirInfo = await FileSystem.getInfoAsync(baseUri);
      if (!dirInfo.exists) { if (isMounted) { setRecentProjects([]); setLoading(false); } return; }

      const activeFolders = await FileSystem.readDirectoryAsync(baseUri);
      if (activeFolders.length === 0) { if (isMounted) { setRecentProjects([]); setLoading(false); } return; }

      const allTenders = await sqlDb.getAllAsync("SELECT * FROM tenders") as any[];
      const activeTenders = [];

      for (const t of allTenders) {
         const expectedFolder = `${t.project_id}_${t.tender_id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
         if (activeFolders.includes(expectedFolder)) {
            const meta = await getFolderDatesAndSize(expectedFolder);
            if (meta.uniqueDates.length > 0 && meta.totalFiles > 0) {
               activeTenders.push({ 
                 ...t, folderName: expectedFolder, visitDates: meta.uniqueDates, 
                 latestDate: meta.uniqueDates[0], totalSize: meta.totalSize,
                 totalFiles: meta.totalFiles, maxModTime: meta.maxModTime,
                 mediaStats: meta.mediaStats
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

  // Dedicated logic to find the absolute newest KML in a dynamic directory structure
  const handleShareLatestKml = async (folderName: string) => {
    try {
      const baseProjDir = `${FileSystem.documentDirectory}projects/${folderName}/`;
      let latestKmlUri = '';
      let latestTime = 0;

      const findLatestKml = async (currentPath: string) => {
        const files = await FileSystem.readDirectoryAsync(currentPath).catch(() => []);
        for (const file of files) {
          const fullPath = `${currentPath}${file}`;
          const info = await FileSystem.getInfoAsync(fullPath);
          if (info.isDirectory) {
            await findLatestKml(`${fullPath}/`);
          } else if (file.toLowerCase().endsWith('.kml')) {
            if (info.modificationTime && info.modificationTime > latestTime) {
              latestTime = info.modificationTime;
              latestKmlUri = fullPath;
            }
          }
        }
      };

      await findLatestKml(baseProjDir);

      if (latestKmlUri) {
        await Sharing.shareAsync(latestKmlUri, { dialogTitle: 'Share Project Location (KML)' });
      } else {
        Alert.alert("Not Found", "No KML file found for this project.");
      }
    } catch (e) {
      Alert.alert("Error", "Could not share KML file.");
    }
  };

  const processedData = useMemo(() => {
    let filtered = recentProjects.filter(p => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (p.project_title || '').toLowerCase().includes(q) || (p.project_id || '').toLowerCase().includes(q) || (p.ulb || '').toLowerCase().includes(q);
    });

    if (sortBy === 'Project ID') filtered.sort((a, b) => sortOrder === 'asc' ? a.project_id.localeCompare(b.project_id) : b.project_id.localeCompare(a.project_id));
    else if (sortBy === 'Tender ID') filtered.sort((a, b) => sortOrder === 'asc' ? a.tender_id.localeCompare(b.tender_id) : b.tender_id.localeCompare(a.tender_id));
    else if (sortBy === 'Project Title') filtered.sort((a, b) => sortOrder === 'asc' ? (a.project_title||'').localeCompare(b.project_title||'') : (b.project_title||'').localeCompare(a.project_title||''));
    else if (sortBy === 'Number of Files') filtered.sort((a, b) => sortOrder === 'asc' ? a.totalFiles - b.totalFiles : b.totalFiles - a.totalFiles);
    else if (sortBy === 'Date-Time') {
      filtered.sort((a, b) => {
        const dateCmp = sortOrder === 'asc' ? a.latestDate.localeCompare(b.latestDate) : b.latestDate.localeCompare(a.latestDate);
        if (dateCmp !== 0) return dateCmp;
        return sortOrder === 'asc' ? a.maxModTime - b.maxModTime : b.maxModTime - a.maxModTime;
      });
    }

    if (sortBy === 'Date-Time') {
      const dateStatsMap: Record<string, any> = {};
      
      filtered.forEach(p => {
         if (!dateStatsMap[p.latestDate]) {
            dateStatsMap[p.latestDate] = { photos: 0, vids: 0, audio: 0, text: 0, docs: 0, geo: 0, kmls: 0 };
         }
         const st = dateStatsMap[p.latestDate];
         st.photos += p.mediaStats?.photos || 0;
         st.vids += p.mediaStats?.vids || 0;
         st.audio += p.mediaStats?.audio || 0;
         st.text += p.mediaStats?.text || 0;
         st.docs += p.mediaStats?.docs || 0;
         st.geo += p.mediaStats?.geo || 0;
         st.kmls += p.mediaStats?.kmls || 0;
      });

      const finalData: any[] = [];
      let currentDate = '';
      
      filtered.forEach(p => {
         if (p.latestDate !== currentDate) {
            currentDate = p.latestDate;
            finalData.push({ 
               isHeader: true, 
               date: currentDate, 
               id: `header_${currentDate}`, 
               stats: dateStatsMap[currentDate] 
            });
         }
         finalData.push({ ...p, isHeader: false, id: p.folderName });
      });
      
      return finalData;
    }
    
    return filtered.map(p => ({ ...p, isHeader: false, id: p.folderName }));
  }, [recentProjects, search, sortBy, sortOrder]);

  const totalSelectedBytes = useMemo(() => {
    return recentProjects.filter(p => selectedIds.has(p.folderName)).reduce((acc, curr) => acc + curr.totalSize, 0);
  }, [selectedIds, recentProjects]);

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
    if (sortOptions.includes(selection as SortOption)) {
      setSortBy(selection as SortOption); setSortOrder('asc');
    }
    setActiveModal(null);
  };

  const handleBulkDelete = () => {
    Alert.alert("Erase Media Files?", "This will permanently delete photos, videos, and notes, but will retain location pins (KML) and metadata.", [
      { text: "Cancel", style: "cancel" },
      { text: "Erase Media", style: "destructive", onPress: async () => {
          setIsProcessingAction(true);
          try {
            for (const folder of Array.from(selectedIds)) {
               const folderPath = `${FileSystem.documentDirectory}projects/${folder}/`;
               
               const traverseAndDeleteMedia = async (currentPath: string) => {
                  const files = await FileSystem.readDirectoryAsync(currentPath);
                  for (const file of files) {
                     const fullPath = `${currentPath}${file}`;
                     const info = await FileSystem.getInfoAsync(fullPath);
                     
                     if (info.isDirectory) {
                        await traverseAndDeleteMedia(`${fullPath}/`);
                     } else {
                        const lowerFile = file.toLowerCase();
                        if (!lowerFile.endsWith('.json') && !lowerFile.endsWith('.kml')) {
                           await FileSystem.deleteAsync(fullPath, { idempotent: true });
                        }
                     }
                  }
               };
               
               await traverseAndDeleteMedia(folderPath);
            }
            setSelectedIds(new Set()); setIsSelectionMode(false); loadRecentProjects(true);
          } catch(e) { Alert.alert("Error", "Could not cleanly delete all media files."); }
          setIsProcessingAction(false);
      }}
    ]);
  };

  const handleBulkShare = async () => {
    const selectedData = recentProjects.filter(p => selectedIds.has(p.folderName));
    const totalBytes = selectedData.reduce((acc, curr) => acc + curr.totalSize, 0);
    const totalFiles = selectedData.reduce((acc, curr) => acc + curr.totalFiles, 0);
    
    let exportName = `Export_${Date.now()}`;
    
    if (selectedIds.size === 1) {
       exportName = selectedData[0].folderName;
    } else {
       const allSelectedDates = selectedData.flatMap(p => p.visitDates).sort();
       if (allSelectedDates.length > 0) {
         const minDate = allSelectedDates[0].replace(/-/g, '');
         const maxDate = allSelectedDates[allSelectedDates.length - 1].replace(/-/g, '');
         exportName = minDate === maxDate ? `Projects_${minDate}` : `Projects_${minDate}_to_${maxDate}`;
       }
    }

    Alert.alert("Share Selected Projects", `Sharing ${selectedIds.size} project(s).\nTotal Size: ~${formatBytes(totalBytes)}`, [
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
        
        let uName = 'AnonymousUser';
        try {
          const sessionStr = await SecureStore.getItemAsync('irma_device_auth_session');
          if (sessionStr) {
            const parsedSession = JSON.parse(sessionStr);
            const userSnap = await getDoc(doc(db, 'users', parsedSession.userId));
            if (userSnap.exists() && userSnap.data().username) {
              uName = userSnap.data().username;
            } else {
              uName = parsedSession.userId;
            }
          }
        } catch (e) {}

        const { expectedUrl, startBackgroundUpload } = await generateCloudLinkAndUpload(exportName, stagingPath, uName, currentMeta, (status) => {
           setBulkExportStatus(status);
        });
        
        const projectList = Array.from(selectedIds).map(id => `- ${id}`).join('\n');
        
        await Share.share({ message: `Project Export Link:\n${expectedUrl}\n\nProjects Included:\n${projectList}\n\nNote: The link might take a minute to activate while files upload.` });
        
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
      Alert.alert("Export Failed", "Failed to package projects.");
      setIsProcessingAction(false); setBulkExportStatus('');
    }
  };

  const renderItem = ({ item }: { item: any }) => {
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
           <View style={styles.dateHeader}>
             <Text style={styles.dateHeaderText}>{dayStr}, {dd}-{mm}-{yyyy}</Text>
           </View>
           
           <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginLeft: 10, flex: 1 }} contentContainerStyle={{ alignItems: 'center', gap: 10 }}>
              {item.stats.geo > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📍 {item.stats.geo} GeoTagIMG</Text>}
              {item.stats.photos > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📸 {item.stats.photos} Image</Text>}
              {item.stats.vids > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📹 {item.stats.vids} Videos</Text>}
              {item.stats.text > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📝 {item.stats.text} Notes</Text>}
              {item.stats.audio > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>🎙️ {item.stats.audio} Voice</Text>}
              {item.stats.kmls > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>🌍 {item.stats.kmls} KML</Text>}
              {item.stats.docs > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📎 {item.stats.docs} Docs</Text>}
           </ScrollView>
         </View>
       );
    }

    const isSelected = selectedIds.has(item.folderName);
    
    // Validates whether the button should show, prioritizing the deep-scan over the legacy function
    const hasKml = kmlProjects.has(item.folderName) || (item.mediaStats?.kmls > 0);
    
    const exactTime = new Date(item.maxModTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return (
      <TouchableOpacity 
        style={[globalStyles.card, isSelectionMode && isSelected && styles.cardSelected]} 
        activeOpacity={0.7} 
        onLongPress={() => { setIsSelectionMode(true); toggleSelection(item.folderName); }}
        onPress={() => {
          if (isSelectionMode) toggleSelection(item.folderName);
          else router.push(`/project/${encodeURIComponent(item.project_id)}?tender_id=${encodeURIComponent(item.tender_id || 'UNKNOWN')}` as any);
        }}
      >
        <View style={styles.cardHeader}>
          {isSelectionMode && <Ionicons name={isSelected ? "checkbox" : "square-outline"} size={22} color={isSelected ? "#2563EB" : "#94A3B8"} style={{marginRight: 10}} />}
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="folder-open" size={18} color="#2563EB" style={{marginRight: 6}} />
            <Text style={globalStyles.cardTitle}>{item.project_id}</Text>
          </View>
          <Text style={{fontSize: 11, color: '#94A3B8', fontWeight: 'bold'}}>{exactTime}</Text>
        </View>

        <Text style={[globalStyles.cardTitle, { color: '#334155', marginBottom: 10 }]}>{item.project_title}</Text>
        
        <View style={[styles.dovContainer, { marginBottom: 12 }]}>
          <Ionicons name="calendar" size={12} color="#059669" style={{marginRight: 4}} />
          <Text style={styles.dovText}>Visited: {item.visitDates.map((d:string) => { const [y,m,day]=d.split('-'); return `${day}-${m}-${y}`; }).join(', ')}</Text>
        </View>

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
               onPress={() => handleShareLatestKml(item.folderName)}
             >
               <Ionicons name="earth" size={16} color="white" />
               <Text style={globalStyles.locateBtnText}>Locate-KML</Text>
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
                <Text style={styles.toolbarBtnText}>{getShortSortName(sortBy)}</Text>
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