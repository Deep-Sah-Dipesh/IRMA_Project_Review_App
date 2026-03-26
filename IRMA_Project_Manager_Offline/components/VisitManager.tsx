import React, { useEffect, useState, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Modal, TouchableWithoutFeedback, FlatList, TextInput, Image, ScrollView, Platform, useWindowDimensions, KeyboardAvoidingView, ActivityIndicator } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as Location from 'expo-location';
import * as Linking from 'expo-linking';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useAudioPlayer } from 'expo-audio';
import { Audio } from 'expo-av';
import ViewShot from 'react-native-view-shot';

import { globalStyles } from '../styles/globalStyles';

// PASTE YOUR API KEY HERE TO REMOVE WATERMARK
const GOOGLE_MAPS_API_KEY = "AIzaSyBJ_t7XtFa0vKHr9iDXFX8fcHvk9OGC_ec"; 

interface VisitManagerProps { projectId: string; tenderId: string; folderName: string; onEdit?: () => void; }

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

const formatGeoDate = (d: Date) => {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = (n: number) => n.toString().padStart(2, '0');
  const h12 = d.getHours() % 12 || 12;
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(offset) / 60));
  const offM = pad(Math.abs(offset) % 60);
  return `${days[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}, ${pad(h12)}:${pad(d.getMinutes())} ${ampm} GMT${sign}${offH}:${offM}`;
};

