import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Share, Image, Modal, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { zip } from 'react-native-zip-archive';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { doc, getDoc } from 'firebase/firestore';
import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import ImageViewing from 'react-native-image-viewing';

import VisitManager from '../../components/VisitManager';
import { generateCloudLinkAndUpload } from '../../utils/cloudUploader';
import { db as firestoreDb } from '../../utils/firebaseConfig';
import { globalStyles } from '../../styles/globalStyles';
import { getActiveUserId, getActiveUsername, setDashboardDirty } from '../../utils/userSession';
import { previousQuarter, getQuarterStr, getQuarterFromYYYYMMDD } from '../../utils/period';

const { StorageAccessFramework } = FileSystem;

const parseDateString = (dateStr: string) => {
  if (!dateStr) return 0;
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    if (parts[0].length === 4) return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])).getTime();
    return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])).getTime();
  }
  return new Date(dateStr).getTime() || 0;
};

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};



export default function ProjectDetails() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const sqlDb = SQLite.useSQLiteContext();
  
  const rawId = typeof params.id === 'string' ? params.id : (Array.isArray(params.id) ? params.id[0] : 'UNKNOWN_PROJ');
  const rawTenderId = typeof params.tender_id === 'string' ? params.tender_id : (Array.isArray(params.tender_id) ? params.tender_id[0] : 'UNKNOWN_TENDER');
  
  const projectId = decodeURIComponent(rawId);
  const tenderId = decodeURIComponent(rawTenderId);
  
  const defaultFolder = `${projectId}_${tenderId || 'UNKNOWN_TENDER'}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  const [activeTab, setActiveTab] = useState<'details' | 'gallery' | 'visits'>('details');
  const [visitRecords, setVisitRecords] = useState<any[]>([]);
  const [recordsSource, setRecordsSource] = useState<string>('');
  const [recordsLoading, setRecordsLoading] = useState<boolean>(false);
  const [activeMediaFilter, setActiveMediaFilter] = useState<'all' | 'photos' | 'comments' | 'audio' | 'docs'>('all');
  const [playingAudioUri, setPlayingAudioUri] = useState<string | null>(null);
  const soundRef = useRef<AudioPlayer | null>(null);
  const [previewMediaItem, setPreviewMediaItem] = useState<any | null>(null);
  const [previewMediaIndex, setPreviewMediaIndex] = useState<number>(0);

  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [project, setProject] = useState<any>(null);
  
  const [activeFolder, setActiveFolder] = useState(defaultFolder);
  const [hasKml, setHasKml] = useState(false);
  const [lastVisited, setLastVisited] = useState<string | null>(null);
  const [plannerItems, setPlannerItems] = useState<any[]>([]); 
  
  const [latestObs, setLatestObs] = useState<any[]>([]);
  const [prevObs, setPrevObs] = useState<any[]>([]);
  const [showAllObs, setShowAllObs] = useState(false);
  const [isScopeExpanded, setIsScopeExpanded] = useState(false);
  const [hasEdited, setHasEdited] = useState(false);

  const [exportState, setExportState] = useState<{ active: boolean, status: string, isCancellable: boolean }>({ active: false, status: '', isCancellable: false });
  const isExportingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        try {
          soundRef.current.pause();
          soundRef.current.remove();
        } catch (e) {}
      }
    };
  }, []);

  const loadGalleryMedia = useCallback(async (userId: string, targetFolder: string) => {
    setRecordsLoading(true);
    try {
      const baseDir = `${FileSystem.documentDirectory}projects/${userId}/${targetFolder}/`;
      const dirInfo = await FileSystem.getInfoAsync(baseDir);
      if (!dirInfo.exists) {
        setVisitRecords([]);
        setRecordsSource('');
        setRecordsLoading(false);
        return;
      }

      const files = await FileSystem.readDirectoryAsync(baseDir);
      const visitDirs = files.filter(f => f.startsWith('VISIT_')).sort();

      if (visitDirs.length === 0) {
        setVisitRecords([]);
        setRecordsSource('');
        setRecordsLoading(false);
        return;
      }

      const checkSubFolders = ['Geotag Captures', 'Normal Captures', 'Notes', 'Comments', 'Documents', 'Attachments', 'Location Pins'];
      const imageExtensions = ['jpg', 'jpeg', 'png', 'webp'];
      const videoExtensions = ['mp4', 'mov'];
      const audioExtensions = ['m4a', 'wav', 'mp3', 'aac', 'ogg'];

      const collectRecordsFromVisit = async (visitName: string) => {
        const found: any[] = [];
        const visitPath = `${baseDir}${visitName}/`;
        for (const sub of checkSubFolders) {
          const subPath = `${visitPath}${sub}/`;
          try {
            const sInfo = await FileSystem.getInfoAsync(subPath);
            if (sInfo.exists && sInfo.isDirectory) {
              const subFiles = await FileSystem.readDirectoryAsync(subPath);
              for (const sf of subFiles) {
                if (sf.endsWith('.json') || sf.startsWith('.')) continue;
                const ext = sf.split('.').pop()?.toLowerCase() || '';
                const fileUri = `${subPath}${sf}`;
                const fileStat = await FileSystem.getInfoAsync(fileUri).catch(() => null);
                if (!fileStat || !fileStat.exists || fileStat.isDirectory) continue;

                let type: 'image' | 'video' | 'comment' | 'audio' | 'document' = 'document';
                let content: string | undefined = undefined;

                if (imageExtensions.includes(ext)) {
                  type = 'image';
                } else if (videoExtensions.includes(ext)) {
                  type = 'video';
                } else if (audioExtensions.includes(ext)) {
                  type = 'audio';
                } else if (ext === 'txt') {
                  type = 'comment';
                  content = await FileSystem.readAsStringAsync(fileUri).catch(() => '');
                } else {
                  type = 'document';
                }

                found.push({
                  id: `${visitName}_${sub}_${sf}`,
                  type,
                  fileName: sf,
                  uri: fileUri,
                  folder: sub,
                  visitName,
                  size: fileStat.size || 0,
                  time: fileStat.modificationTime || 0,
                  content,
                });
              }
            }
          } catch (e) {}
        }
        return found;
      };

      // 1. Identify previous trimester
      const prev = previousQuarter();
      const prevQuarterStr = `${prev.year}-Q${prev.q}`;
      const prevToPrev = previousQuarter(prev.q, prev.year);
      const prevToPrevQuarterStr = `${prevToPrev.year}-Q${prevToPrev.q}`;

      const getVisitsForQuarter = (quarterStr: string) => visitDirs.filter(v => {
        const match = v.match(/_(\d{8})_/);
        if (match) {
          return getQuarterFromYYYYMMDD(match[1]) === quarterStr;
        }
        return false;
      });

      let records: any[] = [];
      let sourceName = '';
      let targetQuarterStr = prevQuarterStr;

      const prevTrimesterVisits = getVisitsForQuarter(prevQuarterStr);
      if (prevTrimesterVisits.length > 0) {
        for (const pv of prevTrimesterVisits) {
          const vRecords = await collectRecordsFromVisit(pv);
          records = records.concat(vRecords);
        }
      }

      // 2. If no records from previous trimester, fallback to previous-to-previous trimester
      if (records.length === 0) {
        const prevToPrevVisits = getVisitsForQuarter(prevToPrevQuarterStr);
        if (prevToPrevVisits.length > 0) {
          targetQuarterStr = prevToPrevQuarterStr;
          for (const pv of prevToPrevVisits) {
            const vRecords = await collectRecordsFromVisit(pv);
            records = records.concat(vRecords);
          }
        }
      }

      // 3. Format sourceName based on the latest visit date
      if (records.length > 0) {
        let latestVisitName = '';
        for (let i = records.length - 1; i >= 0; i--) {
           if (records[i].visitName) {
               latestVisitName = records[i].visitName;
               break;
           }
        }
        const match = latestVisitName.match(/_(\d{8})_/);
        let dateFormatted = latestVisitName;
        if (match && match[1].length === 8) {
          const d = match[1];
          dateFormatted = `${d.substring(6, 8)}-${d.substring(4, 6)}-${d.substring(0, 4)}`;
        }
        const qPart = targetQuarterStr.split('-')[1] || targetQuarterStr;
        sourceName = `Last Visit (${dateFormatted}) [${qPart}]`;
      }

      records.sort((a, b) => (b.time || 0) - (a.time || 0));
      setVisitRecords(records);
      setRecordsSource(sourceName);
    } catch (e) {
      console.warn("Failed loading visit records", e);
      setVisitRecords([]);
      setRecordsSource('');
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  const handleToggleAudio = async (uri: string) => {
    try {
      if (soundRef.current) {
        try {
          soundRef.current.pause();
          soundRef.current.remove();
        } catch (e) {}
        soundRef.current = null;
      }
      if (playingAudioUri === uri) {
        setPlayingAudioUri(null);
        return;
      }
      const player = createAudioPlayer({ uri });
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) {
          setPlayingAudioUri(null);
        }
      });
      player.play();
      soundRef.current = player;
      setPlayingAudioUri(uri);
    } catch (err) {
      Alert.alert("Playback Error", "Could not play this voice note.");
      setPlayingAudioUri(null);
    }
  };

  const handleOpenDoc = async (item: any) => {
    if (item.fileName.toLowerCase().endsWith('.kml')) {
      try {
        const content = await FileSystem.readAsStringAsync(item.uri);
        const coordMatch = content.match(/<coordinates>[\s\S]*?([0-9.-]+)\s*,\s*([0-9.-]+)/i);
        if (coordMatch) {
          Linking.openURL(`https://maps.google.com/?q=${coordMatch[2].trim()},${coordMatch[1].trim()}`);
          return;
        }
      } catch (e) {}
    }
    
    try {
      if (Platform.OS === 'android') {
        try {
          const IntentLauncher = require('expo-intent-launcher');
          const cUri = await FileSystem.getContentUriAsync(item.uri);
          await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: cUri,
            flags: 1,
            type: item.fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '*/*',
          });
          return;
        } catch {
          await Sharing.shareAsync(item.uri);
        }
      } else {
        await Sharing.shareAsync(item.uri);
      }
    } catch (e) {
      Alert.alert("Unable to open", "Could not preview this file.");
    }
  };

  const photoRecords = useMemo(() => visitRecords.filter(r => r.type === 'image' || r.type === 'video'), [visitRecords]);
  const commentRecords = useMemo(() => visitRecords.filter(r => r.type === 'comment'), [visitRecords]);
  const audioRecords = useMemo(() => visitRecords.filter(r => r.type === 'audio'), [visitRecords]);
  const docRecords = useMemo(() => visitRecords.filter(r => r.type === 'document'), [visitRecords]);

  const displayedRecords = useMemo(() => {
    if (activeMediaFilter === 'photos') return photoRecords;
    if (activeMediaFilter === 'comments') return commentRecords;
    if (activeMediaFilter === 'audio') return audioRecords;
    if (activeMediaFilter === 'docs') return docRecords;
    return visitRecords;
  }, [visitRecords, activeMediaFilter, photoRecords, commentRecords, audioRecords, docRecords]);

  const loadData = useCallback(async () => {
    if (!projectId || projectId === 'UNKNOWN_PROJ') return;
    setLoading(true); setDbError(null);
    try {
      const userId = await getActiveUserId();
      
      let tenderData: any = {};
      try {
         tenderData = sqlDb.getFirstSync(`SELECT * FROM tenders WHERE project_id = ? AND tender_id = ? LIMIT 1`, [projectId, tenderId]);
         if (!tenderData) {
             tenderData = sqlDb.getFirstSync(`SELECT * FROM tenders WHERE project_id = ? LIMIT 1`, [projectId]) || {};
         }
      } catch (e) { console.warn(e); }

      let detailsData: any = {};
      try {
         detailsData = sqlDb.getFirstSync(`SELECT * FROM project_details WHERE project_id = ? LIMIT 1`, [projectId]) || {};
      } catch (e) { console.warn(e); }

      const mergedProj = { ...detailsData };
      Object.keys(tenderData).forEach(key => {
        if (tenderData[key] !== null && tenderData[key] !== undefined && tenderData[key] !== '') {
          mergedProj[key] = tenderData[key];
        }
      });
      
      if (Object.keys(mergedProj).length === 0) {
          setProject(null);
          setLoading(false);
          return;
      }
      setProject(mergedProj);

      let obsData: any[] = [];
      try {
          obsData = sqlDb.getAllSync(`SELECT * FROM observations WHERE project_code = ?`, [projectId]) as any[];
      } catch (e) { console.warn(e); }

      if (obsData && obsData.length > 0) {
        const sortedObs = [...obsData].sort((a: any, b: any) => parseDateString(b.visit_date) - parseDateString(a.visit_date));
        const mostRecentDate = (sortedObs[0]?.visit_date || '').trim();
        const latest = sortedObs.filter((o: any) => (o.visit_date || '').trim() === mostRecentDate);
        const previous = sortedObs.filter((o: any) => (o.visit_date || '').trim() !== mostRecentDate);
        setLatestObs(latest);
        setPrevObs(previous);
      } else {
        setLatestObs([]);
        setPrevObs([]);
      }

      // Deeply resolve actual folder on disk vs fallback sanitized name
      let resolvedFolder = defaultFolder;
      const baseDir = `${FileSystem.documentDirectory}projects/${userId}/`;
      try {
          const info = await FileSystem.getInfoAsync(baseDir);
          if (info.exists) {
              const folders = await FileSystem.readDirectoryAsync(baseDir);
              const cleanProjId = projectId.replace(/[^a-zA-Z0-9_-]/g, '_');
              const matched = folders.find(f => f !== 'SQLite' && !f.endsWith('.json') && f.includes(cleanProjId));
              if (matched) resolvedFolder = matched;
          }
      } catch(e) {}
      setActiveFolder(resolvedFolder);

      // Load gallery media from resolved folder
      await loadGalleryMedia(userId, resolvedFolder);

      // Extract Last Visited String
      const path = `${baseDir}${resolvedFolder}/`;
      try {
          const files = await FileSystem.readDirectoryAsync(path);
          let latestDateStr = '';
          for(const f of files) {
              if(f.startsWith('VISIT_')) {
                  const parts = f.split('_');
                  const datePart = parts[2];
                  if(datePart && datePart.length === 8 && datePart > latestDateStr) {
                      latestDateStr = datePart;
                  }
              }
          }
          if(latestDateStr) {
              setLastVisited(`${latestDateStr.substring(6,8)}-${latestDateStr.substring(4,6)}-${latestDateStr.substring(0,4)}`);
          } else {
              setLastVisited('Not visited yet');
          }
      } catch(e) {
          setLastVisited('Not visited yet');
      }

      // Check recursive KML inside resolvedFolder
      let foundKml = false;
      const checkDir = async (dirPath: string) => {
        if (foundKml) return;
        try {
            const dInfo = await FileSystem.getInfoAsync(dirPath);
            if (!dInfo.exists || !dInfo.isDirectory) return;
            const items = await FileSystem.readDirectoryAsync(dirPath);
            for (const item of items) {
                if (foundKml) return;
                if (item.toLowerCase().endsWith('.kml')) { foundKml = true; return; }
                const subPath = `${dirPath}${item}`;
                const subInfo = await FileSystem.getInfoAsync(subPath);
                if (subInfo.isDirectory) await checkDir(`${subPath}/`);
            }
        } catch(e) {}
      };
      await checkDir(path);
      setHasKml(foundKml);

      // Planner load
      try {
          const plannerPath = `${baseDir}planner_cache.json`;
          const plannerInfo = await FileSystem.getInfoAsync(plannerPath);
          if (plannerInfo.exists) {
              setPlannerItems(JSON.parse(await FileSystem.readAsStringAsync(plannerPath)));
          }
      } catch(e) {}

      setLoading(false);
    } catch (error: any) {
      setDbError(`Database Interruption: ${error.message}`); setLoading(false);
    }
  }, [projectId, tenderId, sqlDb, defaultFolder, loadGalleryMedia]);

  useEffect(() => {
    let isMounted = true;
    if (!projectId) return;
    const timeout = setTimeout(() => { 
      if (isMounted) loadData(); 
    }, 50);
    return () => { isMounted = false; clearTimeout(timeout); };
  }, [loadData, projectId]);

  const handleBackNavigation = () => router.back();

  const handleDirectSaveToDevice = async () => {
    if (isExportingRef.current) return;
    const userId = await getActiveUserId();
    const sourcePath = `${FileSystem.documentDirectory}projects/${userId}/${activeFolder}/`;
    
    const dirInfo = await FileSystem.getInfoAsync(sourcePath);
    if (!dirInfo.exists) return Alert.alert("No Data", "No project data exists to save yet.");
    
    try {
      let targetDirUri = await SecureStore.getItemAsync('irma_saf_directory_uri');
      
      if (!targetDirUri) {
          const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
          if (!permissions.granted) return;
          targetDirUri = permissions.directoryUri;
          await SecureStore.setItemAsync('irma_saf_directory_uri', targetDirUri);
      }
      try { await StorageAccessFramework.readDirectoryAsync(targetDirUri); }
      catch(e) {
          const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
          if (!permissions.granted) return;
          targetDirUri = permissions.directoryUri;
          await SecureStore.setItemAsync('irma_saf_directory_uri', targetDirUri);
      }

      isExportingRef.current = true;
      setExportState({ active: true, status: 'Copying to device...', isCancellable: false });
      
      const timestamp = new Date().toISOString().replace(/[:.-]/g, '_');
      const exportDirUri = await StorageAccessFramework.makeDirectoryAsync(targetDirUri, `IRMA_Project_${activeFolder}_${timestamp}`);
      
      const traverseAndCopy = async (localPath: string, safParentUri: string) => {
          const files = await FileSystem.readDirectoryAsync(localPath);
          for (const file of files) {
              const fullLocalPath = `${localPath}${file}`;
              const info = await FileSystem.getInfoAsync(fullLocalPath);
              if (info.isDirectory) {
                  const newSafDirUri = await StorageAccessFramework.makeDirectoryAsync(safParentUri, file);
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
                  
                  const safFileUri = await StorageAccessFramework.createFileAsync(safParentUri, file, mimeType);
                  await FileSystem.writeAsStringAsync(safFileUri, content, { encoding: FileSystem.EncodingType.Base64 });
              }
          }
      };

      await traverseAndCopy(sourcePath, exportDirUri);
      Alert.alert("Success", "Project saved securely to your device folder.");
    } catch (e) {
       Alert.alert("Error", "Failed to save to device.");
    } finally {
       isExportingRef.current = false;
       setExportState({ active: false, status: '', isCancellable: false });
    }
  };

  const handleOpenProjectKml = async () => {
    const userId = await getActiveUserId();
    const exactPath = `${FileSystem.documentDirectory}projects/${userId}/${activeFolder}/`;
    
    const safeInfo = async (path: string) => {
      try {
        const i = await FileSystem.getInfoAsync(path);
        return i.exists ? i : null;
      } catch { return null; }
    };
    
    try {
      let latestKmlUri = ''; let latestTime = 0;
      const findLatestKml = async (currentPath: string) => {
        try {
          const info = await FileSystem.getInfoAsync(currentPath);
          if (!info.exists || !info.isDirectory) return;
          const files = await FileSystem.readDirectoryAsync(currentPath);
          for (const file of files) {
            const fullPath = `${currentPath}${file}`;
            const fileInfo = await safeInfo(fullPath);
            if (!fileInfo) continue;
            if (fileInfo.isDirectory) { await findLatestKml(`${fullPath}/`); }
            else if (file.toLowerCase().endsWith('.kml')) {
              const modTime = fileInfo.modificationTime ?? 0;
              if (modTime >= latestTime) {
                latestTime = modTime; latestKmlUri = fullPath;
              }
            }
          }
        } catch(e) {}
      };
      
      await findLatestKml(exactPath);

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

  const handleShareOptions = async () => {
    if (isExportingRef.current) return;
    const userId = await getActiveUserId();
    const sourcePath = `${FileSystem.documentDirectory}projects/${userId}/${activeFolder}/`;
    
    const dirInfo = await FileSystem.getInfoAsync(sourcePath);
    if (!dirInfo.exists) return Alert.alert("No Data", "No files exist to share.");

    Alert.alert("Share Project Data", "Select export method:", [
      { text: "Cancel", style: "cancel" },
      { text: "Share Link (Cloud)", onPress: () => handleCloudShare(sourcePath) },
      { text: "Share ZIP (Local)", onPress: () => handleLocalShare(sourcePath) }
    ]);
  };

  const handleCloudShare = async (sourcePath: string) => {
    try {
      isExportingRef.current = true;
      setExportState({ active: true, status: 'Preparing Cloud Sync...', isCancellable: false });

      const uName = await getActiveUsername();

      const { expectedUrl, startBackgroundUpload } = await generateCloudLinkAndUpload(activeFolder, sourcePath, uName, { totalFiles: 1, totalSize: 1, maxModTime: Date.now() }, (status) => {
         setExportState(prev => ({ ...prev, status }));
      });
      
      await Share.share({ message: `Project Data Link for ${projectId}:\n${expectedUrl}` });

      startBackgroundUpload().finally(() => {
        isExportingRef.current = false;
        setExportState({ active: false, status: '', isCancellable: false });
      });
    } catch (e) {
      isExportingRef.current = false; setExportState({ active: false, status: '', isCancellable: false });
      Alert.alert("Export Error", "Failed to initialize cloud upload.");
    }
  };

  const handleLocalShare = async (sourcePath: string) => {
    try {
      isExportingRef.current = true;
      setExportState({ active: true, status: 'Compressing directory...', isCancellable: true });
      const targetZipPath = `${FileSystem.cacheDirectory}${activeFolder}.zip`;
      
      await zip(sourcePath.replace('file://', ''), targetZipPath.replace('file://', ''));
      setExportState({ active: false, status: '', isCancellable: false });
      await Sharing.shareAsync(targetZipPath);
      isExportingRef.current = false;
    } catch (e) {
      isExportingRef.current = false; setExportState({ active: false, status: '', isCancellable: false });
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Alert.alert("Copied", `${label} details copied to clipboard.`);
  };

  const handleAddToPlanner = async () => {
    const uid = await getActiveUserId();
    const path = `${FileSystem.documentDirectory}projects/${uid}/planner_cache.json`;
    let items = [...plannerItems];
    const strictId = `${project?.project_id || projectId}_${project?.tender_id || tenderId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    if (!items.some(i => i.projectId === (project?.project_id || projectId))) {
        items.push({ id: strictId, projectId: project?.project_id || projectId, tenderId: project?.tender_id || tenderId, title: project?.project_title || 'Untitled', ulb: project?.ulb || 'Unknown' });
        setPlannerItems(items);
        await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}projects/${uid}/`, {intermediates: true}).catch(()=>{});
        await FileSystem.writeAsStringAsync(path, JSON.stringify(items));
        Alert.alert("Added to Planner", `Project added to Visits Pending list.`);
    } else {
        Alert.alert("Already Planned", "This project is already in your planner.");
    }
  };

  if (loading) return <View style={globalStyles.centerContainer}><ActivityIndicator size="large" color="#2563EB" /><Text style={{ marginTop: 10, color: '#64748B' }}>Fetching Project Details...</Text></View>;
  
  if (dbError || !project) return (
    <View style={globalStyles.centerContainer}>
      <Ionicons name="warning" size={48} color="#EF4444" style={{ marginBottom: 10 }} />
      <Text style={styles.errorText}>{!project ? "Project Not Found" : "Connection Interrupted"}</Text>
      <TouchableOpacity onPress={() => loadData()} style={[styles.goBackBtn, { backgroundColor: '#10B981', marginBottom: 10 }]}><Text style={{color: '#FFF'}}>Retry</Text></TouchableOpacity>
      <TouchableOpacity onPress={handleBackNavigation} style={[styles.goBackBtn, { backgroundColor: '#64748B' }]}><Text style={{color: '#FFF'}}>Return</Text></TouchableOpacity>
    </View>
  );

  const displayedPrevObs = showAllObs ? prevObs : prevObs.slice(0, 5);
  const isAlreadyPlanned = plannerItems.some(i => i.projectId === project.project_id);
  const hasVisited = lastVisited !== 'Not visited yet' || latestObs.length > 0 || prevObs.length > 0 || hasEdited || hasKml;

  return (
    <View style={globalStyles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBackNavigation} style={styles.backBtn}><Ionicons name="arrow-back" size={24} color="#1E293B" /></TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[styles.headerTitle, { textAlign: 'center' }]} numberOfLines={1}>{project.project_id || projectId}</Text>
          <Text style={[styles.headerSub, { textAlign: 'center' }]}>{project.ulb}, {project.state}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {(!isAlreadyPlanned && !hasVisited) && (
            <TouchableOpacity onPress={handleAddToPlanner} style={[styles.backBtn, { marginRight: 10 }]}>
              <Ionicons name="add-circle" size={26} color="#10B981" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleDirectSaveToDevice} style={[styles.backBtn, { marginRight: 10 }]}>
            <Ionicons name="download-outline" size={24} color="#10B981" />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleShareOptions} style={styles.backBtn}>
            <Ionicons name="share-social" size={24} color="#2563EB" />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.tabContainer}>
         <TouchableOpacity onPress={() => setActiveTab('details')} style={[styles.tabBtn, activeTab === 'details' && styles.tabBtnActive]}>
            <Ionicons name="document-text" size={15} color={activeTab === 'details' ? "#2563EB" : "#64748B"} style={{marginRight: 5}} />
            <Text style={[styles.tabText, activeTab === 'details' && styles.tabTextActive]}>Project Info</Text>
         </TouchableOpacity>
         <TouchableOpacity 
           onPress={() => {
             setActiveTab('gallery');
             getActiveUserId().then(uid => loadGalleryMedia(uid, activeFolder));
           }} 
           style={[styles.tabBtn, activeTab === 'gallery' && styles.tabBtnActive]}
         >
            <Ionicons name="folder-open" size={15} color={activeTab === 'gallery' ? "#2563EB" : "#64748B"} style={{marginRight: 5}} />
            <Text style={[styles.tabText, activeTab === 'gallery' && styles.tabTextActive]} numberOfLines={1}>History</Text>
         </TouchableOpacity>
         <TouchableOpacity onPress={() => setActiveTab('visits')} style={[styles.tabBtn, activeTab === 'visits' && styles.tabBtnActive]}>
            <Ionicons name="location" size={15} color={activeTab === 'visits' ? "#2563EB" : "#64748B"} style={{marginRight: 5}} />
            <Text style={[styles.tabText, activeTab === 'visits' && styles.tabTextActive]}>Field Visits</Text>
         </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={[globalStyles.scrollContent, { paddingBottom: 150 }]}>
        <View style={{ display: activeTab === 'details' ? 'flex' : 'none' }}>
            {/* Top Overview Card */}
            <View style={styles.infoCard}>
              <Text style={[styles.projectTitle, { textAlign: 'center' }]}>{project.project_title || 'Untitled Project'}</Text>
              
              <View style={[styles.badgeRow, { justifyContent: 'center' }]}>
                <View style={styles.typeBadge}>
                  <Text style={styles.typeBadgeText}>{project.project_type || 'N/A'}</Text>
                </View>
                <View style={styles.visitedBadge}>
                  <Ionicons name="calendar-outline" size={13} color="#16A34A" style={{ marginRight: 4 }} />
                  <Text style={styles.visitedBadgeText}>Last Visited: {lastVisited || 'Loading...'}</Text>
                </View>
              </View>
            </View>

            {/* Tender & Project Specifications */}
            <View style={styles.infoCard}>
              <Text style={styles.cardHeaderTitle}>Tender & Specifications</Text>
              <InfoRow label="Tender ID" value={project.tender_id || tenderId} />
              <InfoRow label="Bidder Name" value={project.bidder_name} />
              <InfoRow label="No. of Tenders" value={project.no_of_tenders} />
              <InfoRow label="NIT Date" value={project.nit_date} />
              <InfoRow label="Award Date" value={project.award_date} />
              <InfoRow label="Sch. Completion" value={project.sch_project_completion_date} isLast />
            </View>

            {/* Financial & Physical Metrics (Compact) */}
            <View style={styles.infoCard}>
              <Text style={styles.cardHeaderTitle}>Financials & Progress</Text>
              
              <View style={styles.financeGrid}>
                <View style={styles.financeTile}>
                  <Text style={styles.financeTileLabel}>Est. CAPEX</Text>
                  <Text style={styles.financeTileVal}>{project.est_capex ? `₹${project.est_capex} Cr` : 'N/A'}</Text>
                </View>
                <View style={styles.financeTile}>
                  <Text style={styles.financeTileLabel}>Awarded CAPEX</Text>
                  <Text style={[styles.financeTileVal, { color: '#2563EB' }]}>
                    {project.awarded_capex || project.capex ? `₹${project.awarded_capex || project.capex} Cr` : 'N/A'}
                  </Text>
                </View>
                <View style={styles.financeTile}>
                  <Text style={styles.financeTileLabel}>Est. O&M</Text>
                  <Text style={styles.financeTileVal}>{project.est_om ? `₹${project.est_om} Cr` : 'N/A'}</Text>
                </View>
                <View style={styles.financeTile}>
                  <Text style={styles.financeTileLabel}>Awarded O&M</Text>
                  <Text style={[styles.financeTileVal, { color: '#2563EB' }]}>
                    {project.awarded_om || project.om ? `₹${project.awarded_om || project.om} Cr` : 'N/A'}
                  </Text>
                </View>
              </View>

              <View style={styles.progressSummaryRow}>
                <View style={[styles.progressMetricBox, { borderColor: '#BBF7D0', backgroundColor: '#F0FDF4' }]}>
                  <Text style={styles.progressMetricLabel}>Physical Progress</Text>
                  <Text style={[styles.progressMetricVal, { color: '#16A34A' }]}>
                    {project.physical_progress ? `${project.physical_progress}%` : 'N/A'}
                  </Text>
                </View>
                <View style={[styles.progressMetricBox, { borderColor: '#FED7AA', backgroundColor: '#FFFBEB' }]}>
                  <Text style={styles.progressMetricLabel}>Financial Progress</Text>
                  <Text style={[styles.progressMetricVal, { color: '#D97706' }]}>
                    {project.financial_progress ? `${project.financial_progress}%` : 'N/A'}
                  </Text>
                </View>
              </View>
            </View>

            {/* Scope of Work */}
            <View style={styles.infoCard}>
              <Text style={styles.cardHeaderTitle}>Brief Scope of Work</Text>
              <Text style={styles.compactScopeText} numberOfLines={isScopeExpanded ? undefined : 3}>
                {project.scope || 'No scope details available.'}
              </Text>
              {((project.scope || '').length > 120) && (
                <TouchableOpacity onPress={() => setIsScopeExpanded(!isScopeExpanded)} style={styles.scopeToggleBtn}>
                  <Text style={styles.scopeToggleText}>{isScopeExpanded ? 'View Less' : 'View More'}</Text>
                  <Ionicons name={isScopeExpanded ? 'chevron-up' : 'chevron-down'} size={14} color="#2563EB" style={{ marginLeft: 4 }} />
                </TouchableOpacity>
              )}
            </View>

            {/* Personnel & Contacts */}
            <Text style={styles.sectionHeader}>Personnel & Contacts</Text>
            <ContactCard 
              title="State Officer" 
              name={project.state_officer} 
              designation="State Representative" 
              phone={project.so_contact} 
              email={project.so_email} 
              onCopy={copyToClipboard} 
            />
            <ContactCard 
              title="IRMA Personnel" 
              name={project.irma_personnel} 
              designation={project.designation || 'IRMA Personnel'} 
              phone={project.contact} 
              email={project.email} 
              onCopy={copyToClipboard} 
            />

            {/* Location Pins Section (Just after Personnel, KML Pin taking half the line) */}
            {(project.latitude || hasKml) && (() => {
              const hasMapPin = !!(project.latitude && project.longitude);
              const hasBoth = hasMapPin && hasKml;
              return (
                <View style={styles.pinBtnRow}>
                  {hasMapPin ? (
                    <TouchableOpacity 
                      style={[styles.pinBtnHalf, { backgroundColor: '#EAB308', flex: hasBoth ? 1 : 0, width: hasBoth ? undefined : '50%' }]} 
                      onPress={() => Linking.openURL(`https://maps.google.com/?q=${project.latitude},${project.longitude}`)}
                    >
                      <Ionicons name="navigate-circle-outline" size={18} color="#FFF" style={{ marginRight: 6 }} />
                      <Text style={styles.pinBtnText}>Map Pin</Text>
                    </TouchableOpacity>
                  ) : null}
                  {hasKml ? (
                    <TouchableOpacity 
                      style={[styles.pinBtnHalf, { backgroundColor: '#10B981', flex: hasBoth ? 1 : 0, width: hasBoth ? undefined : '50%' }]} 
                      onPress={handleOpenProjectKml}
                    >
                      <Ionicons name="earth" size={18} color="#FFF" style={{ marginRight: 6 }} />
                      <Text style={styles.pinBtnText}>KML Pin</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })()}
          </View>

        <View style={{ display: activeTab === 'gallery' ? 'flex' : 'none' }}>
          {recordsLoading ? (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <ActivityIndicator size="large" color="#2563EB" />
              <Text style={{ marginTop: 10, color: '#64748B', fontWeight: '600' }}>Loading Visit Records...</Text>
            </View>
          ) : visitRecords.length === 0 ? (
            <View style={styles.emptyGalleryCard}>
              <Ionicons name="folder-open-outline" size={48} color="#94A3B8" style={{ marginBottom: 12 }} />
              <Text style={styles.emptyGalleryTitle}>No visit records available</Text>
              <Text style={styles.emptyGallerySub}>No media, comments, voice notes, or documents found for previous trimester or recent visits.</Text>
              <TouchableOpacity 
                style={styles.goToVisitsBtn} 
                onPress={() => setActiveTab('visits')}
              >
                <Ionicons name="create-outline" size={16} color="#FFF" style={{ marginRight: 6 }} />
                <Text style={styles.goToVisitsBtnText}>Record in Field Visits</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View>
              {/* Summary Banner */}
              <View style={styles.galleryBanner}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name="time" size={16} color="#2563EB" style={{ marginRight: 6 }} />
                    <Text style={styles.galleryBannerTitle}>{recordsSource}</Text>
                  </View>
                  <Text style={styles.galleryBannerSub}>
                    {[
                      photoRecords.length > 0 ? `${photoRecords.length} ${photoRecords.length === 1 ? 'photo' : 'photos'}` : null,
                      commentRecords.length > 0 ? `${commentRecords.length} ${commentRecords.length === 1 ? 'comment' : 'comments'}` : null,
                      audioRecords.length > 0 ? `${audioRecords.length} ${audioRecords.length === 1 ? 'audio' : 'audios'}` : null,
                      docRecords.length > 0 ? `${docRecords.length} ${docRecords.length === 1 ? 'file' : 'files'}` : null,
                    ].filter(Boolean).join(' • ') || `${visitRecords.length} items`}
                  </Text>
                </View>
                <TouchableOpacity 
                  style={styles.refreshGalleryBtn}
                  onPress={() => getActiveUserId().then(uid => loadGalleryMedia(uid, activeFolder))}
                >
                  <Ionicons name="refresh" size={16} color="#2563EB" />
                </TouchableOpacity>
              </View>

              {/* Filter Pills */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.mediaFilterScroll} contentContainerStyle={styles.mediaFilterContent}>
                <TouchableOpacity 
                  style={[styles.mediaFilterPill, activeMediaFilter === 'all' && styles.mediaFilterPillActive]}
                  onPress={() => setActiveMediaFilter('all')}
                >
                  <Text style={[styles.mediaFilterPillText, activeMediaFilter === 'all' && styles.mediaFilterPillTextActive]}>
                    All ({visitRecords.length})
                  </Text>
                </TouchableOpacity>

                {photoRecords.length > 0 && (
                  <TouchableOpacity 
                    style={[styles.mediaFilterPill, activeMediaFilter === 'photos' && styles.mediaFilterPillActive]}
                    onPress={() => setActiveMediaFilter('photos')}
                  >
                    <Ionicons name="image-outline" size={13} color={activeMediaFilter === 'photos' ? '#FFF' : '#64748B'} style={{ marginRight: 4 }} />
                    <Text style={[styles.mediaFilterPillText, activeMediaFilter === 'photos' && styles.mediaFilterPillTextActive]}>
                      Photos ({photoRecords.length})
                    </Text>
                  </TouchableOpacity>
                )}

                {commentRecords.length > 0 && (
                  <TouchableOpacity 
                    style={[styles.mediaFilterPill, activeMediaFilter === 'comments' && styles.mediaFilterPillActive]}
                    onPress={() => setActiveMediaFilter('comments')}
                  >
                    <Ionicons name="chatbubble-ellipses-outline" size={13} color={activeMediaFilter === 'comments' ? '#FFF' : '#64748B'} style={{ marginRight: 4 }} />
                    <Text style={[styles.mediaFilterPillText, activeMediaFilter === 'comments' && styles.mediaFilterPillTextActive]}>
                      Comments ({commentRecords.length})
                    </Text>
                  </TouchableOpacity>
                )}

                {audioRecords.length > 0 && (
                  <TouchableOpacity 
                    style={[styles.mediaFilterPill, activeMediaFilter === 'audio' && styles.mediaFilterPillActive]}
                    onPress={() => setActiveMediaFilter('audio')}
                  >
                    <Ionicons name="mic-outline" size={13} color={activeMediaFilter === 'audio' ? '#FFF' : '#64748B'} style={{ marginRight: 4 }} />
                    <Text style={[styles.mediaFilterPillText, activeMediaFilter === 'audio' && styles.mediaFilterPillTextActive]}>
                      Voice ({audioRecords.length})
                    </Text>
                  </TouchableOpacity>
                )}

                {docRecords.length > 0 && (
                  <TouchableOpacity 
                    style={[styles.mediaFilterPill, activeMediaFilter === 'docs' && styles.mediaFilterPillActive]}
                    onPress={() => setActiveMediaFilter('docs')}
                  >
                    <Ionicons name="document-text-outline" size={13} color={activeMediaFilter === 'docs' ? '#FFF' : '#64748B'} style={{ marginRight: 4 }} />
                    <Text style={[styles.mediaFilterPillText, activeMediaFilter === 'docs' && styles.mediaFilterPillTextActive]}>
                      Files ({docRecords.length})
                    </Text>
                  </TouchableOpacity>
                )}
              </ScrollView>

              {/* Records List / Grid */}
              {displayedRecords.length === 0 ? (
                <View style={[styles.emptyGalleryCard, { padding: 25 }]}>
                  <Ionicons name="filter-outline" size={32} color="#94A3B8" style={{ marginBottom: 6 }} />
                  <Text style={{ color: '#64748B', fontSize: 13, fontWeight: '600', textAlign: 'center' }}>No records in this category.</Text>
                </View>
              ) : activeMediaFilter === 'all' ? (
                <View>
                  {/* Photos Section */}
                  {photoRecords.length > 0 && (
                    <View style={{ marginBottom: 14 }}>
                      <Text style={styles.recordSectionTitle}>Photos & Media</Text>
                      <View style={styles.galleryGrid}>
                        {photoRecords.map((img, index) => (
                          <PhotoCard 
                            key={img.id} 
                            item={img} 
                            onPress={() => {
                               setPreviewMediaItem(img);
                               setPreviewMediaIndex(index);
                            }} 
                          />
                        ))}
                      </View>
                    </View>
                  )}

                  {/* Voice Notes Section */}
                  {audioRecords.length > 0 && (
                    <View style={{ marginBottom: 14 }}>
                      <Text style={styles.recordSectionTitle}>Voice Notes</Text>
                      {audioRecords.map((item) => (
                        <VoiceNoteCard 
                          key={item.id} 
                          item={item} 
                          isPlaying={playingAudioUri === item.uri} 
                          onTogglePlay={() => handleToggleAudio(item.uri)} 
                          onShare={() => Sharing.shareAsync(item.uri).catch(() => {})} 
                        />
                      ))}
                    </View>
                  )}

                  {/* Comments Section */}
                  {commentRecords.length > 0 && (
                    <View style={{ marginBottom: 14 }}>
                      <Text style={styles.recordSectionTitle}>Observations</Text>
                      {commentRecords.map((item) => (
                        <CommentCard key={item.id} item={item} onCopy={copyToClipboard} />
                      ))}
                    </View>
                  )}

                  {/* Documents Section */}
                  {docRecords.length > 0 && (
                    <View style={{ marginBottom: 14 }}>
                      <Text style={styles.recordSectionTitle}>Documents & Files</Text>
                      {docRecords.map((item) => (
                        <DocCard 
                          key={item.id} 
                          item={item} 
                          onOpen={() => handleOpenDoc(item)} 
                          onShare={() => Sharing.shareAsync(item.uri).catch(() => {})} 
                        />
                      ))}
                    </View>
                  )}
                </View>
              ) : activeMediaFilter === 'photos' ? (
                <View style={styles.galleryGrid}>
                  {photoRecords.map((img, index) => (
                    <PhotoCard 
                      key={img.id} 
                      item={img} 
                      onPress={() => {
                        setPreviewMediaItem(img);
                        setPreviewMediaIndex(index);
                      }} 
                    />
                  ))}
                </View>
              ) : activeMediaFilter === 'comments' ? (
                <View>
                  {commentRecords.map((item) => (
                    <CommentCard key={item.id} item={item} onCopy={copyToClipboard} />
                  ))}
                </View>
              ) : activeMediaFilter === 'audio' ? (
                <View>
                  {audioRecords.map((item) => (
                    <VoiceNoteCard 
                      key={item.id} 
                      item={item} 
                      isPlaying={playingAudioUri === item.uri} 
                      onTogglePlay={() => handleToggleAudio(item.uri)} 
                      onShare={() => Sharing.shareAsync(item.uri).catch(() => {})} 
                    />
                  ))}
                </View>
              ) : (
                <View>
                  {docRecords.map((item) => (
                    <DocCard 
                      key={item.id} 
                      item={item} 
                      onOpen={() => handleOpenDoc(item)} 
                      onShare={() => Sharing.shareAsync(item.uri).catch(() => {})} 
                    />
                  ))}
                </View>
              )}
            </View>
          )}
        </View>

        <View style={{ display: activeTab === 'visits' ? 'flex' : 'none' }}>
            <VisitManager 
              projectId={projectId} 
              tenderId={tenderId} 
              folderName={activeFolder} 
              onEdit={() => { 
                setHasEdited(true); 
                setDashboardDirty(true); 
                getActiveUserId().then(uid => loadGalleryMedia(uid, activeFolder));
              }} 
            />
            <Text style={[styles.sectionHeader, { textAlign: 'center', marginTop: 10 }]}>IRMA Observations</Text>
            {latestObs.length === 0 && prevObs.length === 0 ? (
              <View style={globalStyles.card}><Text style={{color: '#64748B', textAlign: 'center', fontStyle: 'italic'}}>No IRMA review records exist.</Text></View>
            ) : (
              <View>
                {latestObs.length > 0 && (
                  <View style={{ marginBottom: 15 }}>
                    <Text style={[styles.subSectionTitle, { textAlign: 'center' }]}>
                      Most Recent ({latestObs[0].visit_date}) • {latestObs.length} {latestObs.length === 1 ? 'Observation' : 'Observations'}
                    </Text>
                    {latestObs.map((obs, idx) => <ObservationCard key={`latest_${idx}`} obs={obs} />)}
                  </View>
                )}
                {prevObs.length > 0 && (
                  <View>
                    <Text style={[styles.subSectionTitle, { textAlign: 'center' }]}>
                      Previous Observations ({prevObs.length})
                    </Text>
                    {displayedPrevObs.map((obs, idx) => <ObservationCard key={`prev_${idx}`} obs={obs} />)}
                    {prevObs.length > 5 && (
                      <TouchableOpacity onPress={() => setShowAllObs(!showAllObs)} style={styles.viewMoreBtn}>
                        <Text style={styles.viewMoreText}>{showAllObs ? 'Collapse' : `View All (${prevObs.length})`}</Text>
                        <Ionicons name={showAllObs ? "chevron-up" : "chevron-down"} size={14} color="#2563EB" style={{marginLeft: 4}}/>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            )}
          </View>
      </ScrollView>

      <ImageViewing
        images={photoRecords.map(img => ({ uri: img.uri }))}
        imageIndex={previewMediaIndex}
        visible={!!previewMediaItem}
        onRequestClose={() => setPreviewMediaItem(null)}
        HeaderComponent={({ imageIndex }) => {
          const currentItem = photoRecords[imageIndex];
          return (
            <View style={styles.imagePreviewHeader}>
              <Text style={styles.imagePreviewTitle} numberOfLines={1}>
                {currentItem?.fileName || 'Image Preview'}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <TouchableOpacity 
                  onPress={async () => {
                    if (currentItem?.uri) {
                      await Sharing.shareAsync(currentItem.uri).catch(() => {});
                    }
                  }} 
                  style={styles.previewShareBtn}
                >
                  <Ionicons name="share-social" size={22} color="#FFF" />
                </TouchableOpacity>
                <TouchableOpacity 
                  onPress={() => setPreviewMediaItem(null)} 
                  style={styles.previewCloseBtn}
                >
                  <Ionicons name="close" size={24} color="#FFF" />
                </TouchableOpacity>
              </View>
            </View>
          );
        }}
      />

      {exportState.active && (
        <View style={styles.progressOverlay}>
          <View style={styles.progressBox}>
            <ActivityIndicator size="large" color="#2563EB" />
            <Text style={styles.progressText}>{exportState.status}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const InfoRow = ({ label, value, isLast, color }: any) => (
  <View style={[styles.infoRow, isLast && { borderBottomWidth: 0 }]}>
    <Text style={styles.infoRowLabel}>{label}</Text>
    <Text style={[styles.infoRowValue, color && { color, fontWeight: '700' }]} numberOfLines={2}>
      {value || 'N/A'}
    </Text>
  </View>
);

const ContactCard = ({ title, name, designation, phone, email, onCopy }: any) => {
  if (!name && !phone && !email) return null;
  const formattedPhone = phone ? (phone.startsWith('+') ? phone : `+91 ${phone}`) : '';

  return (
    <View style={styles.contactCard}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text style={styles.contactHeader}>{title}</Text>
        <TouchableOpacity 
          onPress={() => onCopy(`${title}: ${name}\nPhone: ${formattedPhone}\nEmail: ${email}`, title)} 
          style={styles.copyContactBtn}
        >
          <Ionicons name="copy-outline" size={13} color="#64748B" style={{ marginRight: 4 }} />
          <Text style={styles.copyContactBtnText}>Copy Contact</Text>
        </TouchableOpacity>
      </View>
      
      <View style={styles.contactNameRow}>
        <Ionicons name="person-circle" size={38} color="#CBD5E1" style={{ marginRight: 10 }} />
        <View style={{ flex: 1 }}>
           <Text style={styles.contactName}>{name || 'Unknown'}</Text>
           <Text style={styles.contactDesig}>{designation || 'Personnel'}</Text>
        </View>
      </View>
      
      {email ? (
        <View style={styles.contactRow}>
          <Text style={styles.contactLabel}>Email:</Text>
          <Text style={styles.contactValue} numberOfLines={1}>{email}</Text>
          <TouchableOpacity style={styles.contactIconBtn} onPress={() => Linking.openURL(`mailto:${email}`)}>
            <Ionicons name="mail" size={15} color="#FFF" />
          </TouchableOpacity>
        </View>
      ) : null}

      {phone ? (
        <View style={styles.contactRow}>
          <Text style={styles.contactLabel}>Contact:</Text>
          <Text style={styles.contactValue}>{formattedPhone}</Text>
          <TouchableOpacity style={[styles.contactIconBtn, { backgroundColor: '#10B981' }]} onPress={() => Linking.openURL(`tel:${formattedPhone}`)}>
            <Ionicons name="call" size={15} color="#FFF" />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.contactIconBtn, { backgroundColor: '#25D366' }]} onPress={() => Linking.openURL(`whatsapp://send?phone=${formattedPhone.replace(/\D/g,'')}`)}>
            <Ionicons name="logo-whatsapp" size={15} color="#FFF" />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
};

const CommentCard = ({ item, onCopy }: { item: any; onCopy: (text: string, label: string) => void }) => {
  const [expanded, setExpanded] = useState(false);
  const text = item.content || 'No text content available';
  const isLong = text.length > 180;
  const displayText = (!expanded && isLong) ? `${text.substring(0, 180)}...` : text;

  return (
    <View style={styles.commentCard}>
      <View style={styles.commentCardHeader}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 }}>
          <View style={styles.commentIconWrap}>
            <Ionicons name="chatbubble-ellipses" size={14} color="#059669" />
          </View>
          <Text style={styles.commentCardTitle} numberOfLines={1}>
            {item.fileName.replace('.txt', '').replace(/_/g, ' ')}
          </Text>
        </View>
        <TouchableOpacity 
          style={styles.copySmallBtn}
          onPress={() => onCopy(text, 'Observation')}
        >
          <Ionicons name="copy-outline" size={12} color="#64748B" style={{ marginRight: 3 }} />
          <Text style={styles.copySmallBtnText}>Copy</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.commentCardBody}>{displayText}</Text>
      {isLong && (
        <TouchableOpacity onPress={() => setExpanded(!expanded)} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          <Text style={{ color: '#059669', fontSize: 12, fontWeight: '700' }}>
            {expanded ? 'Show Less' : 'Show More'}
          </Text>
        </TouchableOpacity>
      )}
      <View style={styles.commentCardFooter}>
        <Ionicons name="folder-outline" size={11} color="#94A3B8" style={{ marginRight: 4 }} />
        <Text style={styles.commentCardMeta}>{item.folder}</Text>
      </View>
    </View>
  );
};

const VoiceNoteCard = ({ item, isPlaying, onTogglePlay, onShare }: { item: any; isPlaying: boolean; onTogglePlay: () => void; onShare: () => void }) => {
  return (
    <View style={styles.audioCard}>
      <TouchableOpacity 
        style={[styles.audioPlayBtn, isPlaying && styles.audioPlayBtnActive]}
        onPress={onTogglePlay}
      >
        <Ionicons name={isPlaying ? "pause" : "play"} size={18} color={isPlaying ? "#FFF" : "#EA580C"} />
      </TouchableOpacity>
      <View style={{ flex: 1, marginHorizontal: 10 }}>
        <Text style={styles.audioTitle} numberOfLines={1}>
          {item.fileName.replace(/\.[^/.]+$/, "").replace(/_/g, ' ')}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3 }}>
          <Text style={[styles.audioStatus, isPlaying && { color: '#EA580C', fontWeight: '700' }]}>
            {isPlaying ? 'Playing Audio...' : formatBytes(item.size)}
          </Text>
          <Text style={styles.audioMetaDot}>•</Text>
          <Text style={styles.audioStatus}>{item.folder}</Text>
        </View>
      </View>
      <TouchableOpacity style={styles.audioShareBtn} onPress={onShare}>
        <Ionicons name="share-social" size={18} color="#2563EB" />
      </TouchableOpacity>
    </View>
  );
};

const PhotoCard = ({ item, onPress }: { item: any; onPress: () => void }) => {
  const isVideo = item.type === 'video';
  return (
    <TouchableOpacity 
      style={styles.galleryCard}
      activeOpacity={0.85}
      onPress={onPress}
    >
      <Image 
        source={{ uri: item.uri }} 
        style={styles.galleryImage} 
        resizeMode="cover" 
      />
      {isVideo && (
        <View style={styles.videoOverlayPlay}>
          <Ionicons name="play" size={20} color="#FFF" />
        </View>
      )}
      <View style={[styles.galleryTag, item.folder === 'Geotag Captures' && { backgroundColor: 'rgba(16, 185, 129, 0.85)' }]}>
        <Text style={styles.galleryTagText} numberOfLines={1}>
          {item.folder === 'Geotag Captures' ? 'Geotag' : isVideo ? 'Video' : 'Capture'}
        </Text>
      </View>
      <View style={styles.galleryFooter}>
        <Text style={styles.galleryFileName} numberOfLines={1}>{item.fileName}</Text>
        <TouchableOpacity 
          style={styles.galleryCardShareBtn}
          onPress={(e) => {
            e.stopPropagation();
            Sharing.shareAsync(item.uri).catch(() => {});
          }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="share-social" size={15} color="#2563EB" />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
};

const DocCard = ({ item, onOpen, onShare }: { item: any; onOpen: () => void; onShare: () => void }) => {
  const isKml = item.fileName.toLowerCase().endsWith('.kml');
  const isPdf = item.fileName.toLowerCase().endsWith('.pdf');
  const iconName = isKml ? "earth" : isPdf ? "document-text" : "document-attach";
  const iconColor = isKml ? "#10B981" : isPdf ? "#EF4444" : "#2563EB";
  const bgColor = isKml ? "#ECFDF5" : isPdf ? "#FEF2F2" : "#EFF6FF";

  return (
    <View style={styles.docCard}>
      <TouchableOpacity style={[styles.docIconBox, { backgroundColor: bgColor }]} onPress={onOpen} activeOpacity={0.7}>
        <Ionicons name={iconName as any} size={22} color={iconColor} />
      </TouchableOpacity>
      <TouchableOpacity style={{ flex: 1, marginHorizontal: 10 }} onPress={onOpen} activeOpacity={0.7}>
        <Text style={styles.docTitle} numberOfLines={1}>{item.fileName}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
          <Text style={styles.docMeta}>{formatBytes(item.size)}</Text>
          <Text style={styles.docMetaDot}>•</Text>
          <Text style={styles.docMeta}>{item.folder}</Text>
        </View>
      </TouchableOpacity>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <TouchableOpacity style={styles.docActionBtn} onPress={onOpen}>
          <Ionicons name={isKml ? "navigate-outline" : "open-outline"} size={16} color="#2563EB" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.docActionBtn} onPress={onShare}>
          <Ionicons name="share-social" size={16} color="#2563EB" />
        </TouchableOpacity>
      </View>
    </View>
  );
};

const ObservationCard = ({ obs }: { obs: any }) => {
  const getSeverityColor = (sev: string) => {
    const s = (sev || '').toLowerCase();
    if (s.includes('high') || s.includes('critical')) return '#EF4444';
    if (s.includes('medium')) return '#F59E0B';
    if (s.includes('low')) return '#10B981';
    return '#64748B';
  };
  return (
    <View style={styles.obsCard}>
      <View style={styles.obsHeader}>
        <Text style={styles.obsDate}><Ionicons name="calendar-outline" size={12}/> {obs.visit_date}</Text>
        <Text style={[styles.obsSeverity, { color: getSeverityColor(obs.severity), backgroundColor: `${getSeverityColor(obs.severity)}15` }]}>{obs.severity || 'Unknown'} Severity</Text>
      </View>
      <Text style={styles.obsCategory}>{obs.category} • {obs.component}</Text>
      <Text style={styles.obsText}>{obs.observations}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  errorText: { fontSize: 18, color: '#EF4444', fontWeight: 'bold' },
  goBackBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8, minWidth: 200, alignItems: 'center', marginTop: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFF', paddingTop: 60, paddingBottom: 15, paddingHorizontal: 15 },
  backBtn: { padding: 5 },
  headerTitle: { fontSize: 18, fontWeight: '900', color: '#1E293B' },
  headerSub: { fontSize: 12, color: '#64748B', fontWeight: '600', marginTop: 2 },
  
  tabContainer: { flexDirection: 'row', backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 8 },
  tabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 2, borderBottomWidth: 3, borderColor: 'transparent' },
  tabBtnActive: { borderColor: '#2563EB' },
  tabText: { fontSize: 13, fontWeight: '700', color: '#64748B' },
  tabTextActive: { color: '#2563EB' },

  galleryBadge: {
    backgroundColor: '#EFF6FF',
    borderRadius: 10,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 4,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  galleryBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#2563EB',
  },

  emptyGalleryCard: {
    backgroundColor: '#FFF',
    borderRadius: 16,
    padding: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginVertical: 10,
  },
  emptyGalleryTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#334155',
    marginBottom: 6,
    textAlign: 'center',
  },
  emptyGallerySub: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  goToVisitsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2563EB',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  goToVisitsBtnText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 13,
  },

  galleryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  galleryBannerTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#1E40AF',
  },
  galleryBannerSub: {
    fontSize: 12,
    color: '#3B82F6',
    fontWeight: '600',
    marginTop: 2,
  },
  refreshGalleryBtn: {
    padding: 8,
    backgroundColor: '#DBEAFE',
    borderRadius: 8,
  },

  mediaFilterScroll: {
    marginBottom: 12,
  },
  mediaFilterContent: {
    gap: 8,
    paddingVertical: 2,
  },
  mediaFilterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: '#FFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  mediaFilterPillActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  mediaFilterPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
  },
  mediaFilterPillTextActive: {
    color: '#FFF',
  },
  recordSectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 6,
    marginBottom: 8,
  },

  commentCard: {
    backgroundColor: '#FFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderLeftWidth: 4,
    borderLeftColor: '#059669',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
  },
  commentCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  commentIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#ECFDF5',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 6,
  },
  commentCardTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#065F46',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  copySmallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  copySmallBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
  },
  commentCardBody: {
    fontSize: 13,
    color: '#1E293B',
    lineHeight: 20,
  },
  commentCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderColor: '#F1F5F9',
  },
  commentCardMeta: {
    fontSize: 11,
    color: '#94A3B8',
    fontWeight: '600',
  },

  audioCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#FED7AA',
    borderLeftWidth: 4,
    borderLeftColor: '#EA580C',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
  },
  audioPlayBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#FFF7ED',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FFEDD5',
  },
  audioPlayBtnActive: {
    backgroundColor: '#EA580C',
    borderColor: '#C2410C',
  },
  audioTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E293B',
  },
  audioStatus: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '500',
  },
  audioMetaDot: {
    marginHorizontal: 5,
    color: '#CBD5E1',
    fontSize: 11,
  },
  audioShareBtn: {
    padding: 8,
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },

  galleryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  galleryCard: {
    width: '48.5%',
    backgroundColor: '#FFF',
    borderRadius: 12,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
  },
  galleryImage: {
    width: '100%',
    height: 140,
    backgroundColor: '#F1F5F9',
  },
  videoOverlayPlay: {
    position: 'absolute',
    top: 50,
    left: '50%',
    marginLeft: -18,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  galleryTag: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  galleryTagText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  galleryFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#FFF',
  },
  galleryFileName: {
    flex: 1,
    fontSize: 11,
    color: '#475569',
    fontWeight: '600',
    marginRight: 6,
  },
  galleryCardShareBtn: {
    padding: 3,
  },

  docCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
  },
  docIconBox: {
    width: 40,
    height: 40,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  docTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E293B',
  },
  docMeta: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '500',
  },
  docMetaDot: {
    marginHorizontal: 5,
    color: '#CBD5E1',
    fontSize: 11,
  },
  docActionBtn: {
    padding: 8,
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },

  imagePreviewModal: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
  },
  imagePreviewHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 50,
    paddingHorizontal: 20,
    paddingBottom: 15,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    zIndex: 100,
  },
  imagePreviewTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
    marginRight: 15,
  },
  previewCloseBtn: {
    padding: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 20,
  },
  previewShareBtn: {
    padding: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 20,
    marginRight: 10,
  },
  imagePreviewBody: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 10,
  },
  imagePreviewFull: {
    width: '100%',
    height: '100%',
  },

  sectionHeader: { fontSize: 16, fontWeight: '900', color: '#0F172A', marginBottom: 12, marginTop: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionHeaderRow: { marginBottom: 5 },
  
  projectTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A', lineHeight: 24 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 12 },
  typeBadge: { backgroundColor: '#EFF6FF', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: '#BFDBFE' },
  typeBadgeText: { color: '#2563EB', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  visitedBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F0FDF4', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: '#BBF7D0' },
  visitedBadgeText: { color: '#16A34A', fontSize: 11, fontWeight: '700' },
  pinBtnRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 4, marginBottom: 16, width: '100%' },
  pinBtnHalf: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, elevation: 1 },
  pinBtnText: { color: '#FFF', fontWeight: '700', fontSize: 13 },

  infoCard: { backgroundColor: '#FFF', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2 },
  cardHeaderTitle: { fontSize: 13, fontWeight: '800', color: '#0F172A', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  infoRowLabel: { fontSize: 13, color: '#64748B', fontWeight: '600', flex: 1 },
  infoRowValue: { fontSize: 13, color: '#1E293B', fontWeight: '700', flex: 1.4, textAlign: 'right' },

  financeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  financeTile: { width: '48.5%', backgroundColor: '#F8FAFC', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  financeTileLabel: { fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', marginBottom: 2 },
  financeTileVal: { fontSize: 13, fontWeight: '800', color: '#1E293B' },
  
  progressSummaryRow: { flexDirection: 'row', gap: 8 },
  progressMetricBox: { flex: 1, borderRadius: 8, paddingVertical: 7, paddingHorizontal: 8, borderWidth: 1, alignItems: 'center' },
  progressMetricLabel: { fontSize: 10, fontWeight: '700', color: '#64748B', marginBottom: 2 },
  progressMetricVal: { fontSize: 14, fontWeight: '800' },

  compactScopeText: { fontSize: 13, color: '#475569', lineHeight: 20, textAlign: 'justify' },
  scopeToggleBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', marginTop: 8 },
  scopeToggleText: { color: '#2563EB', fontSize: 12, fontWeight: '700' },

  contactCard: { backgroundColor: '#FFF', padding: 14, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0', elevation: 1 },
  contactHeader: { fontSize: 11, fontWeight: '800', color: '#2563EB', textTransform: 'uppercase', letterSpacing: 0.8 },
  copyContactBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: '#E2E8F0' },
  copyContactBtnText: { fontSize: 11, color: '#64748B', fontWeight: '700' },
  contactNameRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 8, paddingBottom: 8, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  contactName: { fontSize: 15, fontWeight: '700', color: '#1E293B' },
  contactDesig: { fontSize: 12, color: '#64748B', fontWeight: '500', marginTop: 1 },
  contactRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  contactLabel: { fontSize: 12, fontWeight: '700', color: '#64748B', width: 56 },
  contactValue: { flex: 1, fontSize: 13, color: '#1E293B', fontWeight: '600' },
  contactIconBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#2563EB', justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
  
  subSectionTitle: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 10, marginTop: 5, textTransform: 'uppercase' },
  
  viewMoreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 12, marginTop: 10, marginBottom: 20, backgroundColor: '#EFF6FF', borderRadius: 8, borderWidth: 1, borderColor: '#BFDBFE' },
  viewMoreText: { color: '#2563EB', fontWeight: 'bold', fontSize: 13 },
  
  obsCard: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0', borderLeftWidth: 5, borderLeftColor: '#334155' },
  obsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  obsDate: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  obsSeverity: { fontSize: 11, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  obsCategory: { fontSize: 13, fontWeight: '700', color: '#1E293B', marginBottom: 6 },
  obsText: { fontSize: 14, color: '#475569', lineHeight: 22 },
  endOfObservationsMarker: { paddingVertical: 10, marginBottom: 10, alignItems: 'center' },

  progressOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', zIndex: 100 },
  progressBox: { backgroundColor: '#FFF', padding: 25, borderRadius: 16, width: '85%', alignItems: 'center', elevation: 5 },
  progressText: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginTop: 15, textAlign: 'center', lineHeight: 24 },
  progressActionBtn: { padding: 10, borderRadius: 8, flex: 1, alignItems: 'center' }
});