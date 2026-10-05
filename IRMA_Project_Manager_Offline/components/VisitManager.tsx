import React, { useEffect, useState, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Modal, TouchableWithoutFeedback, FlatList, TextInput, Image, ScrollView, Platform, useWindowDimensions, KeyboardAvoidingView, ActivityIndicator } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { getQuarterStr, getQuarterFromYYYYMMDD, previousQuarter } from '../utils/period';
import * as Location from 'expo-location';
import * as Linking from 'expo-linking';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useAudioPlayer, useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import ViewShot from 'react-native-view-shot';
import * as Print from 'expo-print';
import * as Haptics from 'expo-haptics'; 
import * as SecureStore from 'expo-secure-store'; 
import { doc, getDoc } from 'firebase/firestore'; 
import { Accelerometer } from 'expo-sensors'; 
 
import * as ImageManipulator from 'expo-image-manipulator';
import ImageViewer from 'react-native-image-zoom-viewer';

import { db as firestoreDb } from '../utils/firebaseConfig';
import { globalStyles } from '../styles/globalStyles';
import { getActiveUserId, setDashboardDirty } from '../utils/userSession';

const GOOGLE_MAPS_API_KEY = "AIzaSyCvXa2qgN2StFVT9N9LwuF1hpK57iuIzHg";

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
  return `${days[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(h12)}:${pad(d.getMinutes())} ${ampm} GMT ${sign}${offH}:${offM}`;
};

const ZOOM_STEPS = [0, 0.15, 0.3, 0.5, 0.75, 1.0];
const ZOOM_LABELS = ['1x', '1.5x', '2x', '3x', '4x', '5x'];



