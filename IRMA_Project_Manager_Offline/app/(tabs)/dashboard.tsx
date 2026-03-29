import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, SectionList, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput, Keyboard, Alert, Share, Modal, TouchableWithoutFeedback, ScrollView } from 'react-native';
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
  const map: Record<string, string> = { 'Date-Time': 'Time', 'Project Title': 'Title', 'Project ID': 'PR ID', 'Tender ID': 'TD ID', 'Number of Files': 'Files' };
  return map[val] || val;
};

type SortOption = 'Date-Time' | 'Project Title' | 'Project ID' | 'Tender ID' | 'Number of Files';

export default function DashboardTab() {
  const router = useRouter();
  const sqlDb = SQLite.useSQLiteContext();
  const sectionListRef = useRef<SectionList>(null);

  const [loading, setLoading] = useState(true);
  const [activeUserId, setActiveUserId] = useState('');
  
  const [recentProjects, setRecentProjects] = useState<any[]>([]);
  const [kmlProjects, setKmlProjects] = useState<Set<string>>(new Set());
  
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [search, setSearch] = useState('');
  
  const [sortBy, setSortBy] = useState<SortOption>('Date-Time');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [activeModal, setActiveModal] = useState<{type: 'sort', options: string[], title: string} | null>(null);
  
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isProcessingAction, setIsProcessingAction] = useState(false);
  const [bulkExportStatus, setBulkExportStatus] = useState('');

  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());

  // Recovery Mode states reset when the component unmounts/app restarts
  const [tapCount, setTapCount] = useState(0);
  const [showPinModal, setShowPinModal] = useState(false);
  const [recoveryPin, setRecoveryPin] = useState('');
  const [isRecoveryMode, setIsRecoveryMode] = useState(false);

  const sortOptions: SortOption[] = ['Date-Time', 'Project Title', 'Project ID', 'Tender ID', 'Number of Files'];

  useFocusEffect(
    useCallback(() => {
      let isMounted = true;
      initLoad(isMounted, isRecoveryMode);
      return () => { isMounted = false; };
    }, [isRecoveryMode])
  );

  const initLoad = async (isMounted: boolean, recovery: boolean) => {
    setLoading(true);
    try {
      const sessionStr = await SecureStore.getItemAsync('irma_device_auth_session');
      if (!sessionStr) throw new Error("No session");
      const parsedSession = JSON.parse(sessionStr);
      let uniqueId = parsedSession.userId; 
      
      try {
        const userSnap = await getDoc(doc(db, 'users', parsedSession.userId));
        if (userSnap.exists() && userSnap.data().uniqueUserId) uniqueId = userSnap.data().uniqueUserId;
      } catch (e) { console.warn("Firestore fetch failed, using cached ID"); }
      
      if (isMounted) setActiveUserId(uniqueId);
      await loadRecentProjects(isMounted, uniqueId, recovery);
    } catch (e) {
      if (isMounted) setLoading(false);
    }
  };

  const getFolderDatesAndSizeDynamic = async (absolutePath: string) => {
    let totalSize = 0, totalFiles = 0, maxModTime = 0;
    const dates: string[] = [];
    let mediaStats = { photos: 0, vids: 0, audio: 0, text: 0, docs: 0, geo: 0, kmls: 0 };
    
    const traverse = async (currentPath: string, parentDir: string = '') => {
      const files = await FileSystem.readDirectoryAsync(currentPath).catch(() => []);
      for (const file of files) {
        const fullPath = `${currentPath}${file}`;
        const info = await FileSystem.getInfoAsync(fullPath).catch(() => null);
        if (!info) continue;
        
        if (info.isDirectory) {
          if (file.startsWith('VISIT_')) {
            const parts = file.split('_');
            if (parts.length >= 3 && parts[2].length === 8) {
              const d = parts[2];
              dates.push(`${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`);
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
            
            if (lowerFile.endsWith('.kml')) mediaStats.kmls++; 
            else if (['txt'].includes(ext)) mediaStats.text++;
            else if (['m4a', 'wav', 'mp3'].includes(ext)) mediaStats.audio++;
            else if (['pdf', 'doc', 'docx', 'csv', 'xls', 'xlsx'].includes(ext)) mediaStats.docs++;
            else if (['mp4', 'mov'].includes(ext)) mediaStats.vids++;
            else if (['jpg', 'png', 'jpeg'].includes(ext)) {
               if (normalizedParent.includes('geotag')) mediaStats.geo++;
               else mediaStats.photos++;
            } else {
               if (normalizedParent.includes('attachment') || normalizedParent.includes('document')) mediaStats.docs++;
            }
          }
        }
      }
    };
    await traverse(absolutePath);
    const uniqueDates = [...new Set(dates)].sort((a,b) => b.localeCompare(a));
    return { uniqueDates, totalSize, totalFiles, maxModTime, mediaStats };
  };

  const loadRecentProjects = async (isMounted: boolean, uniqueId: string, recovery: boolean) => {
    try {
      const kmls = await getProjectsWithLocalKmls().catch(() => new Set());
      if (isMounted) setKmlProjects(kmls);

      let allTenders: any[] = [];
      try { allTenders = await sqlDb.getAllAsync("SELECT * FROM tenders") as any[]; } catch (dbError) {}

      const rootUri = FileSystem.documentDirectory;
      if (!rootUri) return;

      const foundFolders: string[] = [];
      const folderPaths: Record<string, string> = {};
      const combinedProjects = [];
      const cacheFile = `${rootUri}projects/${uniqueId}_meta_cache.json`;

      const baseProjectsDir = `${rootUri}projects/`;
      const userSpecificDir = `${baseProjectsDir}${uniqueId}/`;

      if (recovery) {
         // RECOVERY MODE: Scans root projects directory, IRMA_Projects, and all inner user subdirectories
         const scanTargets = [baseProjectsDir, `${rootUri}IRMA_Projects/`];
         const baseExists = await FileSystem.getInfoAsync(baseProjectsDir).catch(() => ({ exists: false }));
         
         if (baseExists.exists) {
             const subDirs = await FileSystem.readDirectoryAsync(baseProjectsDir).catch(() => []);
             for (const sub of subDirs) {
                 const subPath = `${baseProjectsDir}${sub}/`;
                 const subInfo = await FileSystem.getInfoAsync(subPath).catch(() => ({ isDirectory: false }));
                 if (subInfo.isDirectory && sub !== 'SQLite') scanTargets.push(subPath);
             }
         }

         for (const target of scanTargets) {
             const exists = await FileSystem.getInfoAsync(target).catch(() => ({ exists: false }));
             if (exists.exists) {
                 const items = await FileSystem.readDirectoryAsync(target).catch(() => []);
                 for (const item of items) {
                     const itemPath = `${target}${item}/`;
                     const info = await FileSystem.getInfoAsync(itemPath).catch(() => ({ isDirectory: false }));
                     if (info.isDirectory && !item.startsWith('.') && item.includes('_')) {
                         if (!foundFolders.includes(item)) {
                             foundFolders.push(item);
                             folderPaths[item] = itemPath;
                         }
                     }
                 }
             }
         }
      } else {
         // NORMAL MODE: Strict sandboxing logic - ONLY reads from user's subdirectory
         const exists = await FileSystem.getInfoAsync(userSpecificDir).catch(() => ({ exists: false }));
         if (exists.exists) {
             const items = await FileSystem.readDirectoryAsync(userSpecificDir).catch(() => []);
             for (const item of items) {
                 const itemPath = `${userSpecificDir}${item}/`;
                 const info = await FileSystem.getInfoAsync(itemPath).catch(() => ({ isDirectory: false }));
                 if (info.isDirectory && !item.startsWith('.')) {
                     if (!foundFolders.includes(item)) {
                         foundFolders.push(item);
                         folderPaths[item] = itemPath;
                     }
                 }
             }
         }
      }

      for (const folderName of foundFolders) {
         const exactPath = folderPaths[folderName];
         const meta = await getFolderDatesAndSizeDynamic(exactPath);
         
         if (meta.totalFiles === 0 && meta.totalSize === 0) continue; 

         const matchedTender = allTenders.find(t => {
             const expectedFolder = `${t.project_id}_${t.tender_id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
             return expectedFolder === folderName || folderName.includes(t.project_id);
         });

         // Only push accurately verified projects (Removes the Unverified Projects section entirely)
         if (matchedTender) {
             combinedProjects.push({ 
                ...matchedTender, 
                folderName: folderName,
                exactPath: exactPath,
                visitDates: meta.uniqueDates.length > 0 ? meta.uniqueDates : ['Unknown'],
                latestDate: meta.uniqueDates[0] || 'Unknown',
                totalSize: meta.totalSize,
                totalFiles: meta.totalFiles,
                maxModTime: meta.maxModTime,
                mediaStats: meta.mediaStats 
             });
         }
      }

      if (combinedProjects.length > 0) {
        await FileSystem.writeAsStringAsync(cacheFile, JSON.stringify(combinedProjects));
      } else {
        // Prevents loading cache if the user directory is authentically empty
        const dirExists = await FileSystem.getInfoAsync(userSpecificDir).catch(() => ({ exists: false }));
        if (dirExists.exists) {
            const cacheInfo = await FileSystem.getInfoAsync(cacheFile).catch(() => ({ exists: false }));
            if (cacheInfo.exists) {
              const cachedData = await FileSystem.readAsStringAsync(cacheFile).catch(() => '[]');
              combinedProjects.push(...JSON.parse(cachedData));
            }
        }
      }

      if (isMounted) { 
        setRecentProjects(combinedProjects); 
        setSelectedIds(new Set()); 
        setIsSelectionMode(false); 
        
        if (combinedProjects.length > 0) {
          const sortedDates = [...new Set(combinedProjects.map(p => p.latestDate))].sort((a,b) => b.localeCompare(a));
          if (sortedDates.length > 0) setExpandedDates(new Set([sortedDates[0]]));
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (isMounted) setLoading(false);
    }
  };

  const handleTitleTap = () => {
    setTapCount(prev => {
      if (prev + 1 >= 5) {
        if (isRecoveryMode) {
          setIsRecoveryMode(false);
          Alert.alert("Normal Mode", "Returned to standard personalized dashboard.");
          return 0;
        } else {
          setShowPinModal(true);
          return 0;
        }
      }
      return prev + 1;
    });
  };

  const handlePinSubmit = () => {
    if (recoveryPin === '122333456') {
      setIsRecoveryMode(true);
      setShowPinModal(false);
      setRecoveryPin('');
      Alert.alert("Recovery Mode", "Deep scan activated across all local sandbox directories.");
    } else {
      Alert.alert("Denied", "Incorrect PIN.");
      setShowPinModal(false);
      setRecoveryPin('');
    }
  };

  const toggleSection = (date: string) => {
    setExpandedDates(prev => {
      const newSet = new Set(prev);
      if (newSet.has(date)) newSet.delete(date);
      else newSet.add(date);
      return newSet;
    });
  };

  const processedSections = useMemo(() => {
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
      const sections: any[] = [];
      const dateStatsMap: Record<string, any> = {};
      
      filtered.forEach(p => {
         if (!dateStatsMap[p.latestDate]) dateStatsMap[p.latestDate] = { photos: 0, vids: 0, audio: 0, text: 0, docs: 0, geo: 0, kmls: 0 };
         const st = dateStatsMap[p.latestDate];
         st.photos += p.mediaStats?.photos || 0; st.vids += p.mediaStats?.vids || 0; st.audio += p.mediaStats?.audio || 0;
         st.text += p.mediaStats?.text || 0; st.docs += p.mediaStats?.docs || 0; st.geo += p.mediaStats?.geo || 0; st.kmls += p.mediaStats?.kmls || 0;
      });

      const uniqueDates = [...new Set(filtered.map(p => p.latestDate))];
      uniqueDates.forEach(date => {
         const items = filtered.filter(p => p.latestDate === date);
         sections.push({
           title: date,
           stats: dateStatsMap[date],
           data: expandedDates.has(date) ? items : [], 
           originalData: items 
         });
      });
      return sections;
    }
    
    return [{ title: 'All Projects', stats: null, data: filtered, originalData: filtered }];
  }, [recentProjects, search, sortBy, sortOrder, expandedDates]);

  const totalSelectedBytes = useMemo(() => {
    return recentProjects.filter(p => selectedIds.has(p.folderName)).reduce((acc, curr) => acc + curr.totalSize, 0);
  }, [selectedIds, recentProjects]);

  const toggleSelection = (folderName: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(folderName)) newSet.delete(folderName); else newSet.add(folderName);
    setSelectedIds(newSet);
  };

  const toggleDateSelection = (section: any) => {
    const newSet = new Set(selectedIds);
    const allSelected = section.originalData.every((p: any) => selectedIds.has(p.folderName));
    
    if (allSelected) section.originalData.forEach((p: any) => newSet.delete(p.folderName));
    else section.originalData.forEach((p: any) => newSet.add(p.folderName));
    setSelectedIds(newSet);
  };

  const handleBulkDelete = () => {
    Alert.alert("Erase Media Files?", "This will permanently delete photos, videos, and notes, but will retain location pins (KML) and metadata.", [
      { text: "Cancel", style: "cancel" },
      { text: "Erase Media", style: "destructive", onPress: async () => {
          setIsProcessingAction(true);
          try {
            const selectedData = recentProjects.filter(p => selectedIds.has(p.folderName));
            for (const project of selectedData) {
               const traverseAndDeleteMedia = async (currentPath: string) => {
                  const files = await FileSystem.readDirectoryAsync(currentPath);
                  for (const file of files) {
                     const fullPath = `${currentPath}${file}`;
                     const info = await FileSystem.getInfoAsync(fullPath);
                     if (info.isDirectory) { await traverseAndDeleteMedia(`${fullPath}/`); } 
                     else {
                        const lowerFile = file.toLowerCase();
                        if (!lowerFile.endsWith('.json') && !lowerFile.endsWith('.kml')) { await FileSystem.deleteAsync(fullPath, { idempotent: true }); }
                     }
                  }
               };
               await traverseAndDeleteMedia(project.exactPath);
            }
            setSelectedIds(new Set()); setIsSelectionMode(false); loadRecentProjects(true, activeUserId, isRecoveryMode);
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
    if (selectedIds.size === 1) { exportName = selectedData[0].folderName; } 
    else {
       const allSelectedDates = selectedData.flatMap(p => p.visitDates).sort();
       if (allSelectedDates.length > 0) {
         const minDate = allSelectedDates[0].replace(/-/g, '');
         const maxDate = allSelectedDates[allSelectedDates.length - 1].replace(/-/g, '');
         exportName = minDate === maxDate ? `Projects_${minDate}` : `Projects_${minDate}_to_${maxDate}`;
       }
    }

    Alert.alert("Share Selected Projects", `Sharing ${selectedIds.size} project(s).\nTotal Size: ~${formatBytes(totalBytes)}`, [
      { text: "Cancel", style: "cancel" },
      { text: "Share as Link (Cloud)", onPress: () => executeBulkShare('link', exportName, totalBytes, totalFiles, selectedData) },
      { text: "Share as ZIP (Local)", onPress: () => executeBulkShare('local', exportName, totalBytes, totalFiles, selectedData) }
    ]);
  };

  const executeBulkShare = async (type: 'link' | 'local', exportName: string, totalSize: number, totalFiles: number, selectedData: any[]) => {
    setIsProcessingAction(true); setBulkExportStatus('Preparing files...');
    const stagingPath = `${FileSystem.cacheDirectory}staging_${exportName}/`;
    
    try {
      await FileSystem.makeDirectoryAsync(stagingPath, { intermediates: true });
      for (const project of selectedData) {
        await FileSystem.copyAsync({ from: project.exactPath, to: `${stagingPath}${project.folderName}/` });
      }

      if (type === 'link') {
        const currentMeta = { totalFiles, totalSize, maxModTime: Date.now() };
        let uName = activeUserId || 'AnonymousUser';

        const { expectedUrl, startBackgroundUpload } = await generateCloudLinkAndUpload(exportName, stagingPath, uName, currentMeta, (status) => {
           setBulkExportStatus(status);
        });
        
        const projectList = selectedData.map(p => `- ${p.folderName}`).join('\n');
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

  const handleSaveToDevice = async () => {
    setIsProcessingAction(true);
    setBulkExportStatus('Locating destination folder...');
    try {
      let targetDirUri = await SecureStore.getItemAsync('irma_saf_directory_uri');
      
      if (!targetDirUri) {
          const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
          if (!permissions.granted) {
            setIsProcessingAction(false);
            return;
          }
          targetDirUri = permissions.directoryUri;
          await SecureStore.setItemAsync('irma_saf_directory_uri', targetDirUri);
      }

      setBulkExportStatus('Copying projects...');
      
      // Verification check in case the user revoked the scoped folder permission via OS settings
      try {
          await FileSystem.StorageAccessFramework.readDirectoryAsync(targetDirUri);
      } catch(e) {
          const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
          if (!permissions.granted) { setIsProcessingAction(false); return; }
          targetDirUri = permissions.directoryUri;
          await SecureStore.setItemAsync('irma_saf_directory_uri', targetDirUri);
      }

      const selectedData = recentProjects.filter(p => selectedIds.has(p.folderName));

      // Automated timestamped folder generation avoids identical naming conflicts
      const dateStr = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const exportDirUri = await FileSystem.StorageAccessFramework.makeDirectoryAsync(targetDirUri, `IRMA_Export_${dateStr}`);

      for (const project of selectedData) {
         try {
             const projDirUri = await FileSystem.StorageAccessFramework.makeDirectoryAsync(exportDirUri, project.folderName);
             
             const traverseAndCopy = async (localPath: string, safParentUri: string) => {
                 const files = await FileSystem.readDirectoryAsync(localPath);
                 for (const file of files) {
                     const fullLocalPath = `${localPath}${file}`;
                     const info = await FileSystem.getInfoAsync(fullLocalPath);
                     
                     if (info.isDirectory) {
                         const newSafDirUri = await FileSystem.StorageAccessFramework.makeDirectoryAsync(safParentUri, file);
                         await traverseAndCopy(`${fullLocalPath}/`, newSafDirUri);
                     } else {
                         const content = await FileSystem.readAsStringAsync(fullLocalPath, { encoding: FileSystem.EncodingType.Base64 });
                         let mimeType = 'application/octet-stream';
                         const ext = file.split('.').pop()?.toLowerCase();
                         if(ext==='jpg'||ext==='jpeg') mimeType='image/jpeg';
                         else if(ext==='png') mimeType='image/png';
                         else if(ext==='mp4') mimeType='video/mp4';
                         else if(ext==='json') mimeType='application/json';
                         else if(ext==='txt') mimeType='text/plain';
                         else if(ext==='kml') mimeType='application/vnd.google-earth.kml+xml';
                         
                         const safFileUri = await FileSystem.StorageAccessFramework.createFileAsync(safParentUri, file, mimeType);
                         await FileSystem.writeAsStringAsync(safFileUri, content, { encoding: FileSystem.EncodingType.Base64 });
                     }
                 }
             };
             
             await traverseAndCopy(project.exactPath, projDirUri);
         } catch (projectError) {
             console.error(`Failed to copy project ${project.folderName}`, projectError);
         }
      }
      Alert.alert("Saved Automatically", "Selected projects have been saved outside the sandbox in the chosen folder.");
      setSelectedIds(new Set());
      setIsSelectionMode(false);
    } catch(e) {
      Alert.alert("Error", "Failed to save files to device.");
    }
    setIsProcessingAction(false);
    setBulkExportStatus('');
  };

  const handleShareLatestKml = async (exactPath: string) => {
    try {
      let latestKmlUri = ''; let latestTime = 0;
      const findLatestKml = async (currentPath: string) => {
        const files = await FileSystem.readDirectoryAsync(currentPath).catch(() => []);
        for (const file of files) {
          const fullPath = `${currentPath}${file}`;
          const info = await FileSystem.getInfoAsync(fullPath);
          if (info.isDirectory) { await findLatestKml(`${fullPath}/`); } 
          else if (file.toLowerCase().endsWith('.kml')) {
            if (info.modificationTime && info.modificationTime > latestTime) {
              latestTime = info.modificationTime; latestKmlUri = fullPath;
            }
          }
        }
      };
      await findLatestKml(exactPath);
      if (latestKmlUri) await Sharing.shareAsync(latestKmlUri, { dialogTitle: 'Share Project Location (KML)' });
      else Alert.alert("Not Found", "No KML file found for this project.");
    } catch (e) { Alert.alert("Error", "Could not share KML file."); }
  };

  const renderSectionHeader = ({ section }: { section: any }) => {
    if (sortBy !== 'Date-Time') return null;
    
    let headerTitle = '';
    const [yyyy, mm, dd] = section.title.split('-');
    if(yyyy && mm && dd) {
        const dObj = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        headerTitle = `${days[dObj.getDay()]}, ${dd}-${mm}-${yyyy}`;
    } else {
        headerTitle = section.title;
    }

    const isExpanded = expandedDates.has(section.title);

    return (
      <View style={styles.dateHeaderWrapper}>
        <View style={styles.dateHeaderContainer}>
          {isSelectionMode && (
            <TouchableOpacity style={{ padding: 10, marginRight: 5 }} onPress={() => toggleDateSelection(section)}>
              <Ionicons name={section.originalData.every((p:any) => selectedIds.has(p.folderName)) ? "checkbox" : "square-outline"} size={22} color="#2563EB" />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.dateHeader} onPress={() => toggleSection(section.title)} activeOpacity={0.8}>
            <Text style={styles.dateHeaderText}>{headerTitle}  {isExpanded ? '▼' : '▶'}</Text>
          </TouchableOpacity>
          
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginLeft: 10, flex: 1 }} contentContainerStyle={{ alignItems: 'center', gap: 10 }}>
             {section.stats?.geo > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📍 {section.stats.geo} GeoTagIMG</Text>}
             {section.stats?.photos > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📸 {section.stats.photos} Image</Text>}
             {section.stats?.vids > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📹 {section.stats.vids} Videos</Text>}
             {section.stats?.text > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📝 {section.stats.text} Notes</Text>}
             {section.stats?.audio > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>🎙️ {section.stats.audio} Voice</Text>}
             {section.stats?.kmls > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>🌍 {section.stats.kmls} KML</Text>}
             {section.stats?.docs > 0 && <Text style={{fontSize: 12, color: '#64748B'}}>📎 {section.stats.docs} Docs</Text>}
          </ScrollView>
        </View>
      </View>
    );
  };

  const renderItem = ({ item }: { item: any }) => {
    const isSelected = selectedIds.has(item.folderName);
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
          <Text style={styles.dovText}>
              {item.visitDates[0] === 'Unknown' ? 'Unknown Date' : `Visited: ${item.visitDates.map((d:string) => { const [y,m,day]=d.split('-'); return `${day}-${m}-${y}`; }).join(', ')}`}
          </Text>
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
             <TouchableOpacity style={[globalStyles.locateGreenBtn, { flex: 0, paddingHorizontal: 12, paddingVertical: 8 }]} onPress={() => handleShareLatestKml(item.exactPath)}>
               <Ionicons name="earth" size={16} color="white" />
               <Text style={globalStyles.locateBtnText}>Locate</Text>
             </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) return <View style={styles.centerLoading}><ActivityIndicator size="large" color="#2563EB" /><Text style={{marginTop: 10, color: '#64748B'}}>Scanning workspace...</Text></View>;

  return (
    <View style={globalStyles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1, paddingRight: 10 }}>
            <TouchableWithoutFeedback onPress={handleTitleTap}>
               <View style={{flexDirection: 'row', alignItems: 'center'}}>
                 <Text style={styles.title}>Dashboard</Text>
                 {isRecoveryMode && <View style={styles.recoveryBadge}><Text style={{color: '#FFF', fontSize: 10, fontWeight: 'bold'}}>RECOVERY</Text></View>}
               </View>
            </TouchableWithoutFeedback>
            <Text style={styles.subTitle}>Personalised data for {activeUserId}</Text>
          </View>
          <TouchableOpacity 
             style={[styles.toolbarBtn, isSelectionMode ? { backgroundColor: '#FEE2E2', borderColor: '#FECACA' } : { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }]} 
             onPress={() => { setIsSelectionMode(!isSelectionMode); setSelectedIds(new Set()); }}
          >
             <Ionicons name={isSelectionMode ? "close" : "checkbox-outline"} size={16} color={isSelectionMode ? "#EF4444" : "#2563EB"} />
             <Text style={[styles.toolbarBtnText, isSelectionMode ? { color: '#EF4444' } : { color: '#2563EB' }]}>{isSelectionMode ? 'Cancel' : 'Select'}</Text>
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

      <SectionList 
        ref={sectionListRef}
        sections={processedSections}
        keyExtractor={(item, index) => item.folderName || index.toString()}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        stickySectionHeadersEnabled={true}
        contentContainerStyle={{ padding: 15, paddingBottom: 100 }}
        initialNumToRender={8}
        maxToRenderPerBatch={10}
        windowSize={5}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Ionicons name="documents-outline" size={64} color="#CBD5E1" />
            <Text style={styles.emptyText}>No Active Projects</Text>
            <Text style={styles.emptySubText}>Create reports to see them here.</Text>
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
               
               <TouchableOpacity style={[styles.bulkBtn, { backgroundColor: '#10B981', paddingHorizontal: 15 }]} onPress={handleSaveToDevice} disabled={selectedIds.size === 0}>
                 <Ionicons name="download-outline" size={18} color="#FFF" />
               </TouchableOpacity>

               <TouchableOpacity style={[styles.bulkBtn, { backgroundColor: '#2563EB', paddingHorizontal: 20 }]} onPress={handleBulkShare} disabled={selectedIds.size === 0}>
                 <Ionicons name="share-social" size={18} color="#FFF" style={{marginRight: 6}} />
                 <Text style={{ color: '#FFF', fontWeight: 'bold' }}>Share</Text>
               </TouchableOpacity>
            </View>
         </View>
      )}

      {isProcessingAction && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#FFF" />
          <Text style={{color: '#FFF', marginTop: 15, fontWeight: 'bold', textAlign: 'center', paddingHorizontal: 20, lineHeight: 24}}>{bulkExportStatus || 'Processing Folders...'}</Text>
        </View>
      )}

      <Modal visible={showPinModal} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ backgroundColor: '#FFF', padding: 25, borderRadius: 16, width: '80%' }}>
            <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 15, color: '#1E293B' }}>Admin Access</Text>
            <TextInput style={[styles.modalSearchInput, { backgroundColor: '#F1F5F9', marginBottom: 20 }]} secureTextEntry placeholder="Enter PIN" value={recoveryPin} onChangeText={setRecoveryPin} keyboardType="number-pad" autoFocus />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 15 }}>
               <TouchableOpacity onPress={() => { setShowPinModal(false); setTapCount(0); }}><Text style={{ color: '#64748B', fontWeight: 'bold', padding: 10 }}>Cancel</Text></TouchableOpacity>
               <TouchableOpacity onPress={handlePinSubmit} style={{ backgroundColor: '#EF4444', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}><Text style={{ color: '#FFF', fontWeight: 'bold' }}>Unlock</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

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
                    <TouchableOpacity style={styles.modalItem} onPress={() => {
                        if (sortOptions.includes(item as SortOption)) { setSortBy(item as SortOption); setSortOrder('asc'); }
                        setActiveModal(null);
                    }}>
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
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0', zIndex: 10 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: '900', color: '#1E293B' },
  subTitle: { fontSize: 12, color: '#64748B', fontWeight: '600', marginTop: 2 },
  
  recoveryBadge: { backgroundColor: '#EF4444', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginLeft: 10 },
  
  searchSortRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 15, gap: 10 },
  sortGroup: { flexDirection: 'row', alignItems: 'center' },
  
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F5F9', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  toolbarBtnText: { fontSize: 13, color: '#475569', marginLeft: 6, fontWeight: '700' },
  
  activeSearchContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0' },
  searchInput: { flex: 1, paddingVertical: 8, paddingHorizontal: 10, fontSize: 14 },
  modalSearchInput: { paddingVertical: 10, paddingHorizontal: 15, fontSize: 16, borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0' },

  dateHeaderWrapper: { backgroundColor: '#F8FAFC', paddingVertical: 10 },
  dateHeaderContainer: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 15 },
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

  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 100 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '70%', paddingBottom: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  modalItem: { padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  modalItemText: { fontSize: 16, color: '#334155' }
});