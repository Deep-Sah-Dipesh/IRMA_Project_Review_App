import React, { useEffect, useState, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Modal, TouchableWithoutFeedback, FlatList, TextInput, Image, ScrollView, ActivityIndicator, Dimensions, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as Location from 'expo-location';
import * as IntentLauncher from 'expo-intent-launcher';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useAudioPlayer } from 'expo-audio';
import { Audio } from 'expo-av';
import ViewShot from 'react-native-view-shot';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CAMERA_HEIGHT = SCREEN_WIDTH * (4 / 3); 

interface VisitManagerProps {
  projectId: string;
  tenderId: string;
  onEdit?: () => void;
}

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const get12HourTime = (d: Date) => {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const hours = d.getHours();
  const h12 = hours % 12 || 12;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(offset) / 60));
  const offM = pad(Math.abs(offset) % 60);
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return `${dayNames[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(h12)}:${pad(d.getMinutes())} ${ampm} GMT ${sign}${offH}:${offM}`;
};

export default function VisitManager({ projectId, tenderId, onEdit }: VisitManagerProps) {
  const [visits, setVisits] = useState<string[]>([]);
  const [activeVisit, setActiveVisit] = useState<string | null>(null);
  const [showVisitModal, setShowVisitModal] = useState(false);

  const [fileStats, setFileStats] = useState<Record<string, number>>({ total: 0 });
  const [showFilesModal, setShowFilesModal] = useState(false);
  const [savedFiles, setSavedFiles] = useState<{name: string, folder: string, time: number, size: number}[]>([]);
  
  const [filterType, setFilterType] = useState<string>('All');
  const [sortBy, setSortBy] = useState<'Date' | 'Name'>('Date');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

  const [previewFile, setPreviewFile] = useState<{uri: string, name: string, type: string, content?: string, geoData?: any} | null>(null);
  const [showCommentModal, setShowCommentModal] = useState(false);
  const [commentText, setCommentText] = useState('');
  
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordTime, setRecordTime] = useState(0);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);

  const [camPerm, reqCamPerm] = useCameraPermissions();
  const [micPerm, reqMicPerm] = useMicrophonePermissions();
  const [showLiveCamera, setShowLiveCamera] = useState(false);
  const [cameraMode, setCameraMode] = useState<'picture' | 'video'>('picture');
  const [cameraFacing, setCameraFacing] = useState<'back' | 'front'>('back');
  const [cameraRef, setCameraRef] = useState<CameraView | null>(null);
  
  const [liveGeoData, setLiveGeoData] = useState<any>(null);
  const [isFetchingGPS, setIsFetchingGPS] = useState(false);
  const locSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  
  const [isCameraRecording, setIsCameraRecording] = useState(false);
  const [camRecordTime, setCamRecordTime] = useState(0);
  const [isCameraPaused, setIsCameraPaused] = useState(false);

  const [stampingPhoto, setStampingPhoto] = useState<{ uri: string, geoData: any } | null>(null);
  const viewShotRef = useRef<ViewShot>(null);

  const getBaseDirectory = () => `${FileSystem.documentDirectory}projects/${projectId}_${tenderId}/`;

  useEffect(() => { scanExistingVisits(); }, [projectId, tenderId]);
  useEffect(() => { if (activeVisit) updateFileStats(); }, [activeVisit]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (recording && !isRecordingPaused) interval = setInterval(() => setRecordTime(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [recording, isRecordingPaused]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isCameraRecording && !isCameraPaused) interval = setInterval(() => setCamRecordTime(t => t + 1), 1000);
    else if (!isCameraRecording) setCamRecordTime(0);
    return () => clearInterval(interval);
  }, [isCameraRecording, isCameraPaused]);

  useEffect(() => {
    return () => { 
      if (recording) recording.stopAndUnloadAsync().catch(() => {}); 
      if (locSubscriptionRef.current) locSubscriptionRef.current.remove();
    };
  }, [recording]);

  useEffect(() => {
    if (stampingPhoto && viewShotRef.current) {
      setTimeout(async () => {
        try {
          const stampedUri = await viewShotRef.current?.capture?.();
          if (stampedUri) {
             const targetDir = await ensureSubfolder('geotagged_captures');
             await FileSystem.copyAsync({ from: stampedUri, to: `${targetDir}img_geo_${getFormattedDateTime()}.jpg` });
             updateFileStats();
             Alert.alert("Success", "Geotagged Photo saved with permanent watermark.");
          }
        } catch (e) {
          Alert.alert("Watermark Error", "Failed to embed GPS overlay into photo.");
        } finally {
          setStampingPhoto(null);
        }
      }, 500); 
    }
  }, [stampingPhoto]);

  const getFormattedDateTime = () => {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

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

  const createNewVisit = async () => {
    try {
      const baseUri = getBaseDirectory();
      const dirInfo = await FileSystem.getInfoAsync(baseUri);
      if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(baseUri, { intermediates: true });

      const visitNumber = visits.length + 1;
      const newVisitName = `VISIT_${visitNumber}_${getFormattedDateTime()}`;
      await FileSystem.makeDirectoryAsync(`${baseUri}${newVisitName}/`, { intermediates: true });
      
      setVisits([...visits, newVisitName].sort());
      setActiveVisit(newVisitName); 
      Alert.alert("New Visit Created", `Selected: ${newVisitName}`);
    } catch (e) { Alert.alert("Error", "Could not create visit directory."); }
  };

  const getFolderMapping = (filename: string, folderName: string) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'txt') return 'comments';
    if (['m4a', 'wav', 'mp3'].includes(ext!)) return 'audio';
    if (folderName === 'geotagged_captures') {
      if (['mp4', 'mov'].includes(ext!)) return 'geotagged_videos';
      return 'geotagged_photos';
    }
    if (folderName === 'attachments') {
      if (['mp4', 'mov'].includes(ext!)) return 'videos';
      if (['jpg', 'jpeg', 'png'].includes(ext!)) return 'photos';
      return 'documents';
    }
    if (ext === 'kml') return 'location';
    return 'documents';
  };

  const updateFileStats = async () => {
    try {
      const visitUri = `${getBaseDirectory()}${activeVisit}/`;
      const checkFolders = ['notes', 'attachments', 'geotagged_captures'];
      let stats: Record<string, number> = { comments: 0, audio: 0, documents: 0, photos: 0, videos: 0, geotagged_photos: 0, geotagged_videos: 0, location: 0, total: 0 };
      
      for (const folder of checkFolders) {
        const fUri = `${visitUri}${folder}/`;
        const info = await FileSystem.getInfoAsync(fUri);
        if (info.exists) {
          const files = await FileSystem.readDirectoryAsync(fUri);
          files.forEach(f => {
             if (!f.endsWith('.json')) {
                const category = getFolderMapping(f, folder);
                stats[category]++;
                stats.total++;
             }
          });
        }
      }
      
      const rootFiles = await FileSystem.readDirectoryAsync(visitUri);
      rootFiles.forEach(f => {
         if (f.endsWith('.kml')) {
            stats.location++;
            stats.total++;
         }
      });
      
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

  const silentEnsureLocation = async () => {
    try {
      const visitUri = `${getBaseDirectory()}${activeVisit}/`;
      const files = await FileSystem.readDirectoryAsync(visitUri);
      if (files.some(f => f.endsWith('.kml'))) return;

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      const kmlData = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Placemark>\n    <name>Project Geotag</name>\n    <Point>\n      <coordinates>${loc.coords.longitude},${loc.coords.latitude},0</coordinates>\n    </Point>\n  </Placemark>\n</kml>`;
      
      await FileSystem.writeAsStringAsync(`${visitUri}pin_${getFormattedDateTime()}.kml`, kmlData);
      updateFileStats();
    } catch (e) {}
  };

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (perm.status !== 'granted') return Alert.alert("Permission Denied", "Microphone access required.");
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: newRecording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      setRecordTime(0);
      setIsRecordingPaused(false);
      setRecording(newRecording);
      silentEnsureLocation();
    } catch (err) { Alert.alert("Error", "Failed to start recording."); }
  };

  const togglePauseRecording = async () => {
    if (!recording) return;
    try {
      if (isRecordingPaused) {
        await recording.startAsync();
        setIsRecordingPaused(false);
      } else {
        await recording.pauseAsync();
        setIsRecordingPaused(true);
      }
    } catch (e) { Alert.alert("Error", "Failed to toggle recording state."); }
  };

  const stopRecording = async () => {
    if (!recording) return;
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);
      setRecordTime(0);
      setIsRecordingPaused(false);
      
      if (uri) {
        const targetDir = await ensureSubfolder('notes');
        await FileSystem.copyAsync({ from: uri, to: `${targetDir}audio_${getFormattedDateTime()}.m4a` });
        updateFileStats();
        Alert.alert("Success", "Voice note saved.");
      }
    } catch (err) { Alert.alert("Error", "Failed to save recording."); }
  };

  const handleVoiceNote = () => recording ? stopRecording() : startRecording();

  const handleSaveComment = async () => {
    if (!commentText.trim()) return;
    try {
      const targetDir = await ensureSubfolder('notes');
      await FileSystem.writeAsStringAsync(`${targetDir}comment_${getFormattedDateTime()}.txt`, commentText);
      setCommentText('');
      setShowCommentModal(false);
      updateFileStats();
      silentEnsureLocation();
    } catch (e) { Alert.alert("Error", "Failed to save comment."); }
  };

  const handleAttachFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.length) return;
      const targetDir = await ensureSubfolder('attachments');
      const ext = result.assets[0].name.split('.').pop() || 'file';
      await FileSystem.copyAsync({ from: result.assets[0].uri, to: `${targetDir}doc_${getFormattedDateTime()}.${ext}` });
      updateFileStats();
      silentEnsureLocation();
    } catch (e) { Alert.alert("Error", "Failed to attach document."); }
  };

  const getFallbackGeoData = async () => {
     try {
       const targetDir = `${getBaseDirectory()}${activeVisit}/`;
       const files = await FileSystem.readDirectoryAsync(targetDir);
       const kmlFile = files.find(f => f.endsWith('.kml'));
       if (kmlFile) {
         const content = await FileSystem.readAsStringAsync(`${targetDir}${kmlFile}`);
         const coordMatch = content.match(/<coordinates>([^,]+),([^,]+)/);
         if (coordMatch) {
           return {
             lat: parseFloat(coordMatch[2]).toFixed(6),
             lon: parseFloat(coordMatch[1]).toFixed(6),
             timestamp: get12HourTime(new Date()),
             address: "Pinned Location (Offline mode)",
             city: "Local", region: "Pinned", country: "India"
           };
         }
       }
     } catch (e) {}
     return {
       lat: "0.000000", lon: "0.000000", 
       timestamp: get12HourTime(new Date()),
       address: "Location Unknown", city: "-", region: "-", country: ""
     };
  };

  const openLiveGeotagCamera = async (mode: 'picture' | 'video') => {
    try {
      if (!camPerm?.granted) {
        const res = await reqCamPerm();
        if (!res.granted) return Alert.alert("Camera Permission Denied");
      }
      if (mode === 'video' && !micPerm?.granted) {
        const res = await reqMicPerm();
        if (!res.granted) return Alert.alert("Microphone Permission Denied");
      }

      setCameraMode(mode);
      setLiveGeoData(null);
      setIsFetchingGPS(true);
      setShowLiveCamera(true);

      const { status: locStatus } = await Location.requestForegroundPermissionsAsync();
      if (locStatus !== 'granted') {
         setLiveGeoData(await getFallbackGeoData());
         setIsFetchingGPS(false);
         return;
      }

      if (locSubscriptionRef.current) locSubscriptionRef.current.remove();
      
      locSubscriptionRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 10 },
        async (loc) => {
          try {
            const geocode = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
            const addressObj = geocode[0] || {};
            setLiveGeoData({
              lat: loc.coords.latitude.toFixed(6), 
              lon: loc.coords.longitude.toFixed(6), 
              timestamp: get12HourTime(new Date(loc.timestamp)),
              address: `${addressObj.street || ''} ${addressObj.district || ''}, ${addressObj.city || ''} ${addressObj.postalCode || ''}`.trim(),
              city: addressObj.city || addressObj.subregion || 'Unknown City',
              region: addressObj.region || 'Unknown Region',
              country: addressObj.country || 'India'
            });
            setIsFetchingGPS(false);
          } catch (e) {
            setLiveGeoData(await getFallbackGeoData());
            setIsFetchingGPS(false);
          }
        }
      );
    } catch (e) { Alert.alert("Camera Error", "Failed to launch camera interface."); }
  };

  const closeLiveCamera = () => {
    if (locSubscriptionRef.current) locSubscriptionRef.current.remove();
    setShowLiveCamera(false);
    setIsCameraRecording(false);
  };

  const captureLiveMedia = async () => {
    if (!cameraRef) return;
    try {
      const isVideo = cameraMode === 'video';
      const targetDir = await ensureSubfolder('geotagged_captures');
      const safeGeoData = liveGeoData || await getFallbackGeoData();

      if (isVideo) {
        if (isCameraRecording) {
          cameraRef.stopRecording();
          setIsCameraRecording(false);
          closeLiveCamera();
        } else {
          setIsCameraRecording(true);
          const videoRecord = await cameraRef.recordAsync();
          if (videoRecord) {
            const fileName = `vid_geo_${getFormattedDateTime()}`;
            await FileSystem.copyAsync({ from: videoRecord.uri, to: `${targetDir}${fileName}.mp4` });
            await FileSystem.writeAsStringAsync(`${targetDir}${fileName}.json`, JSON.stringify(safeGeoData));
            updateFileStats();
          }
        }
      } else {
        const photo = await cameraRef.takePictureAsync();
        if (photo) {
          setStampingPhoto({ uri: photo.uri, geoData: safeGeoData });
          closeLiveCamera();
        }
      }
    } catch (e) { Alert.alert("Capture Error", "Failed to save media."); }
  };

  const handleCaptureNormalMedia = async (mediaType: 'photo' | 'video') => {
    try {
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: mediaType === 'video' ? ['videos'] : ['images'], allowsEditing: false });
      if (result.canceled || !result.assets?.length) return;
      const targetDir = await ensureSubfolder('attachments');
      const prefix = mediaType === 'video' ? 'vid_' : 'img_';
      const ext = mediaType === 'video' ? 'mp4' : 'jpg';
      await FileSystem.copyAsync({ from: result.assets[0].uri, to: `${targetDir}${prefix}${getFormattedDateTime()}.${ext}` });
      updateFileStats();
      silentEnsureLocation();
    } catch (e) {}
  };

  const handlePinGeotag = async () => {
    try {
      const visitUri = `${getBaseDirectory()}${activeVisit}/`;
      const existingFiles = await FileSystem.readDirectoryAsync(visitUri);
      const hasKml = existingFiles.some(f => f.endsWith('.kml'));

      const savePin = async (replaceExisting: boolean) => {
        try {
          if (replaceExisting) {
            for (const file of existingFiles) {
              if (file.endsWith('.kml')) await FileSystem.deleteAsync(`${visitUri}${file}`);
            }
          }
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status !== 'granted') return Alert.alert("Location Denied");
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          
          const kmlData = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Placemark>\n    <name>Project Geotag</name>\n    <Point>\n      <coordinates>${loc.coords.longitude},${loc.coords.latitude},0</coordinates>\n    </Point>\n  </Placemark>\n</kml>`;
          await FileSystem.writeAsStringAsync(`${visitUri}pin_${getFormattedDateTime()}.kml`, kmlData);
          updateFileStats();
          Alert.alert("Geotag Pinned", "KML coordinates saved successfully.");
        } catch (e) { Alert.alert("Error", "Failed to save Geotag Pin"); }
      };

      if (hasKml) {
        Alert.alert("Geotag Pin Exists", "A pinned KML location already exists for this visit.", [
          { text: "Cancel", style: "cancel" },
          { text: "Replace Latest", style: "destructive", onPress: () => savePin(true) },
          { text: "Add New", onPress: () => savePin(false) }
        ]);
      } else {
        savePin(false);
      }
    } catch (e) {}
  };

  const refreshFilesExplorer = async () => {
    try {
      const visitUri = `${getBaseDirectory()}${activeVisit}/`;
      const info = await FileSystem.getInfoAsync(visitUri);
      if (!info.exists) { setSavedFiles([]); return; }
      
      let allFiles: {name: string, folder: string, time: number, size: number}[] = [];
      const checkFolders = ['notes', 'attachments', 'geotagged_captures', ''];
      
      for (const folder of checkFolders) {
        const subUri = folder ? `${visitUri}${folder}/` : visitUri;
        const subInfo = await FileSystem.getInfoAsync(subUri);
        if (subInfo.exists && subInfo.isDirectory) {
          const files = await FileSystem.readDirectoryAsync(subUri);
          for(const f of files) {
             if(!f.endsWith('.json') && !f.startsWith('visit_')) {
                const fileStat = await FileSystem.getInfoAsync(`${subUri}${f}`);
                allFiles.push({ name: f, folder: folder || 'root', time: fileStat.modificationTime || 0, size: fileStat.size || 0 });
             }
          }
        }
      }
      setSavedFiles(allFiles);
    } catch (e) {}
  };

  const openFilesExplorer = async () => {
    await refreshFilesExplorer();
    setShowFilesModal(true);
  };

  const deleteFile = (folder: string, name: string) => {
    Alert.alert("Confirm Delete", `Delete ${name}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
          try {
            const folderPath = folder === 'root' ? '' : `${folder}/`;
            const uri = `${getBaseDirectory()}${activeVisit}/${folderPath}${name}`;
            await FileSystem.deleteAsync(uri);
            const baseName = name.substring(0, name.lastIndexOf('.'));
            const jsonUri = `${getBaseDirectory()}${activeVisit}/${folderPath}${baseName}.json`;
            const jsonInfo = await FileSystem.getInfoAsync(jsonUri);
            if (jsonInfo.exists) await FileSystem.deleteAsync(jsonUri);
            await refreshFilesExplorer();
            updateFileStats();
          } catch (e) { Alert.alert("Error", "Failed to delete file."); }
        }
      }
    ]);
  };

  const handlePreviewFile = async (folder: string, name: string) => {
    try {
      const folderPath = folder === 'root' ? '' : `${folder}/`;
      const uri = `${getBaseDirectory()}${activeVisit}/${folderPath}${name}`;
      const ext = name.split('.').pop()?.toLowerCase() || '';

      let type = 'doc';
      if (['txt', 'csv', 'json'].includes(ext)) type = 'text';
      else if (['jpg', 'jpeg', 'png'].includes(ext)) type = 'image';
      else if (['mp4', 'mov'].includes(ext)) type = 'video';
      else if (['m4a', 'mp3', 'wav'].includes(ext)) type = 'audio';

      let geoData = null;
      if (folder === 'geotagged_captures') {
        const baseName = name.substring(0, name.lastIndexOf('.'));
        const jsonUri = `${getBaseDirectory()}${activeVisit}/${folderPath}${baseName}.json`;
        const jsonInfo = await FileSystem.getInfoAsync(jsonUri);
        if (jsonInfo.exists) geoData = JSON.parse(await FileSystem.readAsStringAsync(jsonUri));
      }

      if (type === 'text') {
        const content = await FileSystem.readAsStringAsync(uri);
        setPreviewFile({ uri, name, type, content });
      } else if (type === 'doc') {
        if (Platform.OS === 'android') {
          try {
            const contentUri = await FileSystem.getContentUriAsync(uri);
            await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: contentUri, flags: 1 });
          } catch (e) { await Sharing.shareAsync(uri); }
        } else {
          await Sharing.shareAsync(uri); 
        }
      } else {
        setPreviewFile({ uri, name, type, geoData });
      }
    } catch (e) { Alert.alert("Preview Error", "Could not load the file preview."); }
  };

  const displayFiles = useMemo(() => {
    let filtered = savedFiles;
    if (filterType !== 'All') {
      filtered = savedFiles.filter(f => {
        const ext = f.name.split('.').pop()?.toLowerCase() || '';
        if (filterType === 'Images') return ['jpg', 'png'].includes(ext);
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
    <View style={styles.visitContainer}>
      <Text style={[styles.sectionTitle, { textAlign: 'center' }]}>Field Visit Session</Text>
      <View style={styles.visitControls}>
        <TouchableOpacity style={styles.visitBtnLight} onPress={() => setShowVisitModal(true)}>
          <Ionicons name="list" size={16} color="#334155" style={{ marginRight: 6 }} /><Text style={{ color: '#334155', fontWeight: 'bold', fontSize: 13 }}>Select From Visits</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.visitBtnDark} onPress={createNewVisit}>
          <Ionicons name="add-circle" size={16} color="#FFF" style={{ marginRight: 6 }} /><Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 13 }}>Create New Visit</Text>
        </TouchableOpacity>
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
                  return (
                    <View key={key} style={styles.statBadge}>
                      <Text style={styles.statBadgeText}>{count} {key.replace('_', ' ')}</Text>
                    </View>
                  );
                })}
              </View>
            </View>
          )}
        </View>
      ) : (
        <Text style={styles.noVisitText}>Select or Create a visit report session to unlock media buttons.</Text>
      )}

      {recording && (
        <View style={styles.recordingUIBox}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={styles.redDot} />
            <Text style={styles.recordingTime}>{formatTime(recordTime)}</Text>
          </View>
          <TouchableOpacity style={[styles.recordControlBtn, { backgroundColor: '#FEE2E2' }]} onPress={stopRecording}>
            <Ionicons name="square" size={20} color="#EF4444" />
            <Text style={{color: '#EF4444', fontWeight: 'bold', marginLeft: 6}}>Stop & Save</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* NON-BLOCKING GRID */}
      <View style={[styles.actionGrid, !activeVisit && { opacity: 0.3 }]} pointerEvents={!activeVisit ? 'none' : 'auto'}>
        <ActionButton icon={recording ? "stop-circle" : "mic"} label={recording ? "Recording..." : "Voice Note"} color={recording ? "#EF4444" : "#EA580C"} onPress={handleVoiceNote} />
        <ActionButton icon="chatbubble-ellipses" label="Text Comment" color="#059669" onPress={() => setShowCommentModal(true)} />
        <ActionButton icon="attach" label="Attach File" color="#7C3AED" onPress={handleAttachFile} />
        
        <ActionButton icon="film" label="Geotag Video" color="#9333EA" onPress={() => openLiveGeotagCamera('video')} disabled={recording !== null} />
        <ActionButton icon="image" label="Geotag Photo" color="#0284C7" onPress={() => openLiveGeotagCamera('picture')} disabled={recording !== null} />
        <ActionButton icon="location" label="Pin Geotag" color="#0891B2" onPress={handlePinGeotag} disabled={recording !== null} />
        
        <ActionButton icon="videocam-outline" label="Normal Video" color="#DB2777" onPress={() => handleCaptureNormalMedia('video')} disabled={recording !== null} />
        <ActionButton icon="camera-outline" label="Normal Photo" color="#2563EB" onPress={() => handleCaptureNormalMedia('photo')} disabled={recording !== null} />
        <ActionButton icon="folder-open" label="Show Files" color="#475569" onPress={openFilesExplorer} />
      </View>

      {/* --- LIVE CAMERA MODAL --- */}
      <Modal visible={showLiveCamera} transparent animationType="none">
         <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'flex-start' }}>
            
            {/* The 4:3 Fixed Aspect Ratio Viewfinder Container */}
            <View style={{ width: SCREEN_WIDTH, height: CAMERA_HEIGHT, backgroundColor: '#111', overflow: 'hidden' }}>
              <CameraView ref={setCameraRef} style={StyleSheet.absoluteFillObject} mode={cameraMode} facing={cameraFacing} />
              
              {/* Overlay Layer exactly matching final physical image */}
              <View style={StyleSheet.absoluteFillObject}>
                 <View style={{ flex: 1, padding: 10, justifyContent: 'space-between' }}>
                    <View style={{ alignItems: 'center', paddingTop: 10 }}>
                      {isFetchingGPS && (
                         <View style={styles.gpsFetchingBadge}>
                           <ActivityIndicator size="small" color="#FFF" style={{marginRight: 8}}/>
                           <Text style={{color:'#FFF', fontWeight: 'bold'}}>Acquiring GPS...</Text>
                         </View>
                      )}
                    </View>
                    {/* Positioned inside 4:3 box exactly where it belongs */}
                    <View style={{ paddingBottom: 10 }}>
                      {liveGeoData && !isFetchingGPS && <GPSCameraOverlay geoData={liveGeoData} />}
                    </View>
                 </View>
              </View>
            </View>
            
            {/* The Controls Area in the Black Bottom Section */}
            <View style={styles.cameraControlsContainer}>
               <TouchableOpacity onPress={closeLiveCamera} style={styles.cameraSideBtn}>
                 <Ionicons name="close" size={36} color="#FFF" />
               </TouchableOpacity>
               
               {cameraMode === 'video' && isCameraRecording ? (
                  <View style={{ alignItems: 'center' }}>
                     <Text style={styles.camTimerText}>{formatTime(camRecordTime)}</Text>
                     <TouchableOpacity onPress={captureLiveMedia} style={[styles.cameraCaptureBtnOuter, { borderColor: '#EF4444' }]}>
                       <View style={[styles.cameraCaptureBtnInner, { backgroundColor: '#EF4444', borderRadius: 8, width: 30, height: 30 }]} />
                     </TouchableOpacity>
                  </View>
               ) : (
                 <TouchableOpacity onPress={captureLiveMedia} style={styles.cameraCaptureBtnOuter}>
                   <View style={[styles.cameraCaptureBtnInner, cameraMode === 'video' && { backgroundColor: '#EF4444' }]} />
                 </TouchableOpacity>
               )}
               
               {(isCameraRecording && cameraMode === 'video') ? (
                  <View style={{ width: 60 }} /> 
               ) : (
                  <TouchableOpacity onPress={() => setCameraFacing(f => f === 'back' ? 'front' : 'back')} style={styles.cameraSideBtn}>
                    <Ionicons name="camera-reverse" size={32} color="#FFF" />
                  </TouchableOpacity>
               )}
            </View>
         </View>
      </Modal>

      {/* --- PHYSICAL PHOTO WATERMARK STAMPING MODAL --- */}
      <Modal visible={!!stampingPhoto} transparent>
        <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center' }}>
          <ViewShot ref={viewShotRef} options={{ format: 'jpg', quality: 0.9 }} style={{ width: SCREEN_WIDTH, height: CAMERA_HEIGHT, backgroundColor: '#111', overflow: 'hidden' }}>
            <Image source={{ uri: stampingPhoto?.uri }} style={{ flex: 1, resizeMode: 'cover' }} />
            <View style={{ position: 'absolute', bottom: 20, left: 10, right: 10 }}>
               <GPSCameraOverlay geoData={stampingPhoto?.geoData} />
            </View>
          </ViewShot>
          <View style={{ position: 'absolute', bottom: 50, alignSelf: 'center' }}>
            <ActivityIndicator size="large" color="#FFF" />
            <Text style={{ color: '#FFF', marginTop: 10, fontWeight: 'bold' }}>Stamping Watermark...</Text>
          </View>
        </View>
      </Modal>

      {/* --- OTHER MODALS --- */}
      <Modal visible={showVisitModal} transparent animationType="fade">
        <TouchableWithoutFeedback onPress={() => setShowVisitModal(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}><Text style={styles.modalTitle}>Select Visit Session</Text></View>
              <FlatList data={visits} keyExtractor={(i) => i} renderItem={({ item }) => (
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

      <Modal visible={showCommentModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '50%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Text Comment</Text>
              <TouchableOpacity onPress={() => setShowCommentModal(false)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
            </View>
            <View style={{ padding: 20 }}>
              <TextInput style={styles.commentInput} multiline placeholder="Write observation..." value={commentText} onChangeText={setCommentText} />
              <TouchableOpacity style={styles.saveCommentBtn} onPress={handleSaveComment}><Text style={{ color: '#FFF', fontWeight: 'bold' }}>Save Comment</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showFilesModal} transparent animationType="fade">
        <TouchableWithoutFeedback onPress={() => setShowFilesModal(false)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={[styles.modalContent, { maxHeight: '85%' }]}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Files in Session</Text>
                  <TouchableOpacity onPress={() => setShowFilesModal(false)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
                </View>
                
                <View style={styles.filterControls}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <TouchableOpacity style={styles.controlChip} onPress={() => setSortBy(sortBy === 'Date' ? 'Name' : 'Date')}>
                      <Text style={styles.controlChipText}>Sort: {sortBy}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.controlChip} onPress={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>
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
                        <View style={{ flex: 1 }}>
                          <Text style={styles.fileItemName} numberOfLines={1}>{item.name}</Text>
                          <Text style={styles.fileItemFolder}>/{item.folder}</Text>
                        </View>
                        <Text style={styles.fileItemSize}>{formatBytes(item.size)}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => deleteFile(item.folder, item.name)} style={styles.deleteFileBtn}>
                        <Ionicons name="trash" size={20} color="#EF4444" />
                      </TouchableOpacity>
                    </View>
                  )}
                  ListEmptyComponent={<Text style={{ padding: 20, textAlign: 'center', color: '#94A3B8' }}>No files match criteria.</Text>}
                />
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* MEDIA PREVIEW OVERLAY */}
      <Modal visible={!!previewFile} transparent animationType="slide">
        <View style={styles.previewOverlay}>
          <View style={styles.previewHeader}>
            <Text style={styles.previewTitle} numberOfLines={1}>{previewFile?.name}</Text>
            <TouchableOpacity onPress={() => setPreviewFile(null)} style={{ padding: 5 }}><Ionicons name="close" size={28} color="#FFF" /></TouchableOpacity>
          </View>
          <View style={styles.previewContainer}>
            {previewFile?.type === 'text' && <ScrollView style={styles.previewTextWrapper}><Text style={styles.previewText}>{previewFile.content}</Text></ScrollView>}
            
            {previewFile?.type === 'image' && (
               <View style={{ flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' }}>
                 <View style={{ width: SCREEN_WIDTH, height: CAMERA_HEIGHT, backgroundColor: '#111', overflow: 'hidden' }}>
                    <Image source={{ uri: previewFile.uri }} style={{ width: '100%', height: '100%', resizeMode: 'contain' }} />
                    {previewFile.geoData && ( 
                       <View style={{ position: 'absolute', bottom: 20, left: 10, right: 10 }}>
                         <GPSCameraOverlay geoData={previewFile.geoData} />
                       </View>
                    )}
                 </View>
               </View>
            )}

            {previewFile?.type === 'video' && <VideoPreview uri={previewFile.uri} geoData={previewFile.geoData} />}
            {previewFile?.type === 'audio' && <AudioPreview uri={previewFile.uri} />}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const VideoPreview = ({ uri, geoData }: { uri: string, geoData?: any }) => {
  const player = useVideoPlayer(uri, player => { player.play(); });
  return (
    <View style={styles.videoWrapper}>
      <View style={{ width: SCREEN_WIDTH, height: CAMERA_HEIGHT, backgroundColor: '#111', overflow: 'hidden' }}>
         <VideoView player={player} style={{ flex: 1 }} fullscreenOptions={{ ios: { active: false }, android: { active: false } }} />
         {geoData && (
            <View style={{ position: 'absolute', bottom: 20, left: 10, right: 10, pointerEvents: 'none' }}>
              <GPSCameraOverlay geoData={geoData} />
            </View>
         )}
      </View>
    </View>
  );
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

  const scrubForward = () => player.seekTo(player.currentTime + 5);
  const scrubBackward = () => player.seekTo(Math.max(0, player.currentTime - 5));

  return (
    <View style={styles.videoWrapper}>
      <Ionicons name="musical-notes" size={80} color="#334155" style={{ marginBottom: 40 }} />
      <Text style={styles.audioTextLabel}>Audio Note Player</Text>
      
      <View style={styles.audioProgressContainer}>
        <View style={styles.audioProgressBarBg}>
          <View style={[styles.audioProgressBarFill, { width: `${(position / duration) * 100}%` }]} />
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 30, gap: 30 }}>
        <TouchableOpacity onPress={scrubBackward}><Ionicons name="play-back" size={36} color="#FFF" /></TouchableOpacity>
        <TouchableOpacity onPress={() => player.playing ? player.pause() : player.play()}>
          <Ionicons name={player.playing ? "pause-circle" : "play-circle"} size={64} color="#2563EB" />
        </TouchableOpacity>
        <TouchableOpacity onPress={scrubForward}><Ionicons name="play-forward" size={36} color="#FFF" /></TouchableOpacity>
      </View>
    </View>
  );
};

// Accurately replicates the GPS Map Camera UI: Map block detached, matching height, padded layout
const GPSCameraOverlay = ({ geoData }: { geoData: any }) => {
  const isInvalid = geoData.lat === "0.000000";
  // Add precise timestamp to force map reload dynamically
  const mapUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${geoData.lat},${geoData.lon}&zoom=15&size=150x150&markers=${geoData.lat},${geoData.lon},red-pushpin&t=${Date.now()}`;
  
  return (
    <View style={styles.gpsOverlayContainer}>
      <View style={styles.gpsMapSquare}>
         {isInvalid ? (
            <View style={{flex: 1, backgroundColor: '#334155', justifyContent: 'center', alignItems: 'center'}}>
               <Ionicons name="map" size={32} color="#94A3B8" />
            </View>
         ) : (
            <Image source={{ uri: mapUrl }} style={{ width: '100%', height: '100%' }} />
         )}
         <Text style={styles.googleWatermark}>Google</Text>
      </View>
      <View style={styles.gpsTextContainer}>
         <Text style={styles.gpsTitle} numberOfLines={1}>{geoData.city}, {geoData.region}, {geoData.country} 🇮🇳</Text>
         <Text style={styles.gpsAddress} numberOfLines={3}>{geoData.address}</Text>
         <Text style={styles.gpsCoords}>Lat {geoData.lat}° Long {geoData.lon}°</Text>
         <Text style={styles.gpsTime}>{geoData.timestamp}</Text>
      </View>
    </View>
  );
};

const ActionButton = ({ icon, label, color, disabled, onPress }: any) => (
  <TouchableOpacity style={[styles.actionBtn, disabled && { opacity: 0.4 }]} disabled={disabled} onPress={onPress} activeOpacity={0.7}>
    <View style={[styles.actionIconWrap, { backgroundColor: `${color}15` }]}><Ionicons name={icon} size={22} color={color} /></View>
    <Text style={styles.actionLabel}>{label}</Text>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  sectionTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', marginBottom: 12, textTransform: 'uppercase' },
  visitContainer: { backgroundColor: '#FFF', padding: 16, borderRadius: 16, marginBottom: 25, borderWidth: 1, borderColor: '#E2E8F0' },
  visitControls: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 },
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
  
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' },
  actionBtn: { width: '31%', backgroundColor: '#F8FAFC', padding: 12, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 2 },
  actionIconWrap: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  actionLabel: { fontSize: 10, fontWeight: '700', color: '#475569', textAlign: 'center' },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  modalItem: { flexDirection: 'row', justifyContent: 'space-between', padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9', alignItems: 'center' },
  modalItemSelected: { backgroundColor: '#EFF6FF' },
  modalItemText: { fontSize: 16, color: '#334155' },
  commentInput: { backgroundColor: '#F1F5F9', padding: 15, borderRadius: 10, height: 100, textAlignVertical: 'top', fontSize: 15 },
  saveCommentBtn: { backgroundColor: '#059669', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 15 },
  
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
  
  // Camera Controls Area completely outside the 4:3 frame bounds
  cameraControlsContainer: { height: 140, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 40, backgroundColor: '#000' },
  cameraSideBtn: { padding: 10, borderRadius: 30, width: 60, alignItems: 'center' },
  cameraCaptureBtnOuter: { width: 74, height: 74, borderRadius: 37, borderWidth: 4, borderColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  cameraCaptureBtnInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFF' },
  camTimerText: { color: '#FFF', fontSize: 16, fontWeight: 'bold', marginBottom: 6 },
  
  // GPS Overlay - Perfected Styling Matching Screenshot exactly
  gpsFetchingBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: 12, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  gpsOverlayContainer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5, paddingBottom: 5 },
  gpsMapSquare: { width: 90, height: 90, backgroundColor: '#E2E8F0', borderRadius: 12, overflow: 'hidden', borderWidth: 2, borderColor: '#FFF', marginRight: 10, elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 3, zIndex: 2 },
  googleWatermark: { position: 'absolute', bottom: 4, left: 6, color: '#FFF', fontSize: 12, fontWeight: 'bold', textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 3 },
  gpsTextContainer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', padding: 12, borderRadius: 12, minHeight: 90, justifyContent: 'center' },
  gpsTitle: { color: '#FFF', fontSize: 13, fontWeight: 'bold', marginBottom: 2 },
  gpsAddress: { color: '#E2E8F0', fontSize: 10, marginBottom: 4, lineHeight: 14 },
  gpsCoords: { color: '#FFF', fontSize: 10, fontWeight: '600' },
  gpsTime: { color: '#FFF', fontSize: 10, marginTop: 4 }
});