export default function VisitManager({ projectId, tenderId, folderName, onEdit }: VisitManagerProps) {
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();

  const [activeUserId, setActiveUserId] = useState<string>('AnonymousUser');

  const [visits, setVisits] = useState<string[]>([]);
  const [activeVisit, setActiveVisit] = useState<string | null>(null);
  const [showVisitModal, setShowVisitModal] = useState(false);
  const [fileStats, setFileStats] = useState<Record<string, number>>({ total: 0 });
  const [showFilesModal, setShowFilesModal] = useState(false);
  const [savedFiles, setSavedFiles] = useState<any[]>([]);
  const [totalSessionSize, setTotalSessionSize] = useState(0);
  
  // File Explorer Controls
  const [filterType, setFilterType] = useState<string>('All');
  const [sortBy, setSortBy] = useState<'Date' | 'Name'>('Date');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [isGridView, setIsGridView] = useState<boolean>(true); // View Toggle State
  const [isSelectionMode, setIsSelectionMode] = useState<boolean>(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // Previous Trimester Media
  const [prevTrimesterMedia, setPrevTrimesterMedia] = useState<any[]>([]);
  const [prevTrimesterName, setPrevTrimesterName] = useState<string | null>(null);
 
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewFileContent, setPreviewFileContent] = useState<string | null>(null);
  const [imagePreviewZoom, setImagePreviewZoom] = useState(1);

  const previewScrollY = useRef<ScrollView>(null);
  const previewScrollX = useRef<ScrollView>(null);

  const [showCommentModal, setShowCommentModal] = useState(false);
  const [commentText, setCommentText] = useState('');
  const commentInputRef = useRef<TextInput>(null);

  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewSeverity, setReviewSeverity] = useState<any>(null);
  const [reviewParams, setReviewParams] = useState({ quality: 'Not Evaluated', timeLimit: 'On Schedule', output: 'Standard' });
  const [existingReviewPath, setExistingReviewPath] = useState<string | null>(null);
 
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecordingState, setIsRecordingState] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);

  const [camPerm, reqCamPerm] = useCameraPermissions();
  const [showLiveCamera, setShowLiveCamera] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<'back' | 'front'>('back');
  const [flashMode, setFlashMode] = useState<'off' | 'on' | 'auto'>('auto');
  
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '4:3'>('4:3');
 
  const [showZoom, setShowZoom] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(0); 
  const zoomTimeoutRef = useRef<any>(null);
  const lastZoomTap = useRef<number>(0);
  const lastImageTap = useRef<number>(0);
  const [isCapturing, setIsCapturing] = useState(false);
  
  const [deviceOrientation, setDeviceOrientation] = useState(0); 
  const [focusPoint, setFocusPoint] = useState<{x: number, y: number} | null>(null);
 
  const [isDocScannerMode, setIsDocScannerMode] = useState(false);
  const [docScans, setDocScans] = useState<any[]>([]);
  const [isCompilingPDF, setIsCompilingPDF] = useState(false);

  const [cameraRef, setCameraRef] = useState<CameraView | null>(null);
  const sessionGeoDataRef = useRef<any>(null);
  const [liveGeoData, setLiveGeoData] = useState<any>(null);
 
  const [captureQueue, setCaptureQueue] = useState<any[]>([]);
  const [captureTrigger, setCaptureTrigger] = useState(0);
  const viewShotRef = useRef<ViewShot>(null);

  const getBaseDirectory = () => `${FileSystem.documentDirectory}projects/${activeUserId}/${folderName}/`;
 
  const CAMERA_HEIGHT = aspectRatio === '4:3' ? SCREEN_WIDTH * (4 / 3) : SCREEN_WIDTH * (16 / 9);
  const cameraTopEdge = (SCREEN_HEIGHT - CAMERA_HEIGHT) / 2;
  const topButtonPosition = Math.max(40, cameraTopEdge + 20);

  const severityOptions = [
    { level: 1, label: 'High', color: '#EF4444' },
    { level: 2, label: 'Medium', color: '#F59E0B' },
    { level: 3, label: 'Low', color: '#10B981' },
  ];

  useEffect(() => {
    getActiveUserId().then(uid => setActiveUserId(uid));
    return () => {
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!showLiveCamera) return;
    const subscription = Accelerometer.addListener(({ x, y }) => {
        if (Math.abs(x) > Math.abs(y)) {
            setDeviceOrientation(x > 0 ? -90 : 90);
        } else {
            setDeviceOrientation(y > 0 ? 0 : 180);
        }
    });
    Accelerometer.setUpdateInterval(300);
    return () => subscription.remove();
  }, [showLiveCamera]);

  useEffect(() => { scanExistingVisits(); }, [activeUserId, folderName]);
  useEffect(() => { if (activeVisit) updateFileStats(); }, [activeVisit]);

  useEffect(() => {
    let interval: any;
    if (isRecordingState && !isRecordingPaused) {
      interval = setInterval(() => {
        setRecordTime(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecordingState, isRecordingPaused]);



  const extractCleanAddress = (addr: any) => {
    const street = addr.street || addr.name || '';
    const district = addr.district || addr.subregion || '';
    const city = addr.city || '';
    const postalCode = addr.postalCode || '';
    
    const parts = [street, district, city, postalCode].map(p => String(p).trim()).filter(p => p.length > 0);
    return [...new Set(parts)].join(', ') || 'Unknown Location';
  };

  useEffect(() => {
    let sub: Location.LocationSubscription;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        sub = await Location.watchPositionAsync({
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 5000, 
            distanceInterval: 0
        },
        async (loc) => {
          try {
            const geocode = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
            const addr = geocode[0] || {};
            
            const detailedAddress = extractCleanAddress(addr);

            const newData = { lat: loc.coords.latitude.toFixed(6), lon: loc.coords.longitude.toFixed(6), timestamp: formatGeoDate(new Date(loc.timestamp)), address: detailedAddress, city: addr.city || addr.subregion || 'Unknown City', region: addr.region || 'Unknown Region', country: addr.country || 'India' };
            sessionGeoDataRef.current = newData;
            setLiveGeoData(newData);
          } catch (e) {}
        });
      }
    })();
    return () => { if (sub) sub.remove(); }
  }, []);

  useEffect(() => {
    let intervalId: any;
    if (showLiveCamera) {
      const forceFetchLocation = async () => {
        try {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          const geocode = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
          const addr = geocode[0] || {};
          
          const detailedAddress = extractCleanAddress(addr);

          const newData = { 
            lat: loc.coords.latitude.toFixed(6), 
            lon: loc.coords.longitude.toFixed(6), 
            timestamp: formatGeoDate(new Date(loc.timestamp)), 
            address: detailedAddress, 
            city: addr.city || addr.subregion || 'Unknown City', 
            region: addr.region || 'Unknown Region', 
            country: addr.country || 'India' 
          };
          sessionGeoDataRef.current = newData;
          setLiveGeoData(newData);
        } catch (e) {}
      };
      forceFetchLocation(); 
      intervalId = setInterval(forceFetchLocation, 8000); 
    }
    return () => {
       if (intervalId) clearInterval(intervalId);
    };
  }, [showLiveCamera]);

  useEffect(() => {
    if (captureTrigger > 0 && captureQueue.length > 0 && viewShotRef.current) {
      setTimeout(async () => {
        try {
          const stampedUri = await viewShotRef.current?.capture?.();
          if (stampedUri) {
             const targetDir = await ensureSubfolder('Geotag Captures');
             const d = new Date(captureQueue[0].id);
             const p = (n: number) => n.toString().padStart(2, '0');
             const dtStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
             await FileSystem.copyAsync({ from: stampedUri, to: `${targetDir}Img_Geo_${dtStr}.jpg` });
             updateFileStats(true);
          }
        } catch (e) {} finally {
          setCaptureQueue(q => q.slice(1));
          setCaptureTrigger(0);
        }
      }, 250); 
    }
  }, [captureTrigger, captureQueue]);

  const resetZoomTimer = () => {
    if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
    zoomTimeoutRef.current = setTimeout(() => setShowZoom(false), 3000);
  };

  const handleZoomTap = () => {
    const now = Date.now();
    if (now - lastZoomTap.current < 300) {
      setZoomIndex(0); 
      setShowZoom(false);
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
    } else {
      if (showZoom) {
          setShowZoom(false);
          if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
      } else {
          setShowZoom(true);
          resetZoomTimer();
      }
    }
    lastZoomTap.current = now;
  };

  const changeZoom = (delta: number) => {
    setZoomIndex(z => Math.max(0, Math.min(ZOOM_STEPS.length - 1, z + delta)));
    resetZoomTimer();
  };

  const handleImagePreviewDoubleTap = () => {};

  const scanExistingVisits = async () => {
    if (activeUserId === 'AnonymousUser') return;
    try {
      const baseUri = getBaseDirectory();
      const dirInfo = await FileSystem.getInfoAsync(baseUri);
      if (dirInfo.exists) {
        const files = await FileSystem.readDirectoryAsync(baseUri);
        const visitDirs = files.filter(f => f.startsWith('VISIT_')).sort();
        setVisits(visitDirs);
        if (visitDirs.length > 0) setActiveVisit(visitDirs[visitDirs.length - 1]);
        
        // Scan for previous trimester media
        const prev = previousQuarter();
        const prevTrimester = `${prev.year}-Q${prev.q}`;
        const prevToPrev = previousQuarter(prev.q, prev.year);
        const prevToPrevTrimester = `${prevToPrev.year}-Q${prevToPrev.q}`;
        
        let foundPrev: string | null = null;
        let foundTrimStr = prevTrimester;

        for (let i = visitDirs.length - 1; i >= 0; i--) {
            const v = visitDirs[i];
            const match = v.match(/_(\d{8})_/);
            if (match && getQuarterFromYYYYMMDD(match[1]) === prevTrimester) {
                foundPrev = v;
                foundTrimStr = prevTrimester;
                break;
            }
        }

        if (!foundPrev) {
            for (let i = visitDirs.length - 1; i >= 0; i--) {
                const v = visitDirs[i];
                const match = v.match(/_(\d{8})_/);
                if (match && getQuarterFromYYYYMMDD(match[1]) === prevToPrevTrimester) {
                    foundPrev = v;
                    foundTrimStr = prevToPrevTrimester;
                    break;
                }
            }
        }
        
        if (foundPrev) {
            const match = foundPrev.match(/_(\d{8})_/);
            let dateFormatted = foundPrev;
            if (match && match[1].length === 8) {
               const d = match[1];
               dateFormatted = `${d.substring(6, 8)}-${d.substring(4, 6)}-${d.substring(0, 4)}`;
            }
            const qPart = foundTrimStr.split('-')[1] || foundTrimStr;
            setPrevTrimesterName(`Last Visit (${dateFormatted}) [${qPart}]`);
            let prevMedia: any[] = [];
            const mediaFolders = ['Images', 'Geotag Captures'];
            for (const f of mediaFolders) {
                const path = `${baseUri}${foundPrev}/${f}`;
                const info = await FileSystem.getInfoAsync(path);
                if (info.exists) {
                    const items = await FileSystem.readDirectoryAsync(path);
                    for (const item of items) {
                        if (getFileType(item) === 'image') {
                            prevMedia.push({ name: item, folder: f, uri: `${path}/${item}` });
                        }
                    }
                }
            }
            setPrevTrimesterMedia(prevMedia);
        } else {
            setPrevTrimesterMedia([]);
            setPrevTrimesterName(null);
        }
      }
    } catch (e) {}
  };

  const getPrevQuarterStr = () => {
    const prev = previousQuarter();
    return `${prev.year}-Q${prev.q}`;
  };


  const checkAndCreateVisit = async () => {
    const currentQuarterStr = getQuarterStr();
    if (visits.length > 0) {
        const latest = visits[visits.length - 1];
        const match = latest.match(/_(\d{8})_/);
        if (match) {
            const lastDateStr = match[1];
            if (getQuarterFromYYYYMMDD(lastDateStr) === getQuarterStr()) {
                Alert.alert("Visit Limit Reached", "You've already created a visit report for the current quarter. Only one visit is allowed per quarter.");
                return;
            }
        }
    }
    Alert.alert("Site Verification", "Are you on the Project Site?\n\nPress OK to create visit reports.", [
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
      
      // Mark dashboard dirty so it re-scans when navigated back to
      setDashboardDirty(true);
      
      setTimeout(() => { handlePinGeotag(true, true, newVisitName); }, 5000);
    } catch (e) {}
  };

  const ensureSubfolder = async (subfolder: string, specificVisit?: string | null) => {
    const visitTarget = specificVisit || activeVisit;
    if (!visitTarget) throw new Error("No active visit session");
    const folderUri = `${getBaseDirectory()}${visitTarget}/${subfolder}/`;
    const dirInfo = await FileSystem.getInfoAsync(folderUri);
    if (!dirInfo.exists) await FileSystem.makeDirectoryAsync(folderUri, { intermediates: true });
    return folderUri;
  };

  const updateFileStats = async (isMutation = false) => {
    try {
      const visitUri = `${getBaseDirectory()}${activeVisit}/`;
      const checkFolders = ['Notes', 'Comments', 'Attachments', 'Geotag Captures', 'Location Pins', 'Documents', 'Normal Captures'];
      let stats: Record<string, number> = { comments: 0, audio: 0, documents: 0, photos: 0, videos: 0, geotagged_photos: 0, location: 0, scanned_docs: 0, total: 0 };
      
      for (const folder of checkFolders) {
        const fUri = `${visitUri}${folder}/`;
        const info = await FileSystem.getInfoAsync(fUri);
        if (info.exists) {
          const files = await FileSystem.readDirectoryAsync(fUri);
          files.forEach(f => {
             if (!f.endsWith('.json')) {
                const ext = f.split('.').pop()?.toLowerCase();
                let cat = 'documents';
                if (folder === 'Notes' || folder === 'Comments') {
                    if (f.startsWith('Field_Review_')) cat = 'documents';
                    else cat = ext === 'txt' ? 'comments' : 'audio';
                }
                else if (folder === 'Geotag Captures') cat = 'geotagged_photos';
                else if (folder === 'Location Pins') cat = 'location';
                else if (folder === 'Documents') cat = 'scanned_docs';
                else if (folder === 'Normal Captures') cat = ['mp4','mov'].includes(ext!) ? 'videos' : 'photos';
                else if (folder === 'Attachments') cat = 'documents';
                
                stats[cat] = (stats[cat] || 0) + 1;
                stats.total++;
             }
          });
        }
      }
      setFileStats(stats);
      if (stats.total > 0 && isMutation && onEdit) onEdit();
    } catch (e) {}
  };

  const getTodayYYYYMMDD = () => {
    const d = new Date();
    const p = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  };

  const handleOpenReview = async () => {
    try {
      const targetDir = await ensureSubfolder('Notes');
      const files = await FileSystem.readDirectoryAsync(targetDir);
      const todayStr = getTodayYYYYMMDD();
      
      const existingReview = files.find(f => f.startsWith('Field_Review_') && f.includes(`_${todayStr}_`));

      const openModal = async (reviewFile?: string) => {
        if (reviewFile) {
          const content = await FileSystem.readAsStringAsync(`${targetDir}${reviewFile}`);
          const severityMatch = content.match(/SEVERITY STATUS:\s*(.+)/);
          const qualityMatch = content.match(/1\. QUALITY:\s*(.+)/);
          const timeMatch = content.match(/2\. TIME LIMIT:\s*(.+)/);
          const outputMatch = content.match(/3\. OUTPUT:\s*(.+)/);
  
          if (severityMatch) {
              const sevLabel = severityMatch[1].trim();
              const matchedSev = severityOptions.find(opt => opt.label.toUpperCase() === sevLabel.toUpperCase());
              setReviewSeverity(matchedSev || null);
          }
          setReviewParams({
              quality: qualityMatch ? qualityMatch[1].trim() : 'Not Evaluated',
              timeLimit: timeMatch ? timeMatch[1].trim() : 'On Schedule',
              output: outputMatch ? outputMatch[1].trim() : 'Standard'
          });
          
          setExistingReviewPath(`${targetDir}${reviewFile}`);
        } else {
          setReviewSeverity(null);
          setReviewParams({ quality: 'Not Evaluated', timeLimit: 'On Schedule', output: 'Standard' });
          setExistingReviewPath(null);
        }
        setShowReviewModal(true);
      };

      if (existingReview) {
        Alert.alert('Edit Mode', 'A field review already exists for today. Do you want to open and modify it?', [
          { text: "Cancel", style: "cancel" },
          { text: "OK", onPress: () => openModal(existingReview) }
        ]);
      } else {
        openModal();
      }
    } catch (e) {
      setReviewSeverity(null);
      setReviewParams({ quality: 'Not Evaluated', timeLimit: 'On Schedule', output: 'Standard' });
      setExistingReviewPath(null);
      setShowReviewModal(true);
    }
  };

  const startRecording = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (perm.status !== 'granted') return Alert.alert("Permission Denied");

      await setAudioModeAsync({ 
          allowsRecording: true, 
          playsInSilentMode: true,
      });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setRecordTime(0); setIsRecordingPaused(false); setIsRecordingState(true);
    } catch (err) {}
  };

  const stopRecording = async () => {
    if (!isRecordingState) return;
    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      setIsRecordingState(false); setRecordTime(0); setIsRecordingPaused(false);
      if (uri) {
        const targetDir = await ensureSubfolder('Notes');
        const d = new Date();
        const p = (n: number) => n.toString().padStart(2, '0');
        const dtStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
        const num = fileStats.audio + 1;
        await FileSystem.copyAsync({ from: uri, to: `${targetDir}Voice_Memo_${num}_${dtStr}.m4a` });
        updateFileStats(true);
      }
    } catch (err) {}
  };

  const renderRecordingUI = (isFloating: boolean = false) => {
    if (!isRecordingState) return null;
    return (
      <View style={[styles.recordingUIBox, isFloating && { position: 'absolute', bottom: 40, left: 20, right: 20, zIndex: 9999, elevation: 100, backgroundColor: '#FFF', shadowColor: '#000', shadowOffset: {width:0, height:4}, shadowOpacity: 0.15, shadowRadius: 10 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={styles.redDot} />
          <Text style={styles.recordingTime}>{formatTime(recordTime)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
           <TouchableOpacity style={[styles.recordControlBtn, { backgroundColor: '#EFF6FF', marginRight: 10 }]} onPress={() => {
              if (isRecordingPaused) {
                 audioRecorder.record();
                 setIsRecordingPaused(false);
              } else {
                 audioRecorder.pause();
                 setIsRecordingPaused(true);
              }
           }}>
              <Ionicons name={isRecordingPaused ? "play" : "pause"} size={20} color="#2563EB" />
           </TouchableOpacity>
           <TouchableOpacity style={[styles.recordControlBtn, { backgroundColor: '#FEE2E2' }]} onPress={stopRecording}>
             <Ionicons name="square" size={20} color="#EF4444" />
             <Text style={{color: '#EF4444', fontWeight: 'bold', marginLeft: 6}}>Stop & Save</Text>
           </TouchableOpacity>
        </View>
      </View>
    );
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
      const targetDir = await ensureSubfolder('Notes');
      const d = new Date();
      const p = (n: number) => n.toString().padStart(2, '0');
      const dtStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
      
      const existingFiles = await FileSystem.readDirectoryAsync(targetDir).catch(() => []);
      const commentFilesCount = existingFiles.filter(f => f.startsWith('Comments_')).length;
      const num = commentFilesCount + 1;

      await FileSystem.writeAsStringAsync(`${targetDir}Comments_${num}_${dtStr}.txt`, commentText);
      setCommentText(''); setShowCommentModal(false); updateFileStats(true);
    } catch (e) {}
  };

  const handleGenerateFieldReport = async () => {
    if (!reviewSeverity) {
      Alert.alert("Input Required", "Please select a severity level.");
      return;
    }

    const timestamp = new Date().toLocaleString();
    const d = new Date();
    const p = (n: number) => n.toString().padStart(2, '0');
    const todayStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    const timeStr = `${p(d.getHours())}${p(d.getMinutes())}`;

    const content = `SITE VISIT REPORT: ${projectId}
--------------------------------------
DATE/TIME: ${timestamp}
SEVERITY STATUS: ${reviewSeverity.label.toUpperCase()}
--------------------------------------
FIELD PARAMETERS:
1. QUALITY: ${reviewParams.quality}
2. TIME LIMIT: ${reviewParams.timeLimit}
3. OUTPUT: ${reviewParams.output}
--------------------------------------
Generated by Project Manager`;

    try {
      const targetDir = await ensureSubfolder('Notes');
      
      if (existingReviewPath) {
          await FileSystem.deleteAsync(existingReviewPath, { idempotent: true });
      }

      const path = `${targetDir}Field_Review_${todayStr}_${timeStr}.txt`;
      await FileSystem.writeAsStringAsync(path, content, { encoding: FileSystem.EncodingType.UTF8 });
      Alert.alert("Report Saved", "Field visit review has been documented in the Notes folder.");
      
      setShowReviewModal(false);
      setExistingReviewPath(null);
      updateFileStats(true);
    } catch (err) {
      Alert.alert("Error", "Could not save the field report.");
    }
  };

  const handleAttachFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ 
          type: ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'], 
          copyToCacheDirectory: false, 
          multiple: true 
      });
      if (result.canceled || !result.assets?.length) return;
      const targetDir = await ensureSubfolder('Attachments');
      for (const asset of result.assets) {
         const cleanName = asset.name.replace(/[^a-zA-Z0-9.-]/g, '_');
         await FileSystem.copyAsync({ from: asset.uri, to: `${targetDir}${cleanName}` });
      }
      updateFileStats(true);
    } catch (e) {}
  };

  const openLiveCamera = async (isScanner: boolean = false) => {
    try {
      if (!camPerm?.granted) {
        const res = await reqCamPerm();
        if (!res.granted) return Alert.alert("Camera Permission Denied");
      }
      setFlashMode('auto');
      setZoomIndex(0);

      setIsDocScannerMode(isScanner);
      setDocScans([]);
      setShowLiveCamera(true);
    } catch (e) {}
  };

  const handleTapToFocus = (event: any) => {
      const { locationX, locationY } = event.nativeEvent;
      setFocusPoint({ x: locationX, y: locationY });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setTimeout(() => setFocusPoint(null), 1500); 
  };

  const captureLiveMedia = async () => {
    if (!cameraRef || isCapturing) return;
    try {
      setIsCapturing(true);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const photo = await cameraRef.takePictureAsync({ quality: isDocScannerMode ? 0.4 : 0.85 });
      
      if (photo) {
        if (isDocScannerMode) {
          setDocScans(prev => [...prev, { uri: photo.uri, orientation: deviceOrientation }]);
        } else {
          const currentGeo = liveGeoData || sessionGeoDataRef.current || { lat: "0.000000", lon: "0.000000", address: "", city: "", region: "", country: "" };
          const safeGeoData = { ...currentGeo, timestamp: formatGeoDate(new Date()) };
          
          setCaptureQueue(q => [...q, { 
              id: Date.now(), 
              uri: photo.uri, 
              geoData: safeGeoData, 
              orientation: deviceOrientation,
              aspectRatio,
              photoWidth: photo.width,
              photoHeight: photo.height
          }]);
         
          const targetDir = await ensureSubfolder('Location Pins');
          const files = await FileSystem.readDirectoryAsync(targetDir).catch(() => []);
          if (files.length === 0) {
             handlePinGeotag(true, true);
          }
        }
      }
    } catch (e) {
    } finally {
      setTimeout(() => setIsCapturing(false), 300);
    }
  };

  const handleFinishDocScanning = async () => {
    if (docScans.length === 0) {
      setShowLiveCamera(false);
      return;
    }
    
    setIsCompilingPDF(true);
    try {
      const imgTags = [];
      for (let i = 0; i < docScans.length; i++) {
          const scan = docScans[i];
          
          const isLandscapeIntended = scan.orientation === 90 || scan.orientation === -90;
          
          const initialManip = await ImageManipulator.manipulateAsync(scan.uri, []);
          const isPhysicallyLandscape = initialManip.width > initialManip.height;

          let actions = [];
          
          if (isLandscapeIntended !== isPhysicallyLandscape) {
              const correctionAngle = scan.orientation ? -scan.orientation : 90;
              actions.push({ rotate: correctionAngle });
          }
          
          actions.push({ resize: { width: 1600 } });

          const finalManip = await ImageManipulator.manipulateAsync(
              scan.uri,
              actions,
              { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );
          
          const pageClass = isLandscapeIntended ? 'page-landscape' : 'page-portrait';

          imgTags.push(`
            <div class="${pageClass}">
              <img src="data:image/jpeg;base64,${finalManip.base64}" />
            </div>
          `);
      }
      
      const htmlContent = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <style>
        html, body { margin: 0; padding: 0; background: #FFF; }
        
        @page portrait_layout { size: 210mm 297mm; margin: 0; }
        @page landscape_layout { size: 297mm 210mm; margin: 0; }
        
        .page-portrait {
            page: portrait_layout;
            width: 210mm; height: 297mm;
            display: flex; justify-content: center; align-items: center;
            page-break-after: always; overflow: hidden; box-sizing: border-box;
        }
        .page-landscape {
            page: landscape_layout;
            width: 297mm; height: 210mm;
            display: flex; justify-content: center; align-items: center;
            page-break-after: always; overflow: hidden; box-sizing: border-box;
        }
        img {
            max-width: 100%; max-height: 100%; object-fit: contain;
        }
      </style>
      </head><body style="margin: 0; padding: 0; background: #FFF;">${imgTags.join('')}</body></html>`;
      
      const { uri } = await Print.printToFileAsync({ html: htmlContent, base64: false });
      
      const targetDir = await ensureSubfolder('Documents');
      const d = new Date();
      const p = (n: number) => n.toString().padStart(2, '0');
      const dtStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      
      await FileSystem.copyAsync({ from: uri, to: `${targetDir}Scanned_Document_${dtStr}.pdf` });
      
      updateFileStats(true);
      setShowLiveCamera(false);
    } catch(e) {
      Alert.alert("PDF Generation Failed", "Could not compile the scanned images into a document. Try scanning fewer pages at once.");
    } finally {
      setIsCompilingPDF(false);
    }
  };

  const handleCloseLiveCamera = () => {
    if (isDocScannerMode && docScans.length > 0) {
      Alert.alert(
        "Unsaved Scans",
        "You have scanned documents that haven't been saved. Do you want to save them as a PDF?",
        [
          { text: "Discard", style: "destructive", onPress: () => setShowLiveCamera(false) },
          { text: "Cancel", style: "cancel" },
          { text: "Save PDF", onPress: () => handleFinishDocScanning() }
        ]
      );
    } else {
      setShowLiveCamera(false);
    }
  };

  const cycleFlashMode = () => setFlashMode(f => f === 'auto' ? 'off' : f === 'off' ? 'on' : 'auto');

  const handleCaptureNormalMedia = async (mediaType: 'photo' | 'video') => {
    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: mediaType === 'video' ? ['videos'] : ['images'],
        allowsEditing: false,
        quality: 0.85 
      });
      if (result.canceled || !result.assets?.length) return;
      const targetDir = await ensureSubfolder('Normal Captures');
      const prefix = mediaType === 'video' ? 'vid_' : 'img_';
      const ext = mediaType === 'video' ? 'mp4' : 'jpg';
      
      const d = new Date();
      const p = (n: number) => n.toString().padStart(2, '0');
      const dtStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      
      await FileSystem.copyAsync({ from: result.assets[0].uri, to: `${targetDir}${prefix}${dtStr}.${ext}` });
      updateFileStats(true);
    } catch (e) {}
  };

  const handlePinGeotag = async (silent = false, isAuto = false, targetVisit: string | null = null) => {
    const activeDir = targetVisit || activeVisit;
    if (!activeDir) return;

    const doGeotag = async (replace = false) => {
      try {
        const targetDir = await ensureSubfolder('Location Pins', activeDir);
        if (replace) {
          const files = await FileSystem.readDirectoryAsync(targetDir).catch(() => []);
          const kmlFiles = files.filter(f => f.endsWith('.kml'));
          if (kmlFiles.length > 0) await FileSystem.deleteAsync(`${targetDir}${kmlFiles.sort().reverse()[0]}`).catch(() => {});
        }
        
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') { if (!silent) Alert.alert("Location Denied"); return; }
        
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const lat = loc.coords.latitude.toFixed(6);
        const lon = loc.coords.longitude.toFixed(6);
        
        const kmlData = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Placemark>\n    <name>Project Geotag</name>\n    <Point>\n      <coordinates>${lon},${lat},0</coordinates>\n    </Point>\n  </Placemark>\n</kml>`;
        await FileSystem.writeAsStringAsync(`${targetDir}pin_${projectId}_${tenderId}_${lat}_${lon}.kml`, kmlData);
        updateFileStats(true);
      } catch (err) {
        if (!silent) Alert.alert("Error", "Could not fetch GPS.");
      }
    };

    if (isAuto) {
      doGeotag(false);
    } else {
      const targetDir = await ensureSubfolder('Location Pins', activeDir);
      const files = await FileSystem.readDirectoryAsync(targetDir).catch(() => []);
      if (files.some(f => f.endsWith('.kml'))) {
        Alert.alert("Location Pin", "Adding location pin of this place.", [
          { text: "Cancel", style: "cancel" },
          { text: "Replace Latest Pin", onPress: () => doGeotag(true) },
          { text: "Add New Pin", onPress: () => doGeotag(false) }
        ]);
      } else {
        Alert.alert("Fetching Location", "Capturing the location and saving as a KML file in the background.", [
            { text: "OK", onPress: () => doGeotag(false) }
        ]);
      }
    }
  };

  const refreshFilesExplorer = async () => {
    try {
      const visitUri = `${getBaseDirectory()}${activeVisit}/`;
      const info = await FileSystem.getInfoAsync(visitUri);
      if (!info.exists) { setSavedFiles([]); setTotalSessionSize(0); return; }
      
      let allFiles: any[] = []; let totalSize = 0;
      const checkFolders = ['Notes', 'Attachments', 'Geotag Captures', 'Location Pins', 'Documents', 'Normal Captures'];
      
      for (const folder of checkFolders) {
        const subUri = `${visitUri}${folder}/`;
        const subInfo = await FileSystem.getInfoAsync(subUri);
        if (subInfo.exists && subInfo.isDirectory) {
          const files = await FileSystem.readDirectoryAsync(subUri);
          for(const f of files) {
             if(!f.endsWith('.json')) {
                const fileStat = await FileSystem.getInfoAsync(`${subUri}${f}`);
                if (fileStat.exists && !fileStat.isDirectory) {
                  allFiles.push({ name: f, folder, time: fileStat.modificationTime || 0, size: fileStat.size || 0, uri: `${subUri}${f}` });
                  totalSize += fileStat.size || 0;
                }
             }
          }
        }
      }
      setSavedFiles(allFiles); setTotalSessionSize(totalSize);
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

  const deleteFile = (folder: string, name: string) => {
    if (folder === 'Location Pins' || name.endsWith('.kml')) {
       Alert.alert("Protected File", "Location pins cannot be deleted manually as they are required for project tracking.");
       return;
    }

    Alert.alert("Confirm Delete", `Delete ${name}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
          try {
            const uri = `${getBaseDirectory()}${activeVisit}/${folder}/${name}`;
            await FileSystem.deleteAsync(uri, { idempotent: true });
            if (folder === 'Geotag Captures') {
               const baseName = name.substring(0, name.lastIndexOf('.'));
               const jsonUri = `${getBaseDirectory()}${activeVisit}/${folder}/${baseName}.json`;
               await FileSystem.deleteAsync(jsonUri, { idempotent: true }).catch(()=>{});
            }
            await refreshFilesExplorer(); updateFileStats(true);
          } catch (e) {}
        }}
    ]);
  };

  const getFileType = (name: string) => {
      const ext = name.split('.').pop()?.toLowerCase() || '';
      if (ext === 'kml') return 'kml';
      if (['txt', 'csv', 'json'].includes(ext)) return 'text';
      if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
      if (['mp4', 'mov'].includes(ext)) return 'video';
      if (['m4a', 'mp3', 'wav'].includes(ext)) return 'audio';
      return 'doc';
  };

  const triggerPreview = async (index: number) => {
      const file = displayFiles[index];
      const type = getFileType(file.name);
      
      if (type === 'kml') {
         setPreviewFileContent(null);
      } else if (type === 'doc') {
          if (Platform.OS === 'android') {
             try {
                const IntentLauncher = require('expo-intent-launcher');
                const cUri = await FileSystem.getContentUriAsync(file.uri);
                await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
                    data: cUri,
                    flags: 1, 
                    type: 'application/pdf'
                });
                return;
             } catch(e) {
                await Sharing.shareAsync(file.uri, { UTI: 'com.adobe.pdf', mimeType: 'application/pdf' });
             }
          } else {
             await Sharing.shareAsync(file.uri, { UTI: 'com.adobe.pdf', mimeType: 'application/pdf' });
          }
          return;
      } else if (type === 'text') {
          const content = await FileSystem.readAsStringAsync(file.uri);
          setPreviewFileContent(content);
      } else {
          setPreviewFileContent(null);
      }
      
      setPreviewIndex(index);
      setImagePreviewZoom(1); 
  };

  const getNextMediaIndex = (currentIndex: number) => {
      for (let i = currentIndex + 1; i < displayFiles.length; i++) {
          const type = getFileType(displayFiles[i].name);
          if (type === 'image' || type === 'video') return i;
      }
      return null;
  };

  const getPrevMediaIndex = (currentIndex: number) => {
      for (let i = currentIndex - 1; i >= 0; i--) {
          const type = getFileType(displayFiles[i].name);
          if (type === 'image' || type === 'video') return i;
      }
      return null;
  };

  const currentPreviewFile = previewIndex !== null ? displayFiles[previewIndex] : null;
  const currentPreviewType = currentPreviewFile ? getFileType(currentPreviewFile.name) : null;
  const nextMediaIdx = previewIndex !== null ? getNextMediaIndex(previewIndex) : null;
  const prevMediaIdx = previewIndex !== null ? getPrevMediaIndex(previewIndex) : null;

  const isLandscapeMode = deviceOrientation === 90 || deviceOrientation === -90;
  const overlayContainerWidth = isLandscapeMode ? CAMERA_HEIGHT : SCREEN_WIDTH;
  const overlayContainerHeight = isLandscapeMode ? SCREEN_WIDTH : CAMERA_HEIGHT;
  
  const displayAspectRatio = aspectRatio === '4:3' 
    ? (isLandscapeMode ? '4:3' : '3:4') 
    : (isLandscapeMode ? '16:9' : '9:16');

  return (
    <View style={[globalStyles.card, { padding: 16, marginBottom: 10, paddingBottom: 16 }]}>
      <View style={{ marginBottom: 15 }}>
         <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#EFF6FF', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, marginBottom: 15, borderWidth: 1, borderColor: '#BFDBFE' }}>
           <Ionicons name="folder-open" size={20} color="#2563EB" style={{ marginRight: 8 }} />
           <Text style={{ color: '#1E3A8A', fontWeight: '900', fontSize: 16, textTransform: 'uppercase', letterSpacing: 0.5 }}>Visit Reports</Text>
         </View>
         <View style={styles.visitControls}>
           <TouchableOpacity style={styles.visitBtnLight} onPress={() => setShowVisitModal(true)}>
             <Ionicons name="list" size={16} color="#334155" style={{ marginRight: 6 }} /><Text style={{ color: '#334155', fontWeight: 'bold', fontSize: 13 }}>Select From Visits</Text>
           </TouchableOpacity>
           <TouchableOpacity style={styles.visitBtnDark} onPress={checkAndCreateVisit}>
             <Ionicons name="add-circle" size={16} color="#FFF" style={{ marginRight: 6 }} /><Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 13 }}>Create New Visit</Text>
           </TouchableOpacity>
         </View>
      </View>

      {prevTrimesterMedia.length > 0 && (
        <View style={{ marginBottom: 20 }}>
          <Text style={[styles.visitSectionHeader, { textAlign: 'left', marginBottom: 8, color: '#2563EB' }]}>{prevTrimesterName}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 5, gap: 10 }}>
            {prevTrimesterMedia.map((m, i) => (
              <TouchableOpacity key={i} onPress={async () => {
                  try {
                      const IntentLauncher = require('expo-intent-launcher');
                      const cUri = await FileSystem.getContentUriAsync(m.uri);
                      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: cUri, flags: 1, type: 'image/*' });
                  } catch(e) {
                      await Sharing.shareAsync(m.uri);
                  }
              }}>
                <Image source={{ uri: m.uri }} style={{ width: 80, height: 80, borderRadius: 8, backgroundColor: '#E2E8F0', borderWidth: 1, borderColor: '#CBD5E1' }} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {activeVisit ? (
        <View>
          <View style={styles.activeVisitBox}>
            <Ionicons name="checkmark-circle" size={24} color="#15803D" style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.activeVisitLabel}>Selected Visit</Text>
              <Text style={styles.activeVisitText} numberOfLines={1}>{activeVisit}</Text>
            </View>
          </View>
        </View>
      ) : <Text style={styles.noVisitText}>Select or Create a visit report session to unlock media buttons.</Text>}

      {renderRecordingUI()}

      {activeVisit && (
        <TouchableOpacity 
          style={[styles.visitBtnDark, { backgroundColor: '#0F172A', marginBottom: 15 }]} 
          onPress={handleOpenReview}
        >
          <Ionicons name="star" size={18} color="#F59E0B" style={{ marginRight: 8 }} />
          <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 14 }}>Rate / Review Site</Text>
        </TouchableOpacity>
      )}

      {/* UPDATED: Structured grid UI with perfectly aligned rows */}
      <View style={[!activeVisit && { opacity: 0.3 }]} pointerEvents={!activeVisit ? 'none' : 'auto'}>
        {/* ROW 1 */}
        <View style={styles.actionRow}>
          <ActionButton icon={isRecordingState ? "stop-circle" : "mic"} label={isRecordingState ? "Recording..." : "Voice Note"} color={isRecordingState ? "#EF4444" : "#EA580C"} onPress={() => isRecordingState ? stopRecording() : startRecording()} />
          <ActionButton icon="chatbubble-ellipses" label="Text Comment" color="#059669" onPress={() => setShowCommentModal(true)} />
          <ActionButton icon="location" label="Pin Geotag" color="#0891B2" onPress={() => handlePinGeotag(false)} disabled={isRecordingState} />
        </View>

        {/* ROW 2 */}
        <View style={styles.actionRow}>
          {/* <ActionButton icon="camera-outline" label="Normal Photo" color="#2563EB" onPress={() => handleCaptureNormalMedia('photo')} disabled={isRecordingState} /> */}
          <ActionButton icon="videocam-outline" label="Normal Video" color="#DB2777" onPress={() => handleCaptureNormalMedia('video')} disabled={isRecordingState} />
          <ActionButton icon="camera-outline" label="Geotag Photo" color="#0284C7" onPress={() => openLiveCamera(false)} disabled={isRecordingState} />
          <ActionButton icon="document-text" label="Scan Document" color="#CA8A04" onPress={() => openLiveCamera(true)} disabled={isRecordingState} />
        </View>

        {/* ROW 3: Center Aligned */}
        <View style={[styles.actionRow, { justifyContent: 'center' }]}>
          <ActionButton icon="attach" label="Attach Files" color="#7C3AED" onPress={handleAttachFile} style={{ marginRight: '4%' }} />
          <ActionButton icon="folder-open" label="Show Files" color="#475569" onPress={() => { refreshFilesExplorer(); setShowFilesModal(true); }} />
        </View>
      </View>

      {activeVisit && fileStats.total > 0 && (
        <View style={[styles.statsContainer, { alignItems: 'center', marginTop: 15 }]}>
          <Text style={styles.statsTitle}>Saved Files: {fileStats.total}</Text>
          <View style={styles.statsRow}>
            {Object.entries(fileStats).map(([key, count]) => {
              if (key === 'total' || count === 0) return null;
              return <View key={key} style={styles.statBadge}><Text style={styles.statBadgeText}>{count} {key.replace('_', ' ')}</Text></View>;
            })}
          </View>
        </View>
      )}

      {/* UPDATED: onRequestClose added to all Modals to intercept Android Hardware Back Button */}
      <Modal visible={showLiveCamera} transparent animationType="none" onRequestClose={handleCloseLiveCamera}>
         <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' }}>
            {renderRecordingUI(true)}
            
            {captureQueue.length > 0 && (
              <View style={{ position: 'absolute', top: 0, left: 0, zIndex: -1, elevation: -1, opacity: 0.01 }} pointerEvents="none" collapsable={false}>
                {(() => {
                   const item = captureQueue[0];
                   const isLandscape = item.orientation === 90 || item.orientation === -90;
                   const is43 = item.aspectRatio === '4:3';
                   
                   const shotW = isLandscape ? (is43 ? 1440 : 1920) : 1080;
                   const shotH = isLandscape ? 1080 : (is43 ? 1440 : 1920);
                   
                   const scaleRatio = shotW / Math.min(SCREEN_WIDTH, SCREEN_HEIGHT);

                   return (
                      <ViewShot ref={viewShotRef} options={{ format: 'jpg', quality: 0.9 }} style={{ width: shotW, height: shotH, backgroundColor: '#000' }}>
                        <Image source={{ uri: item.uri }} style={{ width: '100%', height: '100%', resizeMode: 'cover' }} onLoad={() => setCaptureTrigger(Date.now())} />
                        
                        <View style={{ position: 'absolute', bottom: 4 * scaleRatio, left: 0, right: 0, alignItems: 'center' }} collapsable={false}>
                           <GPSCameraOverlay geoData={item.geoData} sizeRatio={scaleRatio} isLandscape={isLandscape} />
                        </View>
                      </ViewShot>
                   );
                })()}
              </View>
            )}

            <View style={{ flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
               <View style={{ width: SCREEN_WIDTH, height: CAMERA_HEIGHT, overflow: 'hidden' }}>
                 {!isDocScannerMode && (!liveGeoData || liveGeoData.lat === "0.000000") && (
                   <View style={styles.gpsWaitingOverlay}>
                     <ActivityIndicator size="large" color="#FFF" />
                     <Text style={{color:'#FFF', marginTop: 10, fontWeight: 'bold'}}>Waiting for GPS signals...</Text>
                   </View>
                 )}

                 <TouchableWithoutFeedback onPress={handleTapToFocus}>
                    <View style={{ width: '100%', height: '100%' }}>
                       <CameraView ref={setCameraRef} style={{ width: '100%', height: '100%' }} zoom={ZOOM_STEPS[zoomIndex]} mode="picture" facing={cameraFacing} flash={flashMode === 'auto' ? 'auto' : flashMode === 'on' ? 'on' : 'off'} ratio={aspectRatio} />
                       {focusPoint && (
                          <View style={{ position: 'absolute', top: focusPoint.y - 30, left: focusPoint.x - 30, width: 60, height: 60, borderWidth: 2, borderColor: '#F59E0B', borderRadius: 4 }} />
                       )}
                    </View>
                 </TouchableWithoutFeedback>

                 {!isDocScannerMode && liveGeoData && (
                   <View style={{ 
                      position: 'absolute', 
                      width: overlayContainerWidth, 
                      height: overlayContainerHeight, 
                      top: (CAMERA_HEIGHT - overlayContainerHeight) / 2, 
                      left: (SCREEN_WIDTH - overlayContainerWidth) / 2, 
                      justifyContent: 'flex-end', 
                      alignItems: 'center', 
                      paddingBottom: 4, 
                      transform: [{ rotate: `${-deviceOrientation}deg` }], 
                      pointerEvents: 'none' 
                   }}>
                      <GPSCameraOverlay geoData={liveGeoData} sizeRatio={1} isLandscape={isLandscapeMode} />
                   </View>
                 )}
               </View>
            </View>

            <View style={{ position: 'absolute', top: topButtonPosition, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start', gap: 20, zIndex: 30 }} pointerEvents="box-none">
               <TouchableOpacity onPress={() => setAspectRatio(a => a === '16:9' ? '4:3' : '16:9')} style={styles.cameraTopBtn}>
                 <Ionicons name="expand" size={24} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
                 <Text style={[styles.cameraTopBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>{displayAspectRatio}</Text>
               </TouchableOpacity>

               <View style={{ alignItems: 'center' }} pointerEvents="box-none">
                  <TouchableOpacity onPress={handleZoomTap} style={[styles.cameraTopBtn, showZoom && { backgroundColor: 'rgba(255,255,255,0.3)' }]}>
                     <Ionicons name="search" size={24} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
                     <Text style={[styles.cameraTopBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>{ZOOM_LABELS[zoomIndex]}</Text>
                  </TouchableOpacity>
                  {showZoom && (
                     <View style={styles.zoomControls}>
                        <TouchableOpacity onPress={() => changeZoom(-1)} style={styles.zoomBtnIndividual}>
                           <Text style={[styles.zoomBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>-</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => changeZoom(1)} style={styles.zoomBtnIndividual}>
                           <Text style={[styles.zoomBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>+</Text>
                        </TouchableOpacity>
                     </View>
                  )}
               </View>

               <TouchableOpacity onPress={cycleFlashMode} style={styles.cameraTopBtn}>
                 <Ionicons name={flashMode === 'on' ? "flash" : flashMode === 'auto' ? "flash-outline" : "flash-off"} size={24} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
                 <Text style={[styles.cameraTopBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>{flashMode}</Text>
               </TouchableOpacity>
            </View>

            <View style={styles.cameraControlsContainer} pointerEvents="box-none">
               <TouchableOpacity disabled={isCapturing || isCompilingPDF} onPress={handleCloseLiveCamera} style={[styles.cameraSideBtn, (isCapturing || isCompilingPDF) && { opacity: 0.5 }]}>
                 <Ionicons name="close" size={36} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
               </TouchableOpacity>
               
               <View style={{alignItems: 'center'}} pointerEvents="box-none">
                   <TouchableOpacity onPress={captureLiveMedia} disabled={isCapturing} style={[styles.cameraCaptureBtnOuter, isCapturing && { borderColor: '#94A3B8' }]}>
                     <View style={[styles.cameraCaptureBtnInner, isCapturing && { backgroundColor: '#E2E8F0' }]} />
                   </TouchableOpacity>
                   {isDocScannerMode && <Text style={{color: '#FFF', marginTop: 10, fontWeight: 'bold'}}>Scans: {docScans.length}</Text>}
               </View>
               
               {isDocScannerMode && docScans.length > 0 ? (
                 <TouchableOpacity onPress={handleFinishDocScanning} disabled={isCompilingPDF || isCapturing} style={[styles.cameraSideBtn, {backgroundColor: '#2563EB', width: 'auto', paddingHorizontal: 15, opacity: (isCompilingPDF || isCapturing) ? 0.5 : 1}]}>
                   {isCompilingPDF ? <ActivityIndicator color="#FFF" /> : <Text style={{color: '#FFF', fontWeight: 'bold'}}>Save PDF ({docScans.length})</Text>}
                 </TouchableOpacity>
               ) : (
                 <TouchableOpacity onPress={() => setCameraFacing(f => f === 'back' ? 'front' : 'back')} style={styles.cameraSideBtn}>
                   <Ionicons name="camera-reverse" size={28} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
                 </TouchableOpacity>
               )}
            </View>
            
            {captureQueue.length > 0 && (
               <View style={styles.photoQueueToast}>
                 <ActivityIndicator size="small" color="#FFF" style={{marginRight: 8}}/>
                 <Text style={{color: '#FFF', fontWeight: 'bold'}}>Saving {captureQueue.length} photo(s)...</Text>
               </View>
            )}
         </View>
      </Modal>

      <Modal visible={showVisitModal} transparent animationType="fade" onRequestClose={() => setShowVisitModal(false)}>
        <TouchableWithoutFeedback onPress={() => setShowVisitModal(false)}>
          <View style={styles.modalOverlay}>
            {renderRecordingUI(true)}
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

      <Modal visible={showReviewModal} transparent animationType="slide" onRequestClose={() => setShowReviewModal(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.modalOverlay, { backgroundColor: '#F8FAFC' }]}>
          {renderRecordingUI(true)}
          <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}>
            <View style={[styles.modalContent, { paddingBottom: 30, backgroundColor: '#F8FAFC', paddingTop: 20 }]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Field Visit Review</Text>
                <TouchableOpacity onPress={() => setShowReviewModal(false)}><Ionicons name="close" size={24} color="#64748B" /></TouchableOpacity>
              </View>
              
              <View style={{ padding: 20 }}>
                <Text style={styles.reviewLabel}>Select Severity Mode:</Text>
                <View style={styles.reviewRow}>
                  {severityOptions.map((opt) => (
                    <TouchableOpacity
                      key={opt.level}
                      style={[styles.sevBtn, { backgroundColor: reviewSeverity?.level === opt.level ? opt.color : '#E2E8F0' }]}
                      onPress={() => setReviewSeverity(opt)}
                    >
                      <Text style={[styles.sevBtnText, { color: reviewSeverity?.level === opt.level ? '#FFF' : '#475569' }]}>{opt.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.reviewLabel}>Construction Quality:</Text>
                <View style={styles.reviewRow}>
                  {['Poor', 'Average', 'Excellent'].map(q => (
                    <TouchableOpacity key={q} style={[styles.paramBtn, reviewParams.quality === q && styles.activeParam]} onPress={() => setReviewParams({...reviewParams, quality: q})}>
                      <Text style={[styles.paramBtnText, reviewParams.quality === q && styles.activeParamText]}>{q}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.reviewLabel}>Timeline Adherence:</Text>
                <View style={styles.reviewRow}>
                  {['Delayed', 'On Time'].map(t => (
                    <TouchableOpacity key={t} style={[styles.paramBtn, reviewParams.timeLimit === t && styles.activeParam]} onPress={() => setReviewParams({...reviewParams, timeLimit: t})}>
                      <Text style={[styles.paramBtnText, reviewParams.timeLimit === t && styles.activeParamText]}>{t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.reviewLabel}>Project Output:</Text>
                <View style={styles.reviewRow}>
                  {['Poor', 'Standard', 'Targeted'].map(o => (
                    <TouchableOpacity key={o} style={[styles.paramBtn, reviewParams.output === o && styles.activeParam]} onPress={() => setReviewParams({...reviewParams, output: o})}>
                      <Text style={[styles.paramBtnText, reviewParams.output === o && styles.activeParamText]}>{o}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity style={[globalStyles.primaryBtn, { marginTop: 25, backgroundColor: '#0F172A' }]} onPress={handleGenerateFieldReport}>
                  <Text style={globalStyles.primaryBtnText}>{existingReviewPath ? 'Update Existing Report' : 'Export Report (.txt)'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={showCommentModal} transparent animationType="slide" onRequestClose={() => setShowCommentModal(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.modalOverlay, { backgroundColor: '#F1F5F9' }]}>
          {renderRecordingUI(true)}
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
              <TextInput ref={commentInputRef} style={[globalStyles.input, { height: 120, textAlignVertical: 'top' }]} multiline placeholder="Write observation..." value={commentText} onChangeText={setCommentText} autoFocus />
              <TouchableOpacity style={globalStyles.primaryBtn} onPress={handleSaveComment}>
                <Text style={globalStyles.primaryBtnText}>Save Comment</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={showFilesModal} transparent animationType="fade" onRequestClose={() => setShowFilesModal(false)}>
        <TouchableWithoutFeedback onPress={() => setShowFilesModal(false)}>
          <View style={styles.modalOverlay}>
            {renderRecordingUI(true)}
            <TouchableWithoutFeedback>
              <View style={[styles.modalContent, { maxHeight: '85%' }]}>
                <View style={styles.modalHeader}>
                  <Text style={[styles.modalTitle, {flex: 1}]} numberOfLines={1}>{isSelectionMode ? `${selectedFiles.size} Selected` : `Files (${formatBytes(totalSessionSize)})`}</Text>
                  <View style={{flexDirection: 'row', alignItems: 'center'}}>
                    {isSelectionMode ? (
                        <>
                           <TouchableOpacity onPress={async () => {
                               if (selectedFiles.size === 0) return;
                               const urls = Array.from(selectedFiles);
                               if (urls.length === 1) {
                                  await Sharing.shareAsync(urls[0]);
                               } else {
                                  // Multiple share - iOS supports this natively with urls array. Android may require a zipped bundle or multiple calls depending on library limits. Expo sharing usually supports single URL.
                                  // To support multiple, we might need to share one by one or create a zip. But for simplicity let's try sharing the first or alerting.
                                  if (Platform.OS === 'ios') {
                                       await Sharing.shareAsync(urls[0]); // Actually expo-sharing only supports single file. Let's just share the first or alert if >1. 
                                  } else {
                                      Alert.alert("Notice", "Multiple file sharing is restricted by OS. Sharing first selected file.", [
                                          { text: "OK", onPress: () => Sharing.shareAsync(urls[0]) }
                                      ]);
                                  }
                               }
                           }} style={{marginRight: 15, padding: 4}}>
                               <Ionicons name="share-social" size={24} color="#2563EB" />
                           </TouchableOpacity>
                           <TouchableOpacity onPress={() => setIsSelectionMode(false)} style={{marginRight: 15, padding: 4}}>
                               <Ionicons name="close-circle" size={24} color="#EF4444" />
                           </TouchableOpacity>
                        </>
                    ) : (
                        <>
                            <TouchableOpacity onPress={() => { setIsSelectionMode(true); setSelectedFiles(new Set()); }} style={{marginRight: 15, padding: 4}}>
                                <Ionicons name="checkbox-outline" size={24} color="#2563EB" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setIsGridView(!isGridView)} style={{marginRight: 15, padding: 4}}>
                                <Ionicons name={isGridView ? 'list' : 'grid'} size={24} color="#2563EB" />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setShowFilesModal(false)} style={{padding: 4}}>
                                <Ionicons name="close" size={24} color="#64748B" />
                            </TouchableOpacity>
                        </>
                    )}
                  </View>
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
                  key={isGridView ? 'G' : 'L'}
                  data={displayFiles}
                  keyExtractor={(item, idx) => `${item.folder}_${idx}`}
                  numColumns={isGridView ? 2 : 1}
                  columnWrapperStyle={isGridView ? styles.gridRow : undefined}
                  contentContainerStyle={isGridView ? styles.gridContainer : undefined}
                  renderItem={({ item, index }) => {
                    const type = getFileType(item.name);
                    const isImage = type === 'image';
                    const isVideo = type === 'video';

                    if (isGridView) {
                      return (
                        <View style={[styles.gridCardContainer, { width: (SCREEN_WIDTH - 60) / 2 }]}>
                          <TouchableOpacity style={[styles.gridDeleteBtn, { right: 38, backgroundColor: 'rgba(255,255,255,0.9)' }]} onPress={() => Sharing.shareAsync(item.uri)}>
                            <Ionicons name="share-social" size={18} color="#2563EB" />
                          </TouchableOpacity>
                          <TouchableOpacity style={styles.gridDeleteBtn} onPress={() => deleteFile(item.folder, item.name)}>
                            <Ionicons name="trash-outline" size={18} color="#EF4444" />
                          </TouchableOpacity>
                          
                          {isSelectionMode && (
                             <TouchableOpacity style={{ position: 'absolute', top: 6, left: 6, zIndex: 10 }} onPress={() => {
                                 const next = new Set(selectedFiles);
                                 if (next.has(item.uri)) next.delete(item.uri); else next.add(item.uri);
                                 setSelectedFiles(next);
                             }}>
                                 <Ionicons name={selectedFiles.has(item.uri) ? "checkbox" : "square-outline"} size={22} color={selectedFiles.has(item.uri) ? "#2563EB" : "#FFF"} style={{ backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 11 }} />
                             </TouchableOpacity>
                          )}

                          <TouchableOpacity 
                            style={{ flex: 1, width: '100%' }}
                            activeOpacity={0.7}
                            onPress={() => {
                              if (isSelectionMode) {
                                  const next = new Set(selectedFiles);
                                  if (next.has(item.uri)) next.delete(item.uri); else next.add(item.uri);
                                  setSelectedFiles(next);
                              } else {
                                  triggerPreview(index);
                              }
                            }}
                          >
                            <View style={styles.gridIconContainer}>
                              {isImage ? (
                                <Image source={{ uri: item.uri }} style={[styles.gridThumbnail, selectedFiles.has(item.uri) && { opacity: 0.7 }]} />
                              ) : isVideo ? (
                                <View style={styles.gridThumbnailPlaceholder}>
                                  <Ionicons name="videocam" size={32} color="#FFF" />
                                </View>
                              ) : (
                                <Ionicons name={type === 'kml' ? 'map' : type === 'audio' ? 'musical-notes' : 'document-text'} size={36} color="#3B82F6" />
                              )}
                            </View>

                            <View style={styles.gridInfoContainer}>
                              <Text numberOfLines={1} style={styles.gridFileName}>{item.name}</Text>
                              <Text numberOfLines={1} style={styles.gridFolderName}>/{item.folder}</Text>
                              <Text style={styles.gridFileSize}>{formatBytes(item.size)}</Text>
                            </View>
                          </TouchableOpacity>
                        </View>
                      );
                    }

                    return (
                      <View style={styles.fileItemRow}>
                        {isSelectionMode && (
                           <TouchableOpacity style={{ marginRight: 15 }} onPress={() => {
                               const next = new Set(selectedFiles);
                               if (next.has(item.uri)) next.delete(item.uri); else next.add(item.uri);
                               setSelectedFiles(next);
                           }}>
                               <Ionicons name={selectedFiles.has(item.uri) ? "checkbox" : "square-outline"} size={24} color={selectedFiles.has(item.uri) ? "#2563EB" : "#94A3B8"} />
                           </TouchableOpacity>
                        )}
                        <TouchableOpacity style={styles.fileItemContent} onPress={() => {
                              if (isSelectionMode) {
                                  const next = new Set(selectedFiles);
                                  if (next.has(item.uri)) next.delete(item.uri); else next.add(item.uri);
                                  setSelectedFiles(next);
                              } else {
                                  triggerPreview(index);
                              }
                        }}>
                          {isImage ? (
                            <Image source={{ uri: item.uri }} style={styles.listThumbnail} />
                          ) : isVideo ? (
                            <View style={[styles.listThumbnail, {justifyContent: 'center', alignItems: 'center'}]}>
                              <Ionicons name="videocam" size={20} color="#94A3B8" />
                            </View>
                          ) : (
                            <Ionicons name={type === 'kml' ? 'map' : type === 'audio' ? 'musical-notes' : 'document-text'} size={24} color="#2563EB" style={{marginRight: 15}} />
                          )}
                          <View style={{ flex: 1 }}>
                            <Text style={styles.fileItemName} numberOfLines={1}>{item.name}</Text>
                            <Text style={styles.fileItemFolder}>{`/${item.folder}`}</Text>
                          </View>
                          <Text style={styles.fileItemSize}>{formatBytes(item.size)}</Text>
                        </TouchableOpacity>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                          <TouchableOpacity onPress={() => Sharing.shareAsync(item.uri)} style={[styles.deleteFileBtn, { backgroundColor: '#EFF6FF', marginRight: 8 }]}>
                            <Ionicons name="share-social" size={20} color="#2563EB" />
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => deleteFile(item.folder, item.name)} style={styles.deleteFileBtn}>
                            <Ionicons name="trash" size={20} color="#EF4444" />
                          </TouchableOpacity>
                        </View>
                      </View>
                    );
                  }}
                  ListEmptyComponent={<Text style={{ padding: 20, textAlign: 'center', color: '#94A3B8' }}>No files match criteria.</Text>}
                />
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      <Modal visible={previewIndex !== null} transparent animationType="slide" onRequestClose={() => setPreviewIndex(null)}>
        <View style={styles.previewOverlay}>
          {renderRecordingUI(true)}
          {currentPreviewType !== 'image' && (
            <View style={styles.previewHeader}>
              <Text style={styles.previewTitle} numberOfLines={1}>{currentPreviewFile?.name}</Text>
              {currentPreviewFile && (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <TouchableOpacity onPress={async () => {
                          try {
                              await Sharing.shareAsync(currentPreviewFile.uri);
                          } catch(e) {}
                      }} style={{ padding: 5, marginRight: 15 }}><Ionicons name="share-social" size={24} color="#FFF" /></TouchableOpacity>
                      <TouchableOpacity onPress={() => {
                          deleteFile(currentPreviewFile.folder, currentPreviewFile.name);
                          setPreviewIndex(null);
                      }} style={{ padding: 5, marginRight: 15 }}><Ionicons name="trash" size={24} color="#EF4444" /></TouchableOpacity>
                  </View>
              )}
              <TouchableOpacity onPress={() => setPreviewIndex(null)} style={{ padding: 5 }}><Ionicons name="close" size={28} color="#FFF" /></TouchableOpacity>
            </View>
          )}
          
          <View style={styles.previewContainer}>
            {prevMediaIdx !== null && imagePreviewZoom === 1 && (
                <TouchableOpacity style={styles.swipeLeftBtn} onPress={() => triggerPreview(prevMediaIdx)}>
                    <Ionicons name="chevron-back" size={24} color="#FFF" />
                </TouchableOpacity>
            )}

            {currentPreviewType === 'text' && <ScrollView style={styles.previewTextWrapper}><Text style={styles.previewText}>{previewFileContent}</Text></ScrollView>}
            
            {currentPreviewType === 'image' && (() => {
               const images = displayFiles.filter(f => getFileType(f.name) === 'image');
               const startIdx = Math.max(0, images.findIndex(f => f.uri === currentPreviewFile?.uri));
               return (
                 <View style={{ flex: 1, width: '100%', height: '100%', backgroundColor: '#000' }}>
                   <ImageViewer 
                       imageUrls={images.map(img => ({ url: img.uri }))}
                       index={startIdx}
                       enableSwipeDown
                       onSwipeDown={() => setPreviewIndex(null)}
                       renderHeader={(currIdx) => (
                           <View style={{ position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 50, zIndex: 100, backgroundColor: 'rgba(0,0,0,0.5)' }}>
                               <Text style={{ color: '#FFF', fontSize: 16, fontWeight: 'bold', flex: 1, marginRight: 15 }} numberOfLines={1}>{images[currIdx || 0]?.name}</Text>
                               <TouchableOpacity onPress={async () => {
                                   try {
                                       await Sharing.shareAsync(images[currIdx || 0].uri);
                                   } catch(e) {}
                               }} style={{ padding: 5, marginRight: 15 }}><Ionicons name="share-social" size={24} color="#FFF" /></TouchableOpacity>
                               <TouchableOpacity onPress={() => {
                                   const img = images[currIdx || 0];
                                   if (img) {
                                       deleteFile(img.folder, img.name);
                                       setPreviewIndex(null);
                                   }
                               }} style={{ padding: 5, marginRight: 15 }}><Ionicons name="trash" size={24} color="#EF4444" /></TouchableOpacity>
                               <TouchableOpacity onPress={() => setPreviewIndex(null)} style={{ padding: 5 }}><Ionicons name="close" size={28} color="#FFF" /></TouchableOpacity>
                           </View>
                       )}
                   />
                 </View>
               );
            })()}
            
            {currentPreviewType === 'video' && <VideoPreview uri={currentPreviewFile?.uri!} />}
            {currentPreviewType === 'audio' && <AudioPreview uri={currentPreviewFile?.uri!} />}
            
            {currentPreviewType === 'kml' && (
                <View style={{ alignItems: 'center', padding: 30, backgroundColor: '#FFF', borderRadius: 16 }}>
                    <Ionicons name="map" size={80} color="#10B981" style={{ marginBottom: 20 }} />
                    <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginBottom: 20, textAlign: 'center' }}>{currentPreviewFile?.name}</Text>
                    <TouchableOpacity style={[globalStyles.primaryBtn, { minWidth: 200 }]} onPress={async () => {
                        try {
                            const content = await FileSystem.readAsStringAsync(currentPreviewFile!.uri);
                            const coordMatch = content.match(/<coordinates>([^,]+),([^,]+)/);
                            if (coordMatch) Linking.openURL(`https://maps.google.com/?daddr=${coordMatch[2]},${coordMatch[1]}`);
                            else Alert.alert("Error", "Could not read GPS location from this file.");
                        } catch (e) {
                            Alert.alert("Error", "Could not read GPS location from this file.");
                        }
                    }}>
                        <Text style={globalStyles.primaryBtnText}>Get Directions</Text>
                    </TouchableOpacity>
                </View>
            )}

            {nextMediaIdx !== null && imagePreviewZoom === 1 && (
                <TouchableOpacity style={styles.swipeRightBtn} onPress={() => triggerPreview(nextMediaIdx)}>
                    <Ionicons name="chevron-forward" size={24} color="#FFF" />
                </TouchableOpacity>
            )}
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