export default function VisitManager({ projectId, tenderId, folderName, onEdit }: VisitManagerProps) {
  const { width: SCREEN_WIDTH } = useWindowDimensions();

  const [visits, setVisits] = useState<string[]>([]);
  const [activeVisit, setActiveVisit] = useState<string | null>(null);
  const [showVisitModal, setShowVisitModal] = useState(false);
  const [fileStats, setFileStats] = useState<Record<string, number>>({ total: 0 });
  const [showFilesModal, setShowFilesModal] = useState(false);
  const [savedFiles, setSavedFiles] = useState<any[]>([]);
  const [totalSessionSize, setTotalSessionSize] = useState(0);
  const [filterType, setFilterType] = useState<string>('All');
  const [sortBy, setSortBy] = useState<'Date' | 'Name'>('Date');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [previewFile, setPreviewFile] = useState<any | null>(null);

  const [showCommentModal, setShowCommentModal] = useState(false);
  const [commentText, setCommentText] = useState('');
  const commentInputRef = useRef<TextInput>(null);
  
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordTime, setRecordTime] = useState(0);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);

  const [camPerm, reqCamPerm] = useCameraPermissions();
  const [showLiveCamera, setShowLiveCamera] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<'back' | 'front'>('back');
  const [flashMode, setFlashMode] = useState<'off' | 'on' | 'auto'>('auto');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '4:3'>('16:9');
  
  const [showZoom, setShowZoom] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [isCapturing, setIsCapturing] = useState(false);
  
  const [cameraRef, setCameraRef] = useState<CameraView | null>(null);
  const sessionGeoDataRef = useRef<any>(null);
  const [liveGeoData, setLiveGeoData] = useState<any>(null);
  
  // Background queue for rendering high-res ViewShots without freezing the UI
  const [captureQueue, setCaptureQueue] = useState<any[]>([]);
  const [captureTrigger, setCaptureTrigger] = useState(0);
  const viewShotRef = useRef<ViewShot>(null);

  const getBaseDirectory = () => `${FileSystem.documentDirectory}projects/${folderName}/`;
  
  // Dynamic camera resolution scaling
  const CAMERA_HEIGHT = aspectRatio === '4:3' ? SCREEN_WIDTH * (4 / 3) : SCREEN_WIDTH * (16 / 9);
  const HIDDEN_WIDTH = 1080;
  const HIDDEN_HEIGHT = aspectRatio === '4:3' ? 1440 : 1920;

  useEffect(() => { scanExistingVisits(); }, [folderName]);
  useEffect(() => { if (activeVisit) updateFileStats(); }, [activeVisit]);

  // Audio recording timer lifecycle
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (recording && !isRecordingPaused) {
      interval = setInterval(async () => {
        try {
          const status = await recording.getStatusAsync();
          if (status.isRecording) setRecordTime(Math.floor(status.durationMillis / 1000));
        } catch(e) {}
      }, 500);
    }
    return () => clearInterval(interval);
  }, [recording, isRecordingPaused]);

  useEffect(() => { return () => { if (recording) recording.stopAndUnloadAsync().catch(() => {}); }; }, [recording]);

  // Background live GPS tracking and reverse geocoding
  useEffect(() => {
    let sub: Location.LocationSubscription;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: 2000, distanceInterval: 1 }, 
        async (loc) => {
          try {
            const geocode = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
            const addr = geocode[0] || {};
            const newData = { lat: loc.coords.latitude.toFixed(6), lon: loc.coords.longitude.toFixed(6), timestamp: formatGeoDate(new Date(loc.timestamp)), address: `${addr.street || ''} ${addr.district || ''}, ${addr.city || ''} ${addr.postalCode || ''}`.trim() || 'Unknown Street', city: addr.city || addr.subregion || 'Unknown City', region: addr.region || 'Unknown Region', country: addr.country || 'India' };
            sessionGeoDataRef.current = newData;
            setLiveGeoData(newData);
          } catch (e) {}
        });
      }
    })();
    return () => { if (sub) sub.remove(); }
  }, []);

  // ViewShot Engine: Processes the hidden queue to stamp metadata onto images
  useEffect(() => {
    if (captureTrigger > 0 && captureQueue.length > 0 && viewShotRef.current) {
      setTimeout(async () => {
        try {
          const stampedUri = await viewShotRef.current?.capture?.();
          if (stampedUri) {
             const targetDir = await ensureSubfolder('geotagged_captures');
             const d = new Date(captureQueue[0].id);
             const p = (n: number) => n.toString().padStart(2, '0');
             const dtStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
             await FileSystem.copyAsync({ from: stampedUri, to: `${targetDir}Img_Geo_${dtStr}.jpg` });
             updateFileStats();
          }
        } catch (e) {} finally {
          setCaptureQueue(q => q.slice(1));
          setCaptureTrigger(0);
        }
      }, 100); 
    }
  }, [captureTrigger, captureQueue]);

  const scanExistingVisits = async () => {
    try {
      const baseUri = getBaseDirectory();
      const dirInfo = await FileSystem.getInfoAsync(baseUri);
      if (dirInfo.exists) {
        const files = await FileSystem.readDirectoryAsync(baseUri);
        const visitDirs = files.filter(f => f.startsWith('VISIT_')).sort();
        setVisits(visitDirs);
        if (visitDirs.length > 0) setActiveVisit(visitDirs[visitDirs.length - 1]);
      }
    } catch (e) {}
  };

  const getTodayYYYYMMDD = () => {
      const d = new Date();
      const p = (n: number) => n.toString().padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  };

  const checkAndCreateVisit = async () => {
    const todayStr = getTodayYYYYMMDD();
    
    if (visits.length > 0) {
        const latest = visits[visits.length - 1];
        const match = latest.match(/_(\d{8})_/);
        if (match) {
            const lastDateStr = match[1];
            if (lastDateStr === todayStr) {
                Alert.alert("Visit Limit Reached", "You've already created a visit report today, and can't create duplicate reports on the same day.");
                return;
            }
            
            // Calculate X days ago difference
            const d1 = new Date(parseInt(todayStr.substring(0,4)), parseInt(todayStr.substring(4,6))-1, parseInt(todayStr.substring(6,8)));
            const d2 = new Date(parseInt(lastDateStr.substring(0,4)), parseInt(lastDateStr.substring(4,6))-1, parseInt(lastDateStr.substring(6,8)));
            const diffDays = Math.ceil((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24));
            
            const proceed = await new Promise((resolve) => {
                Alert.alert(
                    "Previous Visit Found", 
                    `You created a visit report for this project ${diffDays} days ago.\n\nAre you sure you want to create another visit report?`, [
                    { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
                    { text: "OK", onPress: () => resolve(true) }
                ]);
            });
            if (!proceed) return;
        }
    }

    Alert.alert(
        "Site Verification", 
        "Are you on the Project Site?\n\nIf you're away press Cancel, or if you've reached the site, Press OK to create visit reports.", [
        { text: "Cancel", style: "cancel" },
        { text: "OK", onPress: () => executeCreateNewVisit() }
    ]);
  };

  const executeCreateNewVisit = async () => {
    try {
      const baseUri = getBaseDirectory();
      const dirInfo = await FileSystem.getInfoAsync(baseUri);
      if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(baseUri, { intermediates: true });
      const d = new Date(), p = (n: number) => n.toString().padStart(2, '0');
      const newVisitName = `VISIT_${visits.length + 1}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
      await FileSystem.makeDirectoryAsync(`${baseUri}${newVisitName}/`, { intermediates: true });
      
      const newVisits = [...visits, newVisitName].sort();
      setVisits(newVisits);
      setActiveVisit(newVisitName); 
      
      // Auto-trigger background KML generation within 1 second of folder creation
      setTimeout(() => { handlePinGeotag(true, true, newVisitName); }, 1000);
    } catch (e) {}
  };

  const updateFileStats = async () => {
    try {
      const visitUri = `${getBaseDirectory()}${activeVisit}/`;
      const checkFolders = ['notes', 'attachments', 'geotagged_captures'];
      let stats: Record<string, number> = { comments: 0, audio: 0, documents: 0, photos: 0, videos: 0, geotagged_photos: 0, location: 0, total: 0 };
      for (const folder of checkFolders) {
        const fUri = `${visitUri}${folder}/`;
        const info = await FileSystem.getInfoAsync(fUri);
        if (info.exists) {
          const files = await FileSystem.readDirectoryAsync(fUri);
          files.forEach(f => {
             if (!f.endsWith('.json')) {
                const ext = f.split('.').pop()?.toLowerCase();
                let cat = 'documents';
                if (folder === 'notes') cat = ext === 'txt' ? 'comments' : 'audio';
                else if (folder === 'geotagged_captures') cat = 'geotagged_photos';
                else if (folder === 'attachments') cat = ['mp4','mov'].includes(ext!) ? 'videos' : ['jpg','png','jpeg'].includes(ext!) ? 'photos' : 'documents';
                stats[cat]++; stats.total++;
             }
          });
        }
      }
      const rootFiles = await FileSystem.readDirectoryAsync(visitUri);
      rootFiles.forEach(f => { if (f.endsWith('.kml')) { stats.location++; stats.total++; } });
      setFileStats(stats);
      if (stats.total > 0 && onEdit) onEdit();
    } catch (e) {}
  };

  const ensureSubfolder = async (subfolder: string) => {
    const folderUri = `${getBaseDirectory()}${activeVisit}/${subfolder}/`;
    const dirInfo = await FileSystem.getInfoAsync(folderUri);
    if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(folderUri, { intermediates: true });
    return folderUri;
  };

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (perm.status !== 'granted') return Alert.alert("Permission Denied");
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: newRecording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      setRecordTime(0); setIsRecordingPaused(false); setRecording(newRecording);
    } catch (err) {}
  };

  const stopRecording = async () => {
    if (!recording) return;
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null); setRecordTime(0); setIsRecordingPaused(false);
      if (uri) {
        const targetDir = await ensureSubfolder('notes');
        const d = new Date();
        const p = (n: number) => n.toString().padStart(2, '0');
        const dtStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
        // Applied Naming Convention
        const num = fileStats.audio + 1;
        await FileSystem.copyAsync({ from: uri, to: `${targetDir}Voice_Memo_${num}_${dtStr}.m4a` });
        updateFileStats();
      }
    } catch (err) {}
  };

  const injectMarkdown = (type: 'bullet' | 'number' | 'roman') => {
    setCommentText(prev => {
      const lines = prev.split('\n');
      let lastLine = '';
      for (let i = lines.length - 1; i >= 0; i--) {
         if (lines[i].trim() !== '') { lastLine = lines[i]; break; }
      }
      
      let prefix = '';
      if (type === 'bullet') prefix = '• ';
      if (type === 'number') {
        const match = lastLine.match(/^(\d+)\.\s/);
        prefix = match ? `${parseInt(match[1]) + 1}. ` : '1. ';
      }
      if (type === 'roman') {
        const romanMap = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv'];
        const match = lastLine.match(/^([ivxlc]+)\.\s/i);
        if (match) {
           const idx = romanMap.indexOf(match[1].toLowerCase());
           prefix = idx !== -1 && idx < romanMap.length - 1 ? `${romanMap[idx+1]}. ` : 'i. ';
        } else prefix = 'i. ';
      }
      const newLine = prev === '' || prev.endsWith('\n') ? prefix : `\n${prefix}`;
      return prev + newLine;
    });
  };

  const handleSaveComment = async () => {
    if (!commentText.trim()) return;
    try {
      const targetDir = await ensureSubfolder('notes');
      const d = new Date();
      const p = (n: number) => n.toString().padStart(2, '0');
      const dtStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
      // Applied Naming Convention
      const num = fileStats.comments + 1;
      await FileSystem.writeAsStringAsync(`${targetDir}Comments_${num}_${dtStr}.txt`, commentText);
      setCommentText(''); setShowCommentModal(false); updateFileStats();
    } catch (e) {}
  };

  const handleAttachFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false, multiple: true });
      if (result.canceled || !result.assets?.length) return;
      const targetDir = await ensureSubfolder('attachments');
      for (const asset of result.assets) {
         const cleanName = asset.name.replace(/[^a-zA-Z0-9.-]/g, '_');
         await FileSystem.copyAsync({ from: asset.uri, to: `${targetDir}${cleanName}` });
      }
      updateFileStats();
    } catch (e) {}
  };

  const openLiveGeotagCamera = async () => {
    try {
      if (!camPerm?.granted) {
        const res = await reqCamPerm();
        if (!res.granted) return Alert.alert("Camera Permission Denied");
      }
      setShowLiveCamera(true);
    } catch (e) {}
  };

  const captureLiveMedia = async () => {
    if (!cameraRef || isCapturing) return;
    try {
      setIsCapturing(true);
      setTimeout(() => setIsCapturing(false), 1000); // 1-second shutter freeze prevents spam crashes

      const safeGeoData = liveGeoData || sessionGeoDataRef.current || { lat: "0.000000", lon: "0.000000", timestamp: formatGeoDate(new Date()), address: "", city: "", region: "", country: "" };
      const photo = await cameraRef.takePictureAsync({ quality: 1 });
      
      if (photo) {
        // Instantly push to background queue and free the UI
        setCaptureQueue(q => [...q, { id: Date.now(), uri: photo.uri, geoData: safeGeoData }]);
        
        // Auto-add KML ONLY if it's the very first photo
        const visitUri = `${getBaseDirectory()}${activeVisit}/`;
        const files = await FileSystem.readDirectoryAsync(visitUri).catch(() => []);
        if (!files.some(f => f.endsWith('.kml'))) {
           handlePinGeotag(true, true);
        }
      }
    } catch (e) {
      setIsCapturing(false);
    } 
  };

  const cycleFlashMode = () => setFlashMode(f => f === 'auto' ? 'on' : f === 'on' ? 'off' : 'auto');

  const handleCaptureNormalMedia = async (mediaType: 'photo' | 'video') => {
    try {
      const result = await ImagePicker.launchCameraAsync({ 
        mediaTypes: mediaType === 'video' ? ['videos'] : ['images'], 
        allowsEditing: false, videoQuality: 1, quality: 0.9 
      });
      if (result.canceled || !result.assets?.length) return;
      const targetDir = await ensureSubfolder('attachments');
      const prefix = mediaType === 'video' ? 'vid_' : 'img_';
      const ext = mediaType === 'video' ? 'mp4' : 'jpg';
      
      const d = new Date();
      const p = (n: number) => n.toString().padStart(2, '0');
      const dtStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      
      await FileSystem.copyAsync({ from: result.assets[0].uri, to: `${targetDir}${prefix}${dtStr}.${ext}` });
      updateFileStats();
    } catch (e) {}
  };

  const handlePinGeotag = async (silent = false, isAuto = false, targetVisit: string | null = null) => {
    const activeDir = targetVisit || activeVisit;
    if (!activeDir) return;

    const doGeotag = async (replace = false) => {
      try {
        const visitUri = `${getBaseDirectory()}${activeDir}/`;
        if (replace) {
          const files = await FileSystem.readDirectoryAsync(visitUri).catch(() => []);
          const kmlFiles = files.filter(f => f.endsWith('.kml'));
          if (kmlFiles.length > 0) await FileSystem.deleteAsync(`${visitUri}${kmlFiles.sort().reverse()[0]}`).catch(() => {});
        }
        
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') { if (!silent) Alert.alert("Location Denied"); return; }
        
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const lat = loc.coords.latitude.toFixed(6);
        const lon = loc.coords.longitude.toFixed(6);
        
        const kmlData = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Placemark>\n    <name>Project Geotag</name>\n    <Point>\n      <coordinates>${lon},${lat},0</coordinates>\n    </Point>\n  </Placemark>\n</kml>`;
        // Applied Naming Convention
        await FileSystem.writeAsStringAsync(`${visitUri}pin_${projectId}_${tenderId}_${lat}_${lon}.kml`, kmlData);
        updateFileStats();
      } catch (err) {
        if (!silent) Alert.alert("Error", "Could not fetch GPS.");
      }
    };

    if (isAuto) {
      doGeotag(false);
    } else {
      const visitUri = `${getBaseDirectory()}${activeDir}/`;
      const files = await FileSystem.readDirectoryAsync(visitUri).catch(() => []);
      if (files.some(f => f.endsWith('.kml'))) {
        Alert.alert("Location Pin", "Adding location pin of this place.", [
          { text: "Cancel", style: "cancel" },
          { text: "Replace Latest Pin", onPress: () => doGeotag(true) },
          { text: "Add New Pin", onPress: () => doGeotag(false) }
        ]);
      } else {
        doGeotag(false);
      }
    }
  };

  const refreshFilesExplorer = async () => {
    try {
      const visitUri = `${getBaseDirectory()}${activeVisit}/`;
      const info = await FileSystem.getInfoAsync(visitUri);
      if (!info.exists) { setSavedFiles([]); setTotalSessionSize(0); return; }
      
      let allFiles: any[] = []; let totalSize = 0;
      const checkFolders = ['notes', 'attachments', 'geotagged_captures', ''];
      
      for (const folder of checkFolders) {
        const subUri = folder ? `${visitUri}${folder}/` : visitUri;
        const subInfo = await FileSystem.getInfoAsync(subUri);
        if (subInfo.exists && subInfo.isDirectory) {
          const files = await FileSystem.readDirectoryAsync(subUri);
          for(const f of files) {
             if(!f.endsWith('.json') && !f.startsWith('VISIT_')) {
                const fileStat = await FileSystem.getInfoAsync(`${subUri}${f}`);
                if (!fileStat.isDirectory) {
                  allFiles.push({ name: f, folder: folder || 'root', time: fileStat.modificationTime || 0, size: fileStat.size || 0 });
                  totalSize += fileStat.size || 0;
                }
             }
          }
        }
      }
      setSavedFiles(allFiles); setTotalSessionSize(totalSize);
    } catch (e) {}
  };

  const deleteFile = (folder: string, name: string) => {
    Alert.alert("Confirm Delete", `Delete ${name}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
          try {
            const folderPath = folder === 'root' ? '' : `${folder}/`;
            const uri = `${getBaseDirectory()}${activeVisit}/${folderPath}${name}`;
            await FileSystem.deleteAsync(uri, { idempotent: true }); 
            if (folder === 'geotagged_captures') {
               const baseName = name.substring(0, name.lastIndexOf('.'));
               const jsonUri = `${getBaseDirectory()}${activeVisit}/${folderPath}${baseName}.json`;
               await FileSystem.deleteAsync(jsonUri, { idempotent: true }).catch(()=>{});
            }
            await refreshFilesExplorer(); updateFileStats();
          } catch (e) {}
        }}
    ]);
  };

  const handlePreviewFile = async (folder: string, name: string) => {
    try {
      const uri = `${getBaseDirectory()}${activeVisit}/${folder === 'root' ? '' : `${folder}/`}${name}`;
      const ext = name.split('.').pop()?.toLowerCase() || '';

      if (ext === 'kml') {
         const content = await FileSystem.readAsStringAsync(uri);
         const coordMatch = content.match(/<coordinates>([^,]+),([^,]+)/);
         if (coordMatch) Linking.openURL(`https://maps.google.com/?q=${coordMatch[2]},${coordMatch[1]}`);
         return;
      }

      let type = 'doc';
      if (['txt', 'csv', 'json'].includes(ext)) type = 'text';
      else if (['jpg', 'jpeg', 'png'].includes(ext)) type = 'image';
      else if (['mp4', 'mov'].includes(ext)) type = 'video';
      else if (['m4a', 'mp3', 'wav'].includes(ext)) type = 'audio';

      if (type === 'text') {
        const content = await FileSystem.readAsStringAsync(uri);
        setPreviewFile({ uri, name, type, content });
      } else if (type === 'doc') {
        await Sharing.shareAsync(uri); 
      } else {
        setPreviewFile({ uri, name, type });
      }
    } catch (e) {}
  };

  const displayFiles = useMemo(() => {
    let filtered = savedFiles;
    if (filterType !== 'All') {
      filtered = savedFiles.filter(f => {
        const ext = f.name.split('.').pop()?.toLowerCase() || '';
        if (filterType === 'Images') return ['jpg', 'png', 'jpeg'].includes(ext);
        if (filterType === 'Videos') return ['mp4', 'mov'].includes(ext);
        if (filterType === 'Audio') return ['m4a', 'wav'].includes(ext);
        if (filterType === 'Docs') return ['txt', 'pdf', 'csv', 'doc', 'docx', 'kml'].includes(ext);
        return true;
      });
    }
    return filtered.sort((a, b) => {
      if (sortBy === 'Name') return sortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      return sortOrder === 'asc' ? a.time - b.time : b.time - a.time;
    });
  }, [savedFiles, filterType, sortBy, sortOrder]);

  return (
    <View style={[globalStyles.card, { padding: 16, marginBottom: 10 }]}>
      <View style={{ marginBottom: 15 }}>
         <Text style={styles.visitSectionHeader}>Manage your visit reports here</Text>
         <View style={styles.visitControls}>
           <TouchableOpacity style={styles.visitBtnLight} onPress={() => setShowVisitModal(true)}>
             <Ionicons name="list" size={16} color="#334155" style={{ marginRight: 6 }} /><Text style={{ color: '#334155', fontWeight: 'bold', fontSize: 13 }}>Select From Visits</Text>
           </TouchableOpacity>
           {/* REPLACED with Verification function */}
           <TouchableOpacity style={styles.visitBtnDark} onPress={checkAndCreateVisit}>
             <Ionicons name="add-circle" size={16} color="#FFF" style={{ marginRight: 6 }} /><Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 13 }}>Create New Visit</Text>
           </TouchableOpacity>
         </View>
      </View>

      {activeVisit ? (
        <View>
          <View style={styles.activeVisitBox}>
            <Ionicons name="checkmark-circle" size={24} color="#15803D" style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.activeVisitLabel}>Selected Visit</Text>
              <Text style={styles.activeVisitText} numberOfLines={1}>{activeVisit}</Text>
            </View>
          </View>
          {fileStats.total > 0 && (
            <View style={styles.statsContainer}>
              <Text style={styles.statsTitle}>Saved Files: {fileStats.total}</Text>
              <View style={styles.statsRow}>
                {Object.entries(fileStats).map(([key, count]) => {
                  if (key === 'total' || count === 0) return null;
                  return <View key={key} style={styles.statBadge}><Text style={styles.statBadgeText}>{count} {key.replace('_', ' ')}</Text></View>;
                })}
              </View>
            </View>
          )}
        </View>
      ) : <Text style={styles.noVisitText}>Select or Create a visit report session to unlock media buttons.</Text>}

      {recording && (
        <View style={styles.recordingUIBox}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={styles.redDot} />
            <Text style={styles.recordingTime}>{formatTime(recordTime)}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
             <TouchableOpacity style={[styles.recordControlBtn, { backgroundColor: '#EFF6FF', marginRight: 10 }]} onPress={() => {
                isRecordingPaused ? recording.startAsync().then(() => setIsRecordingPaused(false)) : recording.pauseAsync().then(() => setIsRecordingPaused(true));
             }}>
                <Ionicons name={isRecordingPaused ? "play" : "pause"} size={20} color="#2563EB" />
             </TouchableOpacity>
             <TouchableOpacity style={[styles.recordControlBtn, { backgroundColor: '#FEE2E2' }]} onPress={stopRecording}>
               <Ionicons name="square" size={20} color="#EF4444" />
               <Text style={{color: '#EF4444', fontWeight: 'bold', marginLeft: 6}}>Stop & Save</Text>
             </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Grid Padding fixed so whitespace is gone */}
      <View style={[styles.actionGrid, !activeVisit && { opacity: 0.3 }]} pointerEvents={!activeVisit ? 'none' : 'auto'}>
        <ActionButton icon={recording ? "stop-circle" : "mic"} label={recording ? "Recording..." : "Voice Note"} color={recording ? "#EF4444" : "#EA580C"} onPress={() => recording ? stopRecording() : startRecording()} />
        <ActionButton icon="chatbubble-ellipses" label="Text Comment" color="#059669" onPress={() => setShowCommentModal(true)} />
        <ActionButton icon="location" label="Pin Geotag" color="#0891B2" onPress={() => handlePinGeotag(false)} disabled={recording !== null} />
        
        <ActionButton icon="camera-outline" label="Normal Photo" color="#2563EB" onPress={() => handleCaptureNormalMedia('photo')} disabled={recording !== null} />
        <ActionButton icon="image" label="Geotag Photo" color="#0284C7" onPress={openLiveGeotagCamera} disabled={recording !== null} />
        <ActionButton icon="videocam-outline" label="Normal Video" color="#DB2777" onPress={() => handleCaptureNormalMedia('video')} disabled={recording !== null} />
        
        <View style={styles.centeredRow}>
           <ActionButton icon="attach" label="Attach Files" color="#7C3AED" onPress={handleAttachFile} style={{ width: '45%' }} />
           <ActionButton icon="folder-open" label="Show Files" color="#475569" onPress={() => { refreshFilesExplorer(); setShowFilesModal(true); }} style={{ width: '45%' }} />
        </View>
      </View>

      {/* LIVE CAMERA MODAL */}
      <Modal visible={showLiveCamera} transparent animationType="none">
         <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center' }}>
            <View style={{ width: SCREEN_WIDTH, height: CAMERA_HEIGHT, backgroundColor: '#111', overflow: 'hidden' }}>
              
              {(!liveGeoData || liveGeoData.lat === "0.000000") && (
                <View style={styles.gpsWaitingOverlay}>
                  <ActivityIndicator size="large" color="#FFF" />
                  <Text style={{color:'#FFF', marginTop: 10, fontWeight: 'bold'}}>Waiting for GPS signals...</Text>
                </View>
              )}

              <CameraView ref={setCameraRef} style={{ flex: 1 }} zoom={zoom} mode="picture" facing={cameraFacing} flash={flashMode === 'auto' ? 'auto' : flashMode === 'on' ? 'on' : 'off'} />
              
              <View style={styles.cameraTopTools}>
                 <TouchableOpacity onPress={() => setAspectRatio(a => a === '16:9' ? '4:3' : '16:9')} style={styles.cameraTopBtn}>
                   <Ionicons name="expand" size={24} color="#FFF" />
                   <Text style={styles.cameraTopBtnText}>{aspectRatio}</Text>
                 </TouchableOpacity>

                 <View style={{ alignItems: 'center' }}>
                    <TouchableOpacity onPress={() => setShowZoom(!showZoom)} style={[styles.cameraTopBtn, showZoom && { backgroundColor: 'rgba(255,255,255,0.3)' }]}>
                       <Ionicons name="search" size={24} color="#FFF" />
                       <Text style={styles.cameraTopBtnText}>{Math.round(zoom * 100)}%</Text>
                    </TouchableOpacity>
                    {showZoom && (
                       <View style={styles.zoomControls}>
                          <TouchableOpacity onPress={() => setZoom(z => Math.max(0, z - 0.1))} style={styles.zoomBtn}><Text style={styles.zoomBtnText}>-</Text></TouchableOpacity>
                          <TouchableOpacity onPress={() => setZoom(z => Math.min(1, z + 0.1))} style={styles.zoomBtn}><Text style={styles.zoomBtnText}>+</Text></TouchableOpacity>
                       </View>
                    )}
                 </View>

                 <TouchableOpacity onPress={cycleFlashMode} style={styles.cameraTopBtn}>
                   <Ionicons name={flashMode === 'on' ? "flash" : flashMode === 'auto' ? "flash-outline" : "flash-off"} size={24} color="#FFF" />
                   <Text style={styles.cameraTopBtnText}>{flashMode}</Text>
                 </TouchableOpacity>
              </View>

              {/* OVERLAY PLACED INSIDE CAMERA VIEW (At bottom) */}
              <View style={{ position: 'absolute', bottom: 10, left: 10, right: 10, pointerEvents: 'none' }}>
                 {liveGeoData && <GPSCameraOverlay geoData={liveGeoData} isLive />}
              </View>
            </View>
            
            {/* CONTROLS TAKE UP REMAINING SPACE BELOW CAMERA */}
            <View style={styles.cameraControlsContainer}>
               <TouchableOpacity onPress={() => setShowLiveCamera(false)} style={styles.cameraSideBtn}>
                 <Ionicons name="close" size={36} color="#FFF" />
               </TouchableOpacity>
               
               <TouchableOpacity onPress={captureLiveMedia} disabled={isCapturing} style={[styles.cameraCaptureBtnOuter, isCapturing && { borderColor: '#94A3B8' }]}>
                 <View style={[styles.cameraCaptureBtnInner, isCapturing && { backgroundColor: '#94A3B8' }]} />
               </TouchableOpacity>
               
               <TouchableOpacity onPress={() => setCameraFacing(f => f === 'back' ? 'front' : 'back')} style={styles.cameraSideBtn}>
                 <Ionicons name="camera-reverse" size={28} color="#FFF" />
               </TouchableOpacity>
            </View>
            
            {captureQueue.length > 0 && (
               <View style={styles.photoQueueToast}>
                 <ActivityIndicator size="small" color="#FFF" style={{marginRight: 8}}/>
                 <Text style={{color: '#FFF', fontWeight: 'bold'}}>Saving {captureQueue.length} photo(s)...</Text>
               </View>
            )}
         </View>
      </Modal>

      {/* INVISIBLE BACKGROUND RENDERER (Processes queue without blocking camera) */}
      {captureQueue.length > 0 && (
        <View style={{ position: 'absolute', top: -10000, left: -10000, width: 1, height: 1, overflow: 'hidden', opacity: 0 }}>
          <View style={{ width: HIDDEN_WIDTH, height: HIDDEN_HEIGHT, backgroundColor: '#000' }}>
            <ViewShot ref={viewShotRef} options={{ format: 'jpg', quality: 1.0 }} style={{ flex: 1 }}>
              <Image source={{ uri: captureQueue[0].uri }} style={{ width: '100%', height: '100%', resizeMode: 'cover' }} onLoad={() => setCaptureTrigger(Date.now())} />
              <View style={{ position: 'absolute', bottom: 30, left: 20, right: 20 }}>
                 <GPSCameraOverlay geoData={captureQueue[0].geoData} scale={2.5} />
              </View>
            </ViewShot>
          </View>
        </View>
      )}

      {/* VISITS MODAL */}
      <Modal visible={showVisitModal} transparent animationType="fade">
        <TouchableWithoutFeedback onPress={() => setShowVisitModal(false)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { maxHeight: '60%' }]}>
              <View style={styles.modalHeader}>
                 <Text style={styles.modalTitle}>Select Visit Session</Text>
                 <TouchableOpacity onPress={() => setShowVisitModal(false)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
              </View>
              <FlatList data={visits} keyExtractor={(i) => i} contentContainerStyle={{ paddingBottom: 40 }} ListFooterComponent={<Text style={{textAlign: 'center', padding: 15, color: '#94A3B8', fontWeight: 'bold'}}>------- {visits.length} visits in total ------</Text>} renderItem={({ item }) => (
                  <TouchableOpacity style={[styles.modalItem, activeVisit === item && styles.modalItemSelected]} onPress={() => { setActiveVisit(item); setShowVisitModal(false); }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Ionicons name="folder" size={20} color={activeVisit === item ? "#2563EB" : "#64748B"} style={{marginRight: 10}} />
                      <Text style={[styles.modalItemText, activeVisit === item && { color: '#2563EB', fontWeight: 'bold' }]}>{item}</Text>
                    </View>
                    {activeVisit === item && <Ionicons name="checkmark-circle" size={24} color="#2563EB" />}
                  </TouchableOpacity>
              )} />
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* TEXT COMMENT MODAL */}
      <Modal visible={showCommentModal} transparent animationType="slide">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.modalOverlay, { backgroundColor: '#F1F5F9' }]}>
          <View style={[styles.modalContent, { paddingBottom: 30, backgroundColor: '#F1F5F9', borderTopLeftRadius: 0, borderTopRightRadius: 0, paddingTop: 40 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Text Comment</Text>
              <TouchableOpacity onPress={() => setShowCommentModal(false)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
            </View>
            <View style={{ padding: 20 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.commentToolbar} keyboardShouldPersistTaps="always">
                 <TouchableOpacity style={styles.toolbarBtn} onPress={() => injectMarkdown('bullet')}><Ionicons name="list" size={16} color="#2563EB" /><Text style={styles.toolbarBtnText}>Bullets</Text></TouchableOpacity>
                 <TouchableOpacity style={styles.toolbarBtn} onPress={() => injectMarkdown('number')}><Ionicons name="list-circle" size={16} color="#2563EB" /><Text style={styles.toolbarBtnText}>Numbers</Text></TouchableOpacity>
                 <TouchableOpacity style={styles.toolbarBtn} onPress={() => injectMarkdown('roman')}><Text style={styles.toolbarBtnText}>Roman</Text></TouchableOpacity>
              </ScrollView>
              
              {/* Used globalStyles.input for consistency */}
              <TextInput ref={commentInputRef} style={[globalStyles.input, { height: 120, textAlignVertical: 'top' }]} multiline placeholder="Write observation..." value={commentText} onChangeText={setCommentText} autoFocus />
              
              {/* Used globalStyles.primaryBtn */}
              <TouchableOpacity style={globalStyles.primaryBtn} onPress={handleSaveComment}>
                <Text style={globalStyles.primaryBtnText}>Save Comment</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* FILES EXPLORER MODAL */}
      <Modal visible={showFilesModal} transparent animationType="fade">
        <TouchableWithoutFeedback onPress={() => setShowFilesModal(false)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={[styles.modalContent, { maxHeight: '85%' }]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Files in Session ({formatBytes(totalSessionSize)})</Text>
                  <TouchableOpacity onPress={() => setShowFilesModal(false)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
                </View>
                <View style={styles.filterControls}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <TouchableOpacity style={[styles.controlChip, {backgroundColor: '#F8FAFC'}]} onPress={() => setSortBy(sortBy === 'Date' ? 'Name' : 'Date')}>
                      <Text style={styles.controlChipText}>Sort: {sortBy}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.controlChip, {backgroundColor: '#F8FAFC'}]} onPress={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>
                      <Ionicons name={sortOrder === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} color="#2563EB" />
                    </TouchableOpacity>
                    {['All', 'Images', 'Videos', 'Audio', 'Docs'].map(f => (
                      <TouchableOpacity key={f} style={[styles.controlChip, filterType === f && { backgroundColor: '#2563EB' }]} onPress={() => setFilterType(f)}>
                        <Text style={[styles.controlChipText, filterType === f && { color: '#FFF' }]}>{f}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
                <FlatList
                  data={displayFiles}
                  keyExtractor={(item, idx) => `${item.folder}_${idx}`}
                  renderItem={({ item }) => (
                    <View style={styles.fileItemRow}>
                      <TouchableOpacity style={styles.fileItemContent} onPress={() => handlePreviewFile(item.folder, item.name)}>
                        <Ionicons name="document-text" size={24} color="#2563EB" style={{marginRight: 15}} />
                        <View style={{ flex: 1 }}><Text style={styles.fileItemName} numberOfLines={1}>{item.name}</Text><Text style={styles.fileItemFolder}>{item.folder === 'root' ? '/Location Pin' : `/${item.folder}`}</Text></View>
                        <Text style={styles.fileItemSize}>{formatBytes(item.size)}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => deleteFile(item.folder, item.name)} style={styles.deleteFileBtn}><Ionicons name="trash" size={20} color="#EF4444" /></TouchableOpacity>
                    </View>
                  )}
                  ListEmptyComponent={<Text style={{ padding: 20, textAlign: 'center', color: '#94A3B8' }}>No files match criteria.</Text>}
                />
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* FILE PREVIEW MODAL */}
      <Modal visible={!!previewFile} transparent animationType="slide">
        <View style={styles.previewOverlay}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle} numberOfLines={1}>{previewFile?.name}</Text>
            <TouchableOpacity onPress={() => setPreviewFile(null)} style={{ padding: 5 }}><Ionicons name="close" size={28} color="#FFF" /></TouchableOpacity>
          </View>
          <View style={styles.previewContainer}>
            {previewFile?.type === 'text' && <ScrollView style={styles.previewTextWrapper}><Text style={styles.previewText}>{previewFile.content}</Text></ScrollView>}
            {previewFile?.type === 'image' && <Image source={{ uri: previewFile.uri }} style={{ width: '100%', height: '100%', resizeMode: 'contain' }} />}
            {previewFile?.type === 'video' && <VideoPreview uri={previewFile.uri} />}
            {previewFile?.type === 'audio' && <AudioPreview uri={previewFile.uri} />}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const VideoPreview = ({ uri }: { uri: string }) => {
  const player = useVideoPlayer(uri, player => { player.play(); });
  return <View style={styles.videoWrapper}><VideoView player={player} style={{ flex: 1, width: '100%' }} /></View>;
};

const AudioPreview = ({ uri }: { uri: string }) => {
  const player = useAudioPlayer(uri);
  const [position, setPosition] = useState(0);
  const duration = player.duration || 1;

  useEffect(() => {
    player.play();
    const interval = setInterval(() => setPosition(player.currentTime), 500);
    return () => clearInterval(interval);
  }, [player]);

  return (
    <View style={styles.videoWrapper}>
      <Ionicons name="musical-notes" size={80} color="#334155" style={{ marginBottom: 40 }} />
      <Text style={styles.audioTextLabel}>Audio Note Player</Text>
      <View style={styles.audioProgressContainer}>
        <View style={styles.audioProgressBarBg}><View style={[styles.audioProgressBarFill, { width: `${(position / duration) * 100}%` }]} /></View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 30, gap: 30 }}>
        <TouchableOpacity onPress={() => player.seekTo(Math.max(0, player.currentTime - 5))}><Ionicons name="play-back" size={36} color="#FFF" /></TouchableOpacity>
        <TouchableOpacity onPress={() => player.playing ? player.pause() : player.play()}><Ionicons name={player.playing ? "pause-circle" : "play-circle"} size={64} color="#2563EB" /></TouchableOpacity>
        <TouchableOpacity onPress={() => player.seekTo(player.currentTime + 5)}><Ionicons name="play-forward" size={36} color="#FFF" /></TouchableOpacity>
      </View>
    </View>
  );
};

const GPSCameraOverlay = ({ geoData, scale = 1, isLive = false }: { geoData: any, scale?: number, isLive?: boolean }) => {
  const [liveTime, setLiveTime] = useState(geoData.timestamp);
  
  useEffect(() => {
     if (!isLive) return;
     const interval = setInterval(() => setLiveTime(formatGeoDate(new Date())), 1000);
     return () => clearInterval(interval);
  }, [isLive]);

  const displayTime = isLive ? liveTime : geoData.timestamp;

  const mapUrl = GOOGLE_MAPS_API_KEY 
    ? `https://maps.googleapis.com/maps/api/staticmap?center=${geoData.lat},${geoData.lon}&zoom=15&size=200x200&markers=color:red%7C${geoData.lat},${geoData.lon}&key=${GOOGLE_MAPS_API_KEY}`
    : `https://staticmap.openstreetmap.de/staticmap.php?center=${geoData.lat},${geoData.lon}&zoom=16&size=400x400&maptype=mapnik&markers=${geoData.lat},${geoData.lon},red-pushpin&t=${Date.now()}`;
  
  return (
    <View style={[styles.gpsOverlayContainer, { transform: [{ scale }], transformOrigin: 'bottom left' }]}>
      <View style={styles.gpsMapSquare}>
         {geoData.lat === "0.000000" ? <View style={{flex: 1, backgroundColor: '#334155', justifyContent: 'center', alignItems: 'center'}}><Ionicons name="map" size={32} color="#94A3B8" /></View> : <Image source={{ uri: mapUrl }} style={{ width: '100%', height: '100%' }} />}
      </View>
      <View style={styles.gpsTextContainer}>
         <Text style={styles.gpsTitle} numberOfLines={1}>{geoData.city}, {geoData.region}, {geoData.country} 🇮🇳</Text>
         <Text style={styles.gpsAddress} numberOfLines={2}>{geoData.address}</Text>
         <Text style={styles.gpsCoords}>Lat {geoData.lat}° Long {geoData.lon}°</Text>
         <Text style={styles.gpsTime}>{displayTime}</Text>
      </View>
    </View>
  );
};

const ActionButton = ({ icon, label, color, disabled, onPress, style }: any) => (
  <TouchableOpacity style={[styles.actionBtn, disabled && { opacity: 0.4 }, style]} disabled={disabled} onPress={onPress} activeOpacity={0.7}>
    <View style={[styles.actionIconWrap, { backgroundColor: `${color}15` }]}><Ionicons name={icon} size={22} color={color} /></View>
    <Text style={styles.actionLabel}>{label}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  visitSectionHeader: { fontSize: 13, fontWeight: '800', color: '#475569', textAlign: 'center', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  visitControls: { flexDirection: 'row', justifyContent: 'space-between' },
  visitBtnLight: { flexDirection: 'row', padding: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: '#CBD5E1', flex: 1, marginRight: 10 },
  visitBtnDark: { flexDirection: 'row', padding: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#2563EB', flex: 1 },
  activeVisitBox: { flexDirection: 'row', backgroundColor: '#DCFCE7', padding: 16, borderRadius: 10, alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#BBF7D0' },
  activeVisitLabel: { color: '#166534', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 2 },
  activeVisitText: { color: '#14532D', fontSize: 15, fontWeight: '800' },
  statsContainer: { backgroundColor: '#F8FAFC', padding: 15, borderRadius: 10, marginBottom: 20, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  statsTitle: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginBottom: 10 },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  statBadge: { backgroundColor: '#DBEAFE', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#BFDBFE' },
  statBadgeText: { fontSize: 12, color: '#1E40AF', fontWeight: '700', textTransform: 'capitalize' },
  noVisitText: { color: '#94A3B8', fontSize: 13, textAlign: 'center', marginBottom: 15, fontStyle: 'italic' },
  recordingUIBox: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FEF2F2', padding: 15, borderRadius: 12, borderWidth: 1, borderColor: '#FECACA', marginBottom: 15 },
  redDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#EF4444', marginRight: 8 },
  recordingTime: { fontSize: 16, fontWeight: 'bold', color: '#991B1B' },
  recordControlBtn: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 8 },
  
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: '3%', justifyContent: 'flex-start', paddingBottom: 0 },
  actionBtn: { width: '31%', backgroundColor: '#F8FAFC', padding: 12, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 10 },
  actionBtnPlaceholder: { width: '31%' },
  centeredRow: { width: '100%', flexDirection: 'row', justifyContent: 'center', gap: '4%', marginTop: 5 },
  actionIconWrap: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  actionLabel: { fontSize: 10, fontWeight: '700', color: '#475569', textAlign: 'center' },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalOverlayCen: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  modalItem: { flexDirection: 'row', justifyContent: 'space-between', padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9', alignItems: 'center' },
  modalItemSelected: { backgroundColor: '#EFF6FF' },
  modalItemText: { fontSize: 16, color: '#334155' },
  
  commentToolbar: { flexDirection: 'row', marginBottom: 10 },
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0', marginRight: 8 },
  toolbarBtnText: { marginLeft: 4, fontWeight: 'bold', color: '#334155', fontSize: 12 },
  
  filterControls: { flexDirection: 'row', paddingHorizontal: 15, paddingVertical: 10, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  controlChip: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#EFF6FF', borderRadius: 16, marginRight: 8, borderWidth: 1, borderColor: '#BFDBFE', justifyContent: 'center' },
  controlChipText: { color: '#2563EB', fontSize: 12, fontWeight: 'bold' },
  fileItemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', marginHorizontal: 15, marginBottom: 10, borderRadius: 10, borderWidth: 1, borderColor: '#F1F5F9' },
  fileItemContent: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: 15 },
  fileItemName: { fontSize: 14, color: '#1E293B', fontWeight: '700' },
  fileItemFolder: { fontSize: 11, color: '#64748B', textTransform: 'uppercase', marginTop: 2, fontWeight: '600' },
  fileItemSize: { fontSize: 12, color: '#94A3B8', fontWeight: 'bold', paddingHorizontal: 10 },
  deleteFileBtn: { padding: 15, borderLeftWidth: 1, borderColor: '#E2E8F0' },
  
  previewOverlay: { flex: 1, backgroundColor: '#000' },
  previewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 15, paddingTop: 50, paddingBottom: 15, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 10 },
  previewTitle: { color: '#FFF', fontSize: 16, fontWeight: 'bold', flex: 1, marginRight: 20 },
  previewContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111' },
  previewTextWrapper: { flex: 1, width: '100%', backgroundColor: '#FFF', padding: 20 },
  previewText: { fontSize: 16, color: '#1E293B', lineHeight: 24 },
  videoWrapper: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  audioTextLabel: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },
  audioProgressContainer: { width: '80%', marginTop: 20 },
  audioProgressBarBg: { width: '100%', height: 6, backgroundColor: '#334155', borderRadius: 3 },
  audioProgressBarFill: { height: 6, backgroundColor: '#2563EB', borderRadius: 3 },
  
  cameraTopTools: { position: 'absolute', top: 20, width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start', gap: 20, zIndex: 10 },
  cameraTopBtn: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: 10, borderRadius: 12, minWidth: 60 },
  cameraTopBtnText: { color: '#FFF', fontSize: 11, fontWeight: 'bold', marginTop: 4, textTransform: 'uppercase' },

  zoomControls: { flexDirection: 'row', marginTop: 10, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 20, overflow: 'hidden' },
  zoomBtn: { paddingHorizontal: 20, paddingVertical: 10 },
  zoomBtnText: { color: '#FFF', fontSize: 18, fontWeight: 'bold' },

  cameraControlsContainer: { flex: 1, width: '100%', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 30, backgroundColor: '#000' },
  cameraSideBtn: { padding: 10, borderRadius: 30, width: 60, alignItems: 'center', justifyContent: 'center' },
  cameraCaptureBtnOuter: { width: 74, height: 74, borderRadius: 37, borderWidth: 4, borderColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  cameraCaptureBtnInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFF' },
  
  gpsWaitingOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 50 },
  gpsOverlayContainer: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 5, paddingBottom: 5 },
  gpsMapSquare: { width: 90, height: 90, backgroundColor: '#E2E8F0', borderRadius: 12, overflow: 'hidden', borderWidth: 2, borderColor: '#FFF', marginRight: 10 },
  gpsTextContainer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', padding: 12, borderRadius: 12, minHeight: 90, justifyContent: 'center' },
  gpsTitle: { color: '#FFF', fontSize: 13, fontWeight: 'bold', marginBottom: 2 },
  gpsAddress: { color: '#E2E8F0', fontSize: 10, marginBottom: 4, lineHeight: 14 },
  gpsCoords: { color: '#FFF', fontSize: 10, fontWeight: '600' },
  gpsTime: { color: '#FFF', fontSize: 10, marginTop: 4 },
  
  photoQueueToast: { position: 'absolute', top: 100, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.8)', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, zIndex: 100 }
});