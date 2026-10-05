import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, SectionList, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput, Keyboard, Alert, Share, Modal, TouchableWithoutFeedback, ScrollView, InteractionManager, Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Linking from 'expo-linking';
import { zip } from 'react-native-zip-archive';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { generateCloudLinkAndUpload } from '../../utils/cloudUploader';
import { getActiveUserId, getActiveUsername } from '../../utils/userSession';
import * as XLSX from 'xlsx';
import DateTimePicker from '@react-native-community/datetimepicker';
import { isDashboardDirty, setDashboardDirty } from '../../utils/userSession';

// ── removed local getActiveUserId / getActiveUsername – imported from utils/userSession ──

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
  const [activeUsername, setActiveUsername] = useState('');
  
  const [recentProjects, setRecentProjects] = useState<any[]>([]);
  
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

  const [tapCount, setTapCount] = useState(0);
  const [showPinModal, setShowPinModal] = useState(false);
  const [recoveryPin, setRecoveryPin] = useState('');
  const [isRecoveryMode, setIsRecoveryMode] = useState(false);

  const [showExportModal, setShowExportModal] = useState(false);
  const [exportStartDate, setExportStartDate] = useState('');
  const [exportEndDate, setExportEndDate] = useState('');
  const [showDatePicker, setShowDatePicker] = useState<'start' | 'end' | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const sortOptions: SortOption[] = ['Date-Time', 'Project Title', 'Project ID', 'Tender ID', 'Number of Files'];

  const lastRefresh = useRef(0);
  useFocusEffect(
    useCallback(() => {
      let isMounted = true;
      const stale = Date.now() - lastRefresh.current > 30000;
      const wasDirty = isDashboardDirty; // capture BEFORE clearing
      if (stale || wasDirty) {
        lastRefresh.current = Date.now();
        setDashboardDirty(false); // clear first so re-entrancy is safe
        initLoad(isMounted, isRecoveryMode, wasDirty);
      }
      return () => { isMounted = false; };
    }, [isRecoveryMode])
  );

  const initLoad = async (isMounted: boolean, recovery: boolean, forceRefresh = false) => {
    setLoading(true);
    try {
      const [uniqueId, uName] = await Promise.all([getActiveUserId(), getActiveUsername()]);
      if (isMounted) { setActiveUserId(uniqueId); setActiveUsername(uName); }
      await loadRecentProjects(isMounted, uniqueId, recovery, forceRefresh);
    } catch (e) {
      if (isMounted) setLoading(false);
    }
  };

  const getFolderDatesAndSizeDynamic = async (absolutePath: string) => {
    let totalSize = 0, totalFiles = 0, maxModTime = 0;
    const dates: string[] = [];
    let mediaStats = { photos: 0, vids: 0, audio: 0, text: 0, docs: 0, geo: 0, kmls: 0 };
    
    try {
      const topItems = await FileSystem.readDirectoryAsync(absolutePath).catch(() => []);
      for (const item of topItems) {
        if (item === 'SQLite' || item.endsWith('.json')) continue;
        const itemPath = `${absolutePath}${item}`;
        
        if (item.startsWith('VISIT_')) {
          const parts = item.split('_');
          if (parts.length >= 3 && parts[2].length === 8) {
            const d = parts[2];
            dates.push(`${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`);
            if (parts.length >= 4 && parts[3].length >= 4) {
              const dt = new Date(
                parseInt(d.substring(0,4)), 
                parseInt(d.substring(4,6))-1, 
                parseInt(d.substring(6,8)), 
                parseInt(parts[3].substring(0,2)), 
                parseInt(parts[3].substring(2,4))
              ).getTime() / 1000;
              if (dt > maxModTime) maxModTime = dt;
            }
          }
        }

        const subFiles = await FileSystem.readDirectoryAsync(`${itemPath}/`).catch(() => null);
        if (subFiles !== null) {
          for (const sub of subFiles) {
            const subDirPath = `${itemPath}/${sub}`;
            const leafFiles = await FileSystem.readDirectoryAsync(`${subDirPath}/`).catch(() => null);
            if (leafFiles !== null) {
              const normalizedSub = sub.toLowerCase();
              for (const lf of leafFiles) {
                if (lf.endsWith('.json')) continue;
                totalFiles++;
                const lower = lf.toLowerCase();
                const ext = lower.split('.').pop() || '';
                if (lower.endsWith('.kml')) mediaStats.kmls++;
                else if (['txt'].includes(ext)) mediaStats.text++;
                else if (['m4a', 'wav', 'mp3'].includes(ext)) mediaStats.audio++;
                else if (['pdf', 'doc', 'docx', 'csv', 'xls', 'xlsx'].includes(ext)) mediaStats.docs++;
                else if (['mp4', 'mov'].includes(ext)) mediaStats.vids++;
                else if (['jpg', 'png', 'jpeg', 'webp'].includes(ext)) {
                  if (normalizedSub.includes('geotag')) mediaStats.geo++;
                  else mediaStats.photos++;
                } else {
                  if (normalizedSub.includes('attachment') || normalizedSub.includes('document')) mediaStats.docs++;
                }
              }
            } else {
              if (!sub.endsWith('.json')) {
                totalFiles++;
                const lower = sub.toLowerCase();
                const ext = lower.split('.').pop() || '';
                const normalizedItem = item.toLowerCase();
                if (lower.endsWith('.kml')) mediaStats.kmls++;
                else if (['txt'].includes(ext)) mediaStats.text++;
                else if (['m4a', 'wav', 'mp3'].includes(ext)) mediaStats.audio++;
                else if (['pdf', 'doc', 'docx', 'csv', 'xls', 'xlsx'].includes(ext)) mediaStats.docs++;
                else if (['mp4', 'mov'].includes(ext)) mediaStats.vids++;
                else if (['jpg', 'png', 'jpeg', 'webp'].includes(ext)) {
                  if (normalizedItem.includes('geotag')) mediaStats.geo++;
                  else mediaStats.photos++;
                }
              }
            }
          }
        } else {
          if (!item.endsWith('.json')) {
            totalFiles++;
            const lower = item.toLowerCase();
            const ext = lower.split('.').pop() || '';
            if (lower.endsWith('.kml')) mediaStats.kmls++;
            else if (['jpg', 'png', 'jpeg', 'webp'].includes(ext)) mediaStats.photos++;
            else if (['pdf', 'doc', 'docx'].includes(ext)) mediaStats.docs++;
          }
        }
      }
    } catch(e) {}

    const folderInfo = await FileSystem.getInfoAsync(absolutePath).catch(() => null);
    if (folderInfo && folderInfo.exists) {
      if (folderInfo.size) totalSize = folderInfo.size;
      if (folderInfo.modificationTime && folderInfo.modificationTime > maxModTime) {
        maxModTime = folderInfo.modificationTime;
      }
    }

    const uniqueDates = [...new Set(dates)].sort((a,b) => b.localeCompare(a));
    return { uniqueDates, totalSize, totalFiles, maxModTime, mediaStats };
  };

  const loadRecentProjects = async (isMounted: boolean, uniqueId: string, recovery: boolean, forceRefresh = false) => {
    try {
      let allTenders: any[] = [];
      try { 
        allTenders = await sqlDb.getAllAsync(`
          SELECT t.*, pd.latitude, pd.longitude 
          FROM tenders t 
          LEFT JOIN project_details pd ON t.project_id = pd.project_id
        `) as any[]; 
      } catch (dbError) { console.error('[Dashboard] DB error:', dbError); }

      const rootUri = FileSystem.documentDirectory;
      if (!rootUri) return;

      const cacheFile = `${rootUri}projects/${uniqueId}_meta_cache.json`;
      
      // Phase 1: Instant Cache Load
      if (!recovery) {
        try {
          const cacheInfo = await FileSystem.getInfoAsync(cacheFile).catch(() => ({ exists: false }));
          if (cacheInfo.exists) {
            const cachedData = await FileSystem.readAsStringAsync(cacheFile);
            const parsedCache = JSON.parse(cachedData);
            // If cache is empty array (corrupted), delete it and do a fresh scan
            if (!parsedCache || parsedCache.length === 0) {
              await FileSystem.deleteAsync(cacheFile, { idempotent: true });
            } else if (isMounted) {
              setRecentProjects(parsedCache);
              setLoading(false); // Stop loading instantly
              const sortedDates = [...new Set(parsedCache.map((p: any) => p.latestDate))].sort((a: any,b: any) => b.localeCompare(a));
              if (sortedDates.length > 0) setExpandedDates(new Set<string>([sortedDates[0] as string]));
              
              // If not forced (dirty flag was set), avoid heavy background re-scan
              if (!forceRefresh) {
                return;
              }
            }
          }
        } catch (e) {}
      }

      // Phase 2: Background Sync
      const foundProjectsList: {name: string, exactPath: string, ownerId: string}[] = [];
      const combinedProjects: any[] = [];
      const baseProjectsDir = `${rootUri}projects/`;
      const userSpecificDir = `${baseProjectsDir}${uniqueId}/`;

      if (recovery) {
         const rootInfo = await FileSystem.getInfoAsync(baseProjectsDir).catch(() => ({ exists: false }));
         if (rootInfo.exists) {
             const usersOrProjects = await FileSystem.readDirectoryAsync(baseProjectsDir).catch(() => []);
             for (const item of usersOrProjects) {
                 if (item === 'SQLite' || item.endsWith('.json')) continue;
                 const itemPath = `${baseProjectsDir}${item}/`;
                 const itemInfo = await FileSystem.getInfoAsync(itemPath).catch(() => ({ isDirectory: false }));
                 
                 if (itemInfo.isDirectory) {
                     const subItems = await FileSystem.readDirectoryAsync(itemPath).catch(() => []);
                     const isLegacyProject = allTenders.some(t => {
                         const expectedFolder = `${t.project_id}_${t.tender_id || 'UNKNOWN_TENDER'}`.replace(/[^a-zA-Z0-9_-]/g, '_');
                         const cleanId = t.project_id.replace(/[^a-zA-Z0-9_-]/g, '_');
                         const regex = new RegExp(`(^|_)${cleanId}(_|$)`);
                         return expectedFolder === item || regex.test(item);
                     });
                     
                     if (isLegacyProject || subItems.some(s => s.startsWith('VISIT_') || s === 'Location Pins' || s === 'Notes')) {
                         foundProjectsList.push({ name: item, exactPath: itemPath, ownerId: 'local-user' });
                     } else {
                         for (const sub of subItems) {
                             if (!sub.startsWith('.')) {
                                 foundProjectsList.push({ name: sub, exactPath: `${itemPath}${sub}/`, ownerId: item });
                             }
                         }
                     }
                 }
             }
         }
      } else {
         const exists = await FileSystem.getInfoAsync(userSpecificDir).catch(() => ({ exists: false }));
         if (exists.exists) {
             const items = await FileSystem.readDirectoryAsync(userSpecificDir).catch(() => []);
             for (const item of items) {
                 const itemPath = `${userSpecificDir}${item}/`;
                 const info = await FileSystem.getInfoAsync(itemPath).catch(() => ({ isDirectory: false }));
                 if (info.isDirectory && !item.startsWith('.')) {
                     foundProjectsList.push({ name: item, exactPath: itemPath, ownerId: uniqueId });
                 }
             }
         }
      }

      // ── Phase 2: Defer background scan until after animations finish ──
      InteractionManager.runAfterInteractions(() => {
        const runPhase2 = async () => {
          try {
            console.log('[Dashboard] Phase 2 scanning', foundProjectsList.length, 'project folders');
            for (const proj of foundProjectsList) {
               const exactPath = proj.exactPath;
               const folderName = proj.name;
               const ownerId = proj.ownerId;
               const meta = await getFolderDatesAndSizeDynamic(exactPath);
               
               // Only skip truly empty folders with no VISIT_ dates either
               if (meta.totalFiles === 0 && meta.uniqueDates.length === 0) continue;

               // Try to match folder to a DB tender (exact, prefix, or contains)
               const matchedTender = allTenders.find(t => {
                   const cleanProjectId = t.project_id.replace(/[^a-zA-Z0-9_-]/g, '_');
                   const cleanTenderId = (t.tender_id || 'UNKNOWN_TENDER').replace(/[^a-zA-Z0-9_-]/g, '_');
                   const expectedFolder = `${cleanProjectId}_${cleanTenderId}`;
                   if (expectedFolder === folderName) return true;
                   if (folderName.startsWith(`${cleanProjectId}_`)) return true;
                   if (folderName.includes(cleanProjectId)) return true;
                   return false;
               });

               // Fallback: parse project_id & tender_id directly from folder name
               // Folder format: {project_id}_{tender_id} — split on LAST underscore
               const effectiveTender = matchedTender || (() => {
                 const lastUnderscore = folderName.lastIndexOf('_');
                 const parsedProjectId = lastUnderscore > 0 ? folderName.substring(0, lastUnderscore) : folderName;
                 const parsedTenderId = lastUnderscore > 0 ? folderName.substring(lastUnderscore + 1) : '';
                 // Re-check DB with parsed values in case sanitization differed
                 const rematched = allTenders.find(t => 
                   t.project_id === parsedProjectId || t.project_id.replace(/[^a-zA-Z0-9_-]/g, '_') === parsedProjectId
                 );
                 if (rematched) return rematched;
                 // Truly not in DB — build minimal synthetic tender so project still appears
                 return { project_id: parsedProjectId, tender_id: parsedTenderId, project_title: parsedProjectId, project_type: '', state: '', district: '', ulb: '', physical_progress: '' };
               })();

               if (effectiveTender) {
                   const already = combinedProjects.findIndex(p => p.exactPath === exactPath);
                   const entry = { 
                      ...effectiveTender, 
                      folderName: folderName,
                      exactPath: exactPath,
                      ownerId: ownerId,
                      visitDates: meta.uniqueDates.length > 0 ? meta.uniqueDates : ['Unknown'],
                      latestDate: meta.uniqueDates[0] || 'Unknown',
                      totalSize: meta.totalSize,
                      totalFiles: meta.totalFiles,
                      maxModTime: meta.maxModTime,
                      mediaStats: meta.mediaStats 
                   };
                   if (already >= 0) combinedProjects[already] = entry;
                   else combinedProjects.push(entry);
               }
            }

            // Update cache and UI:
            // - If we found matched projects → always update (fresher data wins)
            // - If foundProjectsList was empty (no folders on disk at all) → write empty to clear stale cache
            // - If folders exist but none matched (DB/matching issue) → keep old cache, don't blank the UI
            if (combinedProjects.length > 0) {
              await FileSystem.writeAsStringAsync(cacheFile, JSON.stringify(combinedProjects));
              if (isMounted) {
                setRecentProjects([...combinedProjects]); 
                setExpandedDates(prev => {
                   if (prev.size > 0) return prev;
                   const sortedDates = [...new Set(combinedProjects.map((p: any) => p.latestDate))].sort((a: any,b: any) => b.localeCompare(a));
                   return sortedDates.length > 0 ? new Set<string>([sortedDates[0] as string]) : prev;
                });
              }
            } else if (foundProjectsList.length === 0) {
              // Filesystem genuinely empty — clear stale cache
              await FileSystem.writeAsStringAsync(cacheFile, JSON.stringify([]));
              if (isMounted) setRecentProjects([]);
            }
            // else: folders exist but matching failed — silently keep cached data on screen
          } catch (e) { console.error('[Dashboard] Phase 2 error:', e); }
        };
        runPhase2();
      });
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
    if (recoveryPin === (process.env.EXPO_PUBLIC_RECOVERY_PIN || '122333456')) {
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
    return recentProjects.filter(p => selectedIds.has(p.exactPath)).reduce((acc, curr) => acc + curr.totalSize, 0);
  }, [selectedIds, recentProjects]);

  const toggleSelection = (exactPath: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(exactPath)) newSet.delete(exactPath); else newSet.add(exactPath);
    setSelectedIds(newSet);
  };

  const toggleDateSelection = (section: any) => {
    const newSet = new Set(selectedIds);
    const allSelected = section.originalData.every((p: any) => selectedIds.has(p.exactPath));
    
    if (allSelected) section.originalData.forEach((p: any) => newSet.delete(p.exactPath));
    else section.originalData.forEach((p: any) => newSet.add(p.exactPath));
    setSelectedIds(newSet);
  };

  const handleBulkDelete = () => {
    Alert.alert("Erase Media Files?", "This will permanently delete photos and videos, but will safely retain text notes, audio, location pins, documents, and metadata.", [
      { text: "Cancel", style: "cancel" },
      { text: "Erase Media", style: "destructive", onPress: async () => {
          setIsProcessingAction(true);
          try {
            const selectedData = recentProjects.filter(p => selectedIds.has(p.exactPath));
            for (const project of selectedData) {
               const traverseAndDeleteMedia = async (currentPath: string) => {
                  const files = await FileSystem.readDirectoryAsync(currentPath);
                  for (const file of files) {
                     const fullPath = `${currentPath}${file}`;
                     const info = await FileSystem.getInfoAsync(fullPath);
                     if (info.isDirectory) { await traverseAndDeleteMedia(`${fullPath}/`); } 
                     else {
                        const lowerFile = file.toLowerCase();
                        if (lowerFile.endsWith('.jpg') || lowerFile.endsWith('.jpeg') || lowerFile.endsWith('.png') || lowerFile.endsWith('.mp4') || lowerFile.endsWith('.mov')) { 
                           await FileSystem.deleteAsync(fullPath, { idempotent: true }); 
                        }
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
    const selectedData = recentProjects.filter(p => selectedIds.has(p.exactPath));
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
        const destName = isRecoveryMode ? `${project.ownerId}_${project.folderName}` : project.folderName;
        await FileSystem.copyAsync({ from: project.exactPath, to: `${stagingPath}${destName}/` });
      }

      if (type === 'link') {
        const currentMeta = { totalFiles, totalSize, maxModTime: Date.now() };
        let uName = await getActiveUsername();

        const { expectedUrl, startBackgroundUpload } = await generateCloudLinkAndUpload(exportName, stagingPath, uName, currentMeta, (status: string) => {
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
      
      try {
          await FileSystem.StorageAccessFramework.readDirectoryAsync(targetDirUri);
      } catch(e) {
          const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
          if (!permissions.granted) { setIsProcessingAction(false); return; }
          targetDirUri = permissions.directoryUri;
          await SecureStore.setItemAsync('irma_saf_directory_uri', targetDirUri);
      }

      const selectedData = recentProjects.filter(p => selectedIds.has(p.exactPath));
      const dateStr = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
      const exportDirUri = await FileSystem.StorageAccessFramework.makeDirectoryAsync(targetDirUri, `IRMA_Export_${dateStr}`);

      for (const project of selectedData) {
         try {
             const destName = isRecoveryMode ? `${project.ownerId}_${project.folderName}` : project.folderName;
             const projDirUri = await FileSystem.StorageAccessFramework.makeDirectoryAsync(exportDirUri, destName);
             
             const traverseAndCopy = async (localPath: string, safParentUri: string) => {
                 const files = await FileSystem.readDirectoryAsync(localPath);
                 for (const file of files) {
                     const fullLocalPath = `${localPath}${file}`;
                     const info = await FileSystem.getInfoAsync(fullLocalPath);
                     
                     if (info.exists && info.isDirectory) {
                         const newSafDirUri = await FileSystem.StorageAccessFramework.makeDirectoryAsync(safParentUri, file);
                         await traverseAndCopy(`${fullLocalPath}/`, newSafDirUri);
                     } else if (info.exists && !info.isDirectory) {
                         if (info.size && info.size > 50 * 1024 * 1024) {
                             console.warn(`Skipping large file > 50MB: ${file}`);
                             continue;
                         }
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
        try {
          const info = await FileSystem.getInfoAsync(currentPath);
          if (!info.exists || !info.isDirectory) return;
          const files = await FileSystem.readDirectoryAsync(currentPath);
          for (const file of files) {
            const fullPath = `${currentPath}${file}`;
            const fileInfo = await FileSystem.getInfoAsync(fullPath);
            if (!fileInfo.exists) continue;
            if (fileInfo.isDirectory) { await findLatestKml(`${fullPath}/`); } 
            else if (file.toLowerCase().endsWith('.kml')) {
              const mod = fileInfo.modificationTime ?? 0;
              if (mod >= latestTime) {
                latestTime = mod; latestKmlUri = fullPath;
              }
            }
          }
        } catch(e) {}
      };
      
      await findLatestKml(`${exactPath}Location Pins/`);
      if (!latestKmlUri) await findLatestKml(exactPath);

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
  };

  // Logic to process deeply and export multiple sheets based on Visit Dates
  const handleExportDataExcel = async () => {
    if (exportStartDate && exportEndDate && exportStartDate > exportEndDate) {
      Alert.alert("Invalid Date Range", "Start date cannot be after the end date.");
      return;
    }

    setIsExporting(true);
    try {
      const visitDataMap: Record<number, any[]> = {};

      for (const proj of recentProjects) {
        const items = await FileSystem.readDirectoryAsync(proj.exactPath).catch(() => []);
        const visits = [];

        // 1. Scan for Visit Folders
        for (const item of items) {
          if (item.startsWith('VISIT_')) {
            const parts = item.split('_');
            if (parts.length >= 3 && parts[2].length === 8) {
              const d = parts[2];
              const formattedDate = `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`;
              visits.push({ dirName: item, date: formattedDate, timestamp: d });
            }
          }
        }

        visits.sort((a,b) => a.timestamp.localeCompare(b.timestamp));

        // 2. If no VISIT_ folders, treat the root path as Visit 1
        if (visits.length === 0) {
          visits.push({ dirName: '', date: proj.latestDate !== 'Unknown' ? proj.latestDate : 'Unknown', timestamp: '00000000' });
        }

        // 3. Process each visit sequentially
        for (let i = 0; i < visits.length; i++) {
          const v = visits[i];

          // Apply date filters
          if (exportStartDate && v.date !== 'Unknown' && v.date < exportStartDate) continue;
          if (exportEndDate && v.date !== 'Unknown' && v.date > exportEndDate) continue;

          let stats = { geoImg: 0, otherImg: 0, kml: 0, vid: 0, text: 0, docs: 0, totalFiles: 0 };

          // Traverse deeper within this specific visit folder
          const traverseAndTally = async (currentPath: string, parentDir: string = '') => {
             const subItems = await FileSystem.readDirectoryAsync(currentPath).catch(() => []);
             for (const file of subItems) {
                const fullPath = `${currentPath}${file}`;
                const info = await FileSystem.getInfoAsync(fullPath).catch(() => null);
                if (!info) continue;
                
                if (info.isDirectory) {
                   // Avoid scanning sibling VISIT_ folders if scanning from root
                   if (v.dirName === '' && file.startsWith('VISIT_')) continue; 
                   await traverseAndTally(`${fullPath}/`, file);
                } else {
                   stats.totalFiles++;
                   const lowerFile = file.toLowerCase();
                   const ext = lowerFile.split('.').pop() || '';
                   const normalizedParent = parentDir.toLowerCase();

                   if (lowerFile.endsWith('.kml')) stats.kml++;
                   else if (['txt'].includes(ext)) stats.text++;
                   else if (['mp4', 'mov'].includes(ext)) stats.vid++;
                   else if (['pdf', 'doc', 'docx', 'csv', 'xls', 'xlsx'].includes(ext)) stats.docs++;
                   else if (['jpg', 'png', 'jpeg'].includes(ext)) {
                       if (normalizedParent.includes('geotag') || currentPath.toLowerCase().includes('geotag')) stats.geoImg++;
                       else stats.otherImg++;
                   } else if (!file.endsWith('.json')) {
                       stats.docs++;
                   }
                }
             }
          };

          await traverseAndTally(proj.exactPath + (v.dirName ? v.dirName + '/' : ''));

          // Record metrics for mapping 
          const visitNum = i + 1;
          if (!visitDataMap[visitNum]) visitDataMap[visitNum] = [];

          visitDataMap[visitNum].push({
            "Project ID": `${proj.project_id} (${v.date})`,
            "Tender ID": proj.tender_id || 'N/A',
            "Project Title": proj.project_title || 'N/A',
            "Date of Visit": v.date,
            "Geotagged Images": stats.geoImg,
            "Geolocations (KML)": stats.kml,
            "Videos": stats.vid,
            "Other Photos": stats.otherImg,
            "Notes & Text": stats.text,
            "Documents (PDF/XLS)": stats.docs,
            "Total Files": stats.totalFiles
          });
        }
      }

      if (Object.keys(visitDataMap).length === 0) {
         Alert.alert("No Data", "No project visits match the selected criteria.");
         setIsExporting(false);
         return;
      }

      // Generate Workbook and Sheets
      const wb = XLSX.utils.book_new();
      Object.keys(visitDataMap).sort((a,b) => Number(a)-Number(b)).forEach(vNumStr => {
         const vNum = Number(vNumStr);
         const ws = XLSX.utils.json_to_sheet(visitDataMap[vNum]);
         
         const colWidths = [
           { wch: 30 }, { wch: 15 }, { wch: 40 }, { wch: 15 }, 
           { wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 15 }
         ];
         ws['!cols'] = colWidths;

         XLSX.utils.book_append_sheet(wb, ws, `Visit ${vNum}`);
      });
      
      const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      
      // Strict dynamic file naming per user requirement
      let datePart = 'All_Dates';
      if (exportStartDate && exportEndDate) datePart = `${exportStartDate}-${exportEndDate}`;
      else if (exportStartDate) datePart = `From_${exportStartDate}`;
      else if (exportEndDate) datePart = `Until_${exportEndDate}`;
      
      const exportName = `IRMA_Visit_Summary_${datePart}.xlsx`;
      const uri = `${FileSystem.cacheDirectory}${exportName}`;
      
      // 1. Save to local app cache securely
      await FileSystem.writeAsStringAsync(uri, wbout, { encoding: FileSystem.EncodingType.Base64 });
      
      // 2. Automatically save to the SAF Device Folder seamlessly
      try {
          let targetDirUri = await SecureStore.getItemAsync('irma_saf_directory_uri');
          
          if (!targetDirUri) {
              const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
              if (permissions.granted) {
                  targetDirUri = permissions.directoryUri;
                  await SecureStore.setItemAsync('irma_saf_directory_uri', targetDirUri);
              }
          }
          
          if (targetDirUri) {
              try { 
                  await FileSystem.StorageAccessFramework.readDirectoryAsync(targetDirUri); 
              } catch(e) {
                  const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
                  if (permissions.granted) {
                      targetDirUri = permissions.directoryUri;
                      await SecureStore.setItemAsync('irma_saf_directory_uri', targetDirUri);
                  } else {
                      targetDirUri = null;
                  }
              }
              
              if (targetDirUri) {
                  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                  const safFileUri = await FileSystem.StorageAccessFramework.createFileAsync(targetDirUri, exportName, mimeType);
                  await FileSystem.writeAsStringAsync(safFileUri, wbout, { encoding: FileSystem.EncodingType.Base64 });
              }
          }
      } catch (safError) {
          console.warn("Failed to auto-save to device folder:", safError);
      }

      // 3. Prompt external share sheet functionality 
      await Sharing.shareAsync(uri);
      
      setShowExportModal(false);
    } catch (error) {
      console.error(error);
      Alert.alert("Export Failed", "There was an error generating the Excel summary.");
    } finally {
      setIsExporting(false);
    }
  };

  const renderSectionHeader = ({ section }: { section: any }) => {
    if (sortBy !== 'Date-Time') return null;
    
    let headerTitle = '';
    const [yyyy, mm, dd] = section.title.split('-');
    if(yyyy && mm && dd) {
        const dObj = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        headerTitle = `${days[dObj.getDay()]}, ${dd}/${mm}/${yyyy}`;
    } else {
        headerTitle = section.title;
    }

    const isExpanded = expandedDates.has(section.title);

    return (
      <View style={styles.dateHeaderWrapper}>
        <View style={styles.dateHeaderContainer}>
          {isSelectionMode && (
            <TouchableOpacity style={{ padding: 10, marginRight: 5 }} onPress={() => toggleDateSelection(section)}>
              <Ionicons name={section.originalData.every((p:any) => selectedIds.has(p.exactPath)) ? "checkmark-circle" : "ellipse-outline"} size={22} color={section.originalData.every((p:any) => selectedIds.has(p.exactPath)) ? "#3B82F6" : "#CBD5E1"} />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.dateHeader} onPress={() => toggleSection(section.title)} activeOpacity={0.7}>
            <Text style={styles.dateHeaderText}>{headerTitle}</Text>
            <Ionicons name={isExpanded ? "chevron-up" : "chevron-down"} size={16} color="#64748B" style={{marginLeft: 6}} />
          </TouchableOpacity>
          
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginLeft: 10, flex: 1 }} contentContainerStyle={{ alignItems: 'center', gap: 8 }}>
             {section.stats?.geo > 0 && <View style={styles.statChip}><Ionicons name="images" size={10} color="#0891B2" /><Text style={[styles.statChipText, {color:'#0891B2'}]}> {section.stats.geo}</Text></View>}
             {section.stats?.photos > 0 && <View style={styles.statChip}><Ionicons name="camera" size={10} color="#7C3AED" /><Text style={[styles.statChipText, {color:'#7C3AED'}]}> {section.stats.photos}</Text></View>}
             {section.stats?.vids > 0 && <View style={styles.statChip}><Ionicons name="videocam" size={10} color="#DB2777" /><Text style={[styles.statChipText, {color:'#DB2777'}]}> {section.stats.vids}</Text></View>}
             {section.stats?.text > 0 && <View style={styles.statChip}><Ionicons name="document-text" size={10} color="#059669" /><Text style={[styles.statChipText, {color:'#059669'}]}> {section.stats.text}</Text></View>}
             {section.stats?.audio > 0 && <View style={styles.statChip}><Ionicons name="mic" size={10} color="#EA580C" /><Text style={[styles.statChipText, {color:'#EA580C'}]}> {section.stats.audio}</Text></View>}
             {section.stats?.kmls > 0 && <View style={styles.statChip}><Ionicons name="location" size={10} color="#16A34A" /><Text style={[styles.statChipText, {color:'#16A34A'}]}> {section.stats.kmls}</Text></View>}
             {section.stats?.docs > 0 && <View style={styles.statChip}><Ionicons name="attach" size={10} color="#64748B" /><Text style={[styles.statChipText, {color:'#64748B'}]}> {section.stats.docs}</Text></View>}
          </ScrollView>
        </View>
      </View>
    );
  };

  const onPressItem = useCallback((item: any) => {
    if (isSelectionMode) toggleSelection(item.exactPath);
    else router.push(`/project/${encodeURIComponent(item.project_id)}?tender_id=${encodeURIComponent(item.tender_id || 'UNKNOWN')}` as any);
  }, [isSelectionMode, toggleSelection, router]);

  const onLongPressItem = useCallback((item: any) => {
    setIsSelectionMode(true);
    toggleSelection(item.exactPath);
  }, [toggleSelection]);

  const onLocateItem = useCallback((exactPath: string) => {
    handleShareLatestKml(exactPath);
  }, []);

  const renderItem = useCallback(({ item }: { item: any }) => {
    return (
      <ProjectCard 
        item={item}
        isSelected={selectedIds.has(item.exactPath)}
        isSelectionMode={isSelectionMode}
        isRecoveryMode={isRecoveryMode}
        onPress={onPressItem}
        onLongPress={onLongPressItem}
        onLocate={onLocateItem}
      />
    );
  }, [selectedIds, isSelectionMode, isRecoveryMode, onPressItem, onLongPressItem, onLocateItem]);

  if (loading) return <View style={styles.centerLoading}><ActivityIndicator size="large" color="#3B82F6" /><Text style={{marginTop: 12, color: '#64748B', fontWeight: '600'}}>Loading Dashboard...</Text></View>;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={{ flex: 1 }}>
            <TouchableWithoutFeedback onPress={handleTitleTap}>
               <View style={{flexDirection: 'row', alignItems: 'center'}}>
                 <Text style={styles.title}>Dashboard</Text>
                 {isRecoveryMode && <View style={styles.recoveryBadge}><Text style={{color: '#FFF', fontSize: 10, fontWeight: 'bold'}}>RECOVERY</Text></View>}
               </View>
            </TouchableWithoutFeedback>
            <Text style={styles.subTitle}>{isRecoveryMode ? 'Accessing data from all users' : `Welcome back, ${activeUsername || activeUserId}`}</Text>
          </View>
          
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity 
               style={[styles.iconBtn, isSearchActive && { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }]} 
               onPress={() => {
                 setIsSearchActive(!isSearchActive);
                 if (isSearchActive) { setSearch(''); Keyboard.dismiss(); }
               }}
            >
               <Ionicons name={isSearchActive ? "close" : "search-outline"} size={20} color={isSearchActive ? "#2563EB" : "#334155"} />
            </TouchableOpacity>

            <TouchableOpacity 
               style={styles.iconBtn} 
               onPress={() => setShowExportModal(true)}
            >
               <Ionicons name="cloud-download-outline" size={20} color="#334155" />
            </TouchableOpacity>

            <TouchableOpacity 
               style={[styles.iconBtn, isSelectionMode && { backgroundColor: '#FEE2E2', borderColor: '#FECACA' }]} 
               onPress={() => { setIsSelectionMode(!isSelectionMode); setSelectedIds(new Set()); }}
            >
               <Ionicons name={isSelectionMode ? "close" : "checkmark-circle-outline"} size={20} color={isSelectionMode ? "#EF4444" : "#334155"} />
            </TouchableOpacity>
          </View>
        </View>

        {isSearchActive && (
          <View style={styles.searchSortRow}>
            <View style={styles.activeSearchContainer}>
              <Ionicons name="search" size={18} color="#64748B" style={{ marginLeft: 12 }} />
              <TextInput 
                placeholder="Search ID, Title, ULB..." 
                style={styles.searchInput} 
                value={search} 
                onChangeText={setSearch} 
                autoFocus 
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')} style={{ padding: 8 }}>
                  <Ionicons name="close-circle" size={18} color="#94A3B8" />
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => { setIsSearchActive(false); setSearch(''); Keyboard.dismiss(); }} style={{ paddingHorizontal: 12 }}>
                <Text style={{ color: '#EF4444', fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.filterRow}>
          <Text style={styles.filterLabel}>Sort By:</Text>
          <TouchableOpacity style={styles.filterChip} onPress={() => setActiveModal({ type: 'sort', options: sortOptions, title: 'Sort Projects By' })}>
            <Text style={styles.filterChipText}>{getShortSortName(sortBy)}</Text>
            <Ionicons name="chevron-down" size={14} color="#64748B" style={{marginLeft: 4}} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.sortDirectionBtn} onPress={() => setSortOrder(p => p === 'asc' ? 'desc' : 'asc')}>
            <Ionicons name={sortOrder === 'asc' ? 'arrow-up' : 'arrow-down'} size={16} color="#334155" />
          </TouchableOpacity>
        </View>
      </View>

      <SectionList 
        ref={sectionListRef}
        sections={processedSections}
        keyExtractor={(item, index) => item.exactPath || index.toString()}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        stickySectionHeadersEnabled={true}
        contentContainerStyle={{ padding: 15, paddingBottom: 100 }}
        initialNumToRender={8}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={Platform.OS === 'android'}
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

      <Modal visible={showExportModal} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ backgroundColor: '#FFF', padding: 25, borderRadius: 16, width: '85%' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 15 }}>
              <Ionicons name="analytics" size={24} color="#16A34A" style={{ marginRight: 8 }} />
              <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#1E293B' }}>Export Data Summary</Text>
            </View>
            <Text style={{ fontSize: 13, color: '#64748B', marginBottom: 20 }}>Generate a detailed Excel file with separate sheets for multi-visits, categorized file tally, and timeline structure. It will be saved to your device folder and shared.</Text>
            
            <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#334155', marginBottom: 6 }}>Start Date (Optional)</Text>
            <TouchableOpacity 
              style={[styles.modalSearchInput, { backgroundColor: '#F8FAFC', marginBottom: 15, justifyContent: 'center' }]} 
              onPress={() => setShowDatePicker('start')}
            >
              <Text style={{ color: exportStartDate ? '#1E293B' : '#94A3B8', fontSize: 16 }}>
                {exportStartDate || 'Select Start Date...'}
              </Text>
            </TouchableOpacity>

            <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#334155', marginBottom: 6 }}>End Date (Optional)</Text>
            <TouchableOpacity 
              style={[styles.modalSearchInput, { backgroundColor: '#F8FAFC', marginBottom: 20, justifyContent: 'center' }]} 
              onPress={() => setShowDatePicker('end')}
            >
              <Text style={{ color: exportEndDate ? '#1E293B' : '#94A3B8', fontSize: 16 }}>
                {exportEndDate || 'Select End Date...'}
              </Text>
            </TouchableOpacity>

            {showDatePicker && (
              <DateTimePicker
                value={showDatePicker === 'start' && exportStartDate ? new Date(exportStartDate) : showDatePicker === 'end' && exportEndDate ? new Date(exportEndDate) : new Date()}
                mode="date"
                display="default"
                onChange={(event, selectedDate) => {
                  const currentType = showDatePicker;
                  setShowDatePicker(null); 
                  
                  if (event.type === 'set' && selectedDate) {
                    const year = selectedDate.getFullYear();
                    const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
                    const day = String(selectedDate.getDate()).padStart(2, '0');
                    const formattedDate = `${year}-${month}-${day}`;
                    
                    if (currentType === 'start') setExportStartDate(formattedDate);
                    else if (currentType === 'end') setExportEndDate(formattedDate);
                  }
                }}
              />
            )}

            {isExporting ? (
              <ActivityIndicator size="large" color="#16A34A" />
            ) : (
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 15 }}>
                 <TouchableOpacity onPress={() => { setShowExportModal(false); setExportStartDate(''); setExportEndDate(''); setShowDatePicker(null); }}>
                   <Text style={{ color: '#64748B', fontWeight: 'bold', padding: 10 }}>Cancel</Text>
                 </TouchableOpacity>
                 <TouchableOpacity onPress={handleExportDataExcel} style={{ backgroundColor: '#16A34A', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}>
                   <Text style={{ color: '#FFF', fontWeight: 'bold' }}>Generate Excel</Text>
                 </TouchableOpacity>
              </View>
            )}
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
                        if (sortOptions.includes(item as SortOption)) { setSortBy(item as SortOption); setSortOrder(item === 'Date-Time' ? 'desc' : 'asc'); }
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

const ProjectCard = React.memo(function ProjectCard({ 
  item, 
  isSelected, 
  isSelectionMode, 
  isRecoveryMode, 
  onPress, 
  onLongPress, 
  onLocate 
}: any) {
  const hasKml = item.mediaStats?.kmls > 0;
  const hasMapPin = !!(item.latitude && item.longitude);
  const hasBoth = hasMapPin && hasKml;
  const exactTime = item.maxModTime > 0 
    ? new Date(item.maxModTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
    : '';

  const visitDateDisplay = useMemo(() => {
    if (!item.visitDates || item.visitDates.length === 0 || item.visitDates[0] === 'Unknown') {
      return 'No visits recorded';
    }
    return item.visitDates.map((d: string) => {
      const parts = d.split('-');
      if (parts.length === 3) return `${parts[2]}/${parts[1]}`;
      return d;
    }).join(', ');
  }, [item.visitDates]);

  return (
    <TouchableOpacity 
      style={[styles.card, isSelectionMode && isSelected && styles.cardSelected]} 
      activeOpacity={0.7} 
      onLongPress={() => onLongPress(item)}
      onPress={() => onPress(item)}
    >
      <View style={styles.cardHeader}>
        {isSelectionMode && (
          <Ionicons 
            name={isSelected ? "checkmark-circle" : "ellipse-outline"} 
            size={22} 
            color={isSelected ? "#2563EB" : "#CBD5E1"} 
            style={{ marginRight: 8 }} 
          />
        )}
        <View style={styles.cardIdBadge}>
          <Ionicons name="folder" size={13} color="#2563EB" style={{ marginRight: 4 }} />
          <Text style={styles.projectIdText}>{item.project_id}</Text>
        </View>

        <View style={{ flex: 1 }} />

        {exactTime ? <Text style={styles.timeText}>{exactTime}</Text> : null}
      </View>

      <Text style={styles.cardTitle} numberOfLines={2}>{item.project_title || 'Untitled Project'}</Text>
      {item.project_type ? <Text style={styles.cardType}>{item.project_type}</Text> : null}
      {isRecoveryMode && <Text style={{fontSize: 10, color: '#EF4444', fontWeight: 'bold', marginTop: 2, marginBottom: 4}}>Owner: {item.ownerId}</Text>}

      <View style={styles.cardMetaRow}>
        <View style={styles.metaItem}>
          <Ionicons name="pricetag-outline" size={13} color="#64748B" style={{ marginRight: 4 }} />
          <Text style={styles.metaText} numberOfLines={1}>Tender: {item.tender_id || 'N/A'}</Text>
        </View>
        <View style={[styles.metaItem, { justifyContent: 'flex-end' }]}>
          <Ionicons name="location-outline" size={13} color="#64748B" style={{ marginRight: 4 }} />
          <Text style={styles.metaText} numberOfLines={1}>{item.ulb || 'Unknown'}, {item.state || ''}</Text>
        </View>
      </View>

      <View style={styles.cardFooter}>
        <View style={styles.dovContainer}>
          <Ionicons name="calendar-outline" size={13} color="#1D4ED8" style={{ marginRight: 5 }} />
          <Text style={styles.dovText}>
            {visitDateDisplay.startsWith('No') ? visitDateDisplay : `Visited: ${visitDateDisplay}`}
          </Text>
        </View>

        <View style={styles.statsPillRow}>
          {item.mediaStats?.geo > 0 && (
            <View style={[styles.miniStatBadge, { backgroundColor: '#ECFEFF', borderColor: '#CFFAFE' }]}>
              <Ionicons name="location" size={10} color="#0891B2" />
              <Text style={[styles.miniStatText, { color: '#0891B2' }]}>{item.mediaStats.geo}</Text>
            </View>
          )}
          {item.mediaStats?.photos > 0 && (
            <View style={[styles.miniStatBadge, { backgroundColor: '#F5F3FF', borderColor: '#DDD6FE' }]}>
              <Ionicons name="camera" size={10} color="#7C3AED" />
              <Text style={[styles.miniStatText, { color: '#7C3AED' }]}>{item.mediaStats.photos}</Text>
            </View>
          )}
          <View style={styles.fileCountBadge}>
            <Text style={styles.fileCountText}>{item.totalFiles || 0} files</Text>
          </View>
        </View>
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
              onPress={onLocate}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  card: { backgroundColor: '#FFF', borderRadius: 12, padding: 10, marginBottom: 8, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, borderWidth: 1, borderColor: '#F1F5F9' },
  cardSelected: { borderColor: '#3B82F6', backgroundColor: '#EFF6FF', borderWidth: 1.5, shadowColor: '#3B82F6', shadowOpacity: 0.15 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  cardIdBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EFF6FF', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#DBEAFE' },
  projectIdText: { fontSize: 12, fontWeight: '700', color: '#1D4ED8', letterSpacing: 0.3 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#1E293B', lineHeight: 22, marginBottom: 2 },
  cardType: { fontSize: 11, color: '#2563EB', fontWeight: '700', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.3 },
  timeText: { fontSize: 11, color: '#94A3B8', fontWeight: '600', marginRight: 8 },
  locateBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ECFDF5', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: '#A7F3D0' },
  locateBtnText: { color: '#059669', fontSize: 11, fontWeight: '700', marginLeft: 4 },
  pinBtnRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 8, width: '100%' },
  pinBtnHalf: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, elevation: 1 },
  pinBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },
  
  cardMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  metaItem: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  metaText: { fontSize: 12, color: '#64748B', fontWeight: '500' },
  
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderColor: '#F1F5F9', paddingTop: 8 },
  dovContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EFF6FF', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6 },
  dovText: { color: '#1D4ED8', fontSize: 11, fontWeight: '600' },
  
  statsPillRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  miniStatBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  miniStatText: { fontSize: 10, fontWeight: '700', marginLeft: 3 },
  fileCountBadge: { backgroundColor: '#F1F5F9', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  fileCountText: { fontSize: 11, fontWeight: '600', color: '#64748B' },
  
  centerLoading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC' },
  header: { padding: 16, paddingTop: 52, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#F1F5F9', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.02, shadowRadius: 4, zIndex: 10 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: '800', color: '#0F172A', letterSpacing: -0.5 },
  subTitle: { fontSize: 12, color: '#64748B', fontWeight: '500', marginTop: 2 },
  recoveryBadge: { backgroundColor: '#EF4444', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginLeft: 8 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#F8FAFC', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  
  searchSortRow: { marginTop: 14 },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  searchBarText: { fontSize: 14, color: '#94A3B8', marginLeft: 8 },
  activeSearchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', borderRadius: 10, borderWidth: 1.5, borderColor: '#2563EB', shadowColor: '#2563EB', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4 },
  searchInput: { flex: 1, paddingVertical: 10, paddingHorizontal: 10, fontSize: 14, color: '#0F172A' },
  
  statChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  statChipText: { fontSize: 11, fontWeight: '700' },
  filterRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  filterLabel: { fontSize: 12, color: '#64748B', fontWeight: '600', marginRight: 8 },
  filterChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#E2E8F0', marginRight: 8 },
  filterChipText: { fontSize: 12, color: '#334155', fontWeight: '600' },
  sortDirectionBtn: { padding: 6, backgroundColor: '#F8FAFC', borderRadius: 16, borderWidth: 1, borderColor: '#E2E8F0' },
  
  modalSearchInput: { paddingVertical: 12, paddingHorizontal: 16, fontSize: 16, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', color: '#0F172A' },
  dateHeaderWrapper: { backgroundColor: '#F8FAFC', paddingVertical: 12 },
  dateHeaderContainer: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16 },
  dateHeader: { flexDirection: 'row', alignItems: 'center' },
  dateHeaderText: { color: '#0F172A', fontSize: 15, fontWeight: '700' },
  
  emptyBox: { alignItems: 'center', marginTop: 100 },
  emptyText: { fontSize: 18, fontWeight: '700', color: '#334155', marginTop: 16 },
  emptySubText: { fontSize: 14, color: '#94A3B8', textAlign: 'center', marginTop: 8, paddingHorizontal: 40, lineHeight: 20 },
  
  bulkActionBar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#FFF', padding: 20, paddingBottom: 35, borderTopWidth: 1, borderColor: '#F1F5F9', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', elevation: 20, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.05, shadowRadius: 10 },
  bulkCount: { fontSize: 16, fontWeight: '800', color: '#0F172A' },
  bulkSize: { fontSize: 13, color: '#64748B', fontWeight: '500', marginTop: 2 },
  bulkBtn: { flexDirection: 'row', height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15, 23, 42, 0.8)', justifyContent: 'center', alignItems: 'center', zIndex: 100 },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.6)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '80%', paddingBottom: 24 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 24, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#0F172A' },
  modalItem: { padding: 18, paddingHorizontal: 24, borderBottomWidth: 1, borderColor: '#F8FAFC' },
  modalItemText: { fontSize: 16, color: '#475569', fontWeight: '500' }
});