const GPSCameraOverlay = ({ geoData, sizeRatio = 1, isLandscape = false }: { geoData: any, sizeRatio?: number, isLandscape?: boolean }) => {
  const [liveTime, setLiveTime] = useState(geoData.timestamp);
 
  useEffect(() => {
     const interval = setInterval(() => setLiveTime(formatGeoDate(new Date())), 1000);
     return () => clearInterval(interval);
  }, []);

  const displayTime = geoData.timestamp === liveTime ? liveTime : geoData.timestamp;

  const mapUrl = GOOGLE_MAPS_API_KEY
    ? `https://maps.googleapis.com/maps/api/staticmap?center=${geoData.lat},${geoData.lon}&zoom=18&size=300x200&scale=2&markers=color:red%7C${geoData.lat},${geoData.lon}&key=${GOOGLE_MAPS_API_KEY}`
    : `https://staticmap.openstreetmap.de/staticmap.php?center=${geoData.lat},${geoData.lon}&zoom=18&size=300x200&maptype=mapnik&markers=${geoData.lat},${geoData.lon},red-pushpin&t=${Date.now()}`;
 
  return (
    <View style={{ flexDirection: 'row', alignItems: 'stretch', alignSelf: 'center', maxWidth: '95%' }} collapsable={false}>
      <View style={{ width: 85 * sizeRatio, borderRadius: 6 * sizeRatio, overflow: 'hidden', marginRight: 6 * sizeRatio, backgroundColor: '#E2E8F0', flexShrink: 0 }} collapsable={false}>
         {geoData.lat === "0.000000" ? <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}><Ionicons name="map" size={24 * sizeRatio} color="#94A3B8" /></View> : <Image source={{ uri: mapUrl }} style={{ flex: 1, width: '100%', height: '100%', resizeMode: 'contain' }} />}
      </View>

      <View style={{ flexShrink: 1, backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 6 * sizeRatio, paddingVertical: 4 * sizeRatio, borderRadius: 6 * sizeRatio, justifyContent: 'center' }} collapsable={false}>
         <Text style={{ color: '#FFF', fontSize: 11 * sizeRatio, fontWeight: 'bold', lineHeight: 13 * sizeRatio, letterSpacing: isLandscape ? 0.3 : 0, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2, padding: 0 }} numberOfLines={1}>{geoData.city}, {geoData.region}, India 🇮🇳</Text>
         <Text style={{ color: '#E2E8F0', fontSize: 10 * sizeRatio, lineHeight: 12 * sizeRatio, letterSpacing: isLandscape ? 0.2 : 0, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2, padding: 0 }} numberOfLines={2}>{geoData.address}</Text>
         <Text style={{ color: '#F8FAFC', fontSize: 9 * sizeRatio, fontWeight: 'bold', lineHeight: 11 * sizeRatio, letterSpacing: isLandscape ? 0.2 : 0, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2, padding: 0 }}>Lat {geoData.lat}° Long {geoData.lon}°</Text>
         <Text style={{ color: '#F8FAFC', fontSize: 9 * sizeRatio, lineHeight: 11 * sizeRatio, letterSpacing: isLandscape ? 0.2 : 0, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2, padding: 0 }}>{displayTime}</Text>
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
  visitBtnLight: { backgroundColor: '#F1F5F9', paddingVertical: 12, borderRadius: 8, flex: 1, marginRight: 5, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  visitBtnDark: { backgroundColor: '#2563EB', paddingVertical: 12, borderRadius: 8, flex: 1, marginLeft: 5, flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  activeVisitBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#DCFCE7', padding: 15, borderRadius: 10, marginBottom: 15, borderWidth: 1, borderColor: '#BBF7D0' },
  activeVisitLabel: { fontSize: 12, color: '#166534', fontWeight: 'bold', textTransform: 'uppercase' },
  activeVisitText: { fontSize: 14, color: '#14532D', fontWeight: '800', marginTop: 2 },
  noVisitText: { textAlign: 'center', color: '#64748B', fontStyle: 'italic', marginBottom: 15 },
  statsContainer: { backgroundColor: '#F8FAFC', padding: 15, borderRadius: 10, marginBottom: 15, borderWidth: 1, borderColor: '#E2E8F0' },
  statsTitle: { fontSize: 13, fontWeight: 'bold', color: '#475569', marginBottom: 10, textAlign: 'center' },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  statBadge: { backgroundColor: '#EFF6FF', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#BFDBFE' },
  statBadgeText: { fontSize: 11, color: '#2563EB', fontWeight: '700', textTransform: 'capitalize' },
  recordingUIBox: { backgroundColor: '#FFF', padding: 15, borderRadius: 12, marginBottom: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: '#EF4444' },
  recordingTime: { fontSize: 18, fontWeight: 'bold', color: '#EF4444', marginLeft: 10 },
  redDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#EF4444' },
  recordControlBtn: { paddingHorizontal: 15, paddingVertical: 10, borderRadius: 8, flexDirection: 'row', alignItems: 'center' },
  
  // Grid Action Buttons UI Update
  actionRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12, width: '100%' },
  actionBtn: { width: '31%', aspectRatio: 1, backgroundColor: '#FFF', paddingHorizontal: 5, borderRadius: 12, alignItems: 'center', justifyContent: 'center', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 3, borderWidth: 1, borderColor: '#E2E8F0' },
  
  actionIconWrap: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  actionLabel: { fontSize: 11, fontWeight: '700', color: '#475569', textAlign: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  modalItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  modalItemText: { fontSize: 15, color: '#475569' },
  modalItemSelected: { backgroundColor: '#EFF6FF' },
  commentToolbar: { flexDirection: 'row', marginBottom: 10, borderBottomWidth: 1, borderColor: '#E2E8F0', paddingBottom: 10 },
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EFF6FF', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, marginRight: 10 },
  toolbarBtnText: { color: '#2563EB', fontWeight: 'bold', fontSize: 12, marginLeft: 4 },
  filterControls: { flexDirection: 'row', padding: 15, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  controlChip: { paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: '#E2E8F0', marginRight: 10 },
  controlChipText: { fontSize: 12, fontWeight: 'bold', color: '#475569' },
  
  // Base List Styles
  fileItemRow: { flexDirection: 'row', alignItems: 'center', padding: 15, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  fileItemContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  fileItemName: { fontSize: 14, fontWeight: '600', color: '#1E293B', marginBottom: 2 },
  fileItemFolder: { fontSize: 11, color: '#64748B', fontWeight: '600' },
  fileItemSize: { fontSize: 12, color: '#94A3B8', fontWeight: '600', marginLeft: 10 },
  listThumbnail: { width: 40, height: 40, borderRadius: 6, marginRight: 15, resizeMode: 'cover', backgroundColor: '#E2E8F0' },
  deleteFileBtn: { padding: 10, marginLeft: 5 },

  // Grid Styles
  gridContainer: { paddingHorizontal: 20, paddingBottom: 20, paddingTop: 10 },
  gridRow: { flex: 1, justifyContent: 'space-between', marginBottom: 15 },
  gridCardContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    position: 'relative',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  gridDeleteBtn: { position: 'absolute', top: 6, right: 6, zIndex: 10, backgroundColor: 'rgba(255, 255, 255, 0.9)', borderRadius: 12, padding: 4 },
  gridIconContainer: { alignItems: 'center', justifyContent: 'center', height: 80, marginBottom: 10, borderRadius: 8, overflow: 'hidden', backgroundColor: '#F1F5F9' },
  gridThumbnail: { width: '100%', height: '100%', resizeMode: 'cover' },
  gridThumbnailPlaceholder: { width: '100%', height: '100%', backgroundColor: '#94A3B8', justifyContent: 'center', alignItems: 'center' },
  gridInfoContainer: { alignItems: 'flex-start', width: '100%' },
  gridFileName: { fontSize: 13, fontWeight: '600', color: '#1E293B', marginBottom: 2, width: '100%' },
  gridFolderName: { fontSize: 11, color: '#64748B', marginBottom: 4 },
  gridFileSize: { fontSize: 11, fontWeight: '500', color: '#94A3B8' },

  previewOverlay: { flex: 1, backgroundColor: '#000' },
  previewHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 50, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 10 },
  previewTitle: { color: '#FFF', fontSize: 16, fontWeight: 'bold', flex: 1, marginRight: 15 },
  previewContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  swipeLeftBtn: { position: 'absolute', left: 15, top: '50%', zIndex: 50, padding: 8, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20 },
  swipeRightBtn: { position: 'absolute', right: 15, top: '50%', zIndex: 50, padding: 8, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20 },
  previewTextWrapper: { flex: 1, width: '100%', padding: 20, backgroundColor: '#FFF' },
  previewText: { fontSize: 16, color: '#334155', lineHeight: 24 },
  videoWrapper: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  audioTextLabel: { color: '#FFF', fontSize: 18, fontWeight: 'bold', marginBottom: 20 },
  audioProgressContainer: { width: '80%', height: 6, backgroundColor: '#334155', borderRadius: 3, overflow: 'hidden' },
  audioProgressBarBg: { flex: 1, backgroundColor: '#475569' },
  audioProgressBarFill: { height: '100%', backgroundColor: '#2563EB' },
  cameraTopBtn: { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, alignItems: 'center', justifyContent: 'center', minWidth: 60 },
  cameraTopBtnText: { color: '#FFF', fontSize: 12, fontWeight: 'bold', marginTop: 4 },
  zoomControls: { position: 'absolute', top: 65, flexDirection: 'row', alignItems: 'center', gap: 15 },
  zoomBtnIndividual: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
  zoomBtnText: { color: '#FFF', fontSize: 24, fontWeight: 'bold' },
  cameraControlsContainer: { position: 'absolute', bottom: 40, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 30, zIndex: 50 },
  cameraSideBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  cameraCaptureBtnOuter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  cameraCaptureBtnInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#FFF' },
  photoQueueToast: { position: 'absolute', top: 120, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.8)', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, zIndex: 100 },
  reviewLabel: { fontSize: 14, fontWeight: '700', color: '#1E293B', marginTop: 15, marginBottom: 10 },
  reviewRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  sevBtn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sevBtnText: { fontWeight: 'bold', fontSize: 13 },
  paramBtn: { flex: 1, paddingVertical: 10, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 6, alignItems: 'center', backgroundColor: '#FFF' },
  paramBtnText: { color: '#475569', fontWeight: '600', fontSize: 12 },
  activeParam: { backgroundColor: '#EFF6FF', borderColor: '#2563EB' },
  activeParamText: { color: '#2563EB', fontWeight: 'bold' },
  gpsWaitingOverlay: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', zIndex: 10 }
});