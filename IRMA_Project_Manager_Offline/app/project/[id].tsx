import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Modal } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import JSZip from 'jszip'; 
import { Ionicons } from '@expo/vector-icons';
import VisitManager from '../../components/VisitManager';

const parseDateString = (dateStr: string) => {
  if (!dateStr) return 0;
  const parts = dateStr.split('-');
  if (parts.length === 3) return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])).getTime();
  return 0;
};

const safeDecode = (val: any): string => {
  if (!val || val === 'undefined' || val === 'null') return '';
  try { return decodeURIComponent(String(val)); } catch (e) { return String(val); }
};

const escapeSql = (str: string) => str.replace(/'/g, "''"); 

export default function ProjectDetails() {
  const params = useLocalSearchParams();
  const router = useRouter();
  
  const projectId = safeDecode(Array.isArray(params.id) ? params.id[0] : params.id);
  const tenderId = safeDecode(Array.isArray(params.tender_id) ? params.tender_id[0] : params.tender_id);
  
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [project, setProject] = useState<any>(null);
  
  const [latestObs, setLatestObs] = useState<any[]>([]);
  const [prevObs, setPrevObs] = useState<any[]>([]);
  const [showAllObs, setShowAllObs] = useState(false);
  const [isScopeExpanded, setIsScopeExpanded] = useState(false);

  // ZIP Progress & Concurrency State
  const [zipProgress, setZipProgress] = useState<number | null>(null);
  const [zipStatusText, setZipStatusText] = useState<string>('');
  const [isZippingBackground, setIsZippingBackground] = useState(false);
  const isExportingRef = useRef(false);
  const cancelZipRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let isMounted = true;
      if (!projectId || !tenderId) {
        setTimeout(() => { if (isMounted) setLoading(false); }, 500);
        return;
      }
      loadData(isMounted);
      return () => { isMounted = false; };
    }, [projectId, tenderId])
  );

  const loadData = async (isMounted: boolean) => {
    setLoading(true);
    setDbError(null);

    try {
      const db = SQLite.openDatabaseSync('civil_projects.db');
      const pIdEscaped = escapeSql(projectId);
      const tIdEscaped = escapeSql(tenderId);

      const query = `SELECT * FROM tenders WHERE project_id = '${pIdEscaped}' AND tender_id = '${tIdEscaped}'`;
      const projData = db.getFirstSync(query);
      
      if (!isMounted) return;
      if (!projData) { 
        setProject(null); 
        setLoading(false); 
        return; 
      }
      setProject(projData);

      const obsData = db.getAllSync(`SELECT * FROM observations WHERE project_code = '${pIdEscaped}'`) as any[];
      if (obsData && obsData.length > 0 && isMounted) {
        const sortedObs = [...obsData].sort((a: any, b: any) => parseDateString(b.visit_date) - parseDateString(a.visit_date));
        const newestTimestamp = parseDateString(sortedObs[0].visit_date);
        setLatestObs(sortedObs.filter((o: any) => parseDateString(o.visit_date) === newestTimestamp));
        setPrevObs(sortedObs.filter((o: any) => parseDateString(o.visit_date) !== newestTimestamp));
      }
    } catch (error: any) {
      if (isMounted) setDbError(`Database Interruption: ${error.message}`);
    } finally {
      if (isMounted) setLoading(false);
    }
  };

  const countFilesRecursive = async (folderPath: string): Promise<number> => {
    let count = 0;
    const files = await FileSystem.readDirectoryAsync(folderPath);
    for (const file of files) {
      const info = await FileSystem.getInfoAsync(`${folderPath}${file}`);
      if (info.isDirectory) count += await countFilesRecursive(`${folderPath}${file}/`);
      else count++;
    }
    return count;
  };

  // SMART ZIP CACHING & OOM PREVENTION
  const handleShareProjectZip = async () => {
    if (isExportingRef.current) {
      setIsZippingBackground(false);
      return;
    }

    try {
      const sanitizedFolder = `${projectId}_${tenderId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      const sourcePath = `${FileSystem.documentDirectory}projects/${sanitizedFolder}/`;
      const targetPath = `${FileSystem.cacheDirectory}${sanitizedFolder}.zip`;
      
      const dirInfo = await FileSystem.getInfoAsync(sourcePath);
      if (!dirInfo.exists) return Alert.alert("No Data", "No files to share for this project.");

      const totalFiles = await countFilesRecursive(sourcePath);
      if (totalFiles === 0) return Alert.alert("Empty Directory", "No files exist to be exported.");

      // Check Cache: Avoid duplicate processing if file counts match
      const metaCachePath = `${FileSystem.cacheDirectory}${sanitizedFolder}_meta.txt`;
      const zipInfo = await FileSystem.getInfoAsync(targetPath);
      const metaInfo = await FileSystem.getInfoAsync(metaCachePath);
      
      if (zipInfo.exists && metaInfo.exists) {
         const lastFileCount = await FileSystem.readAsStringAsync(metaCachePath);
         if (parseInt(lastFileCount) === totalFiles) {
            // Unchanged: Serve immediately
            return await Sharing.shareAsync(targetPath, { dialogTitle: `Share Project: ${projectId}` });
         }
      }

      isExportingRef.current = true;
      cancelZipRef.current = false;
      setIsZippingBackground(false);
      setZipProgress(0);
      setZipStatusText("Reading files...");
      
      const zip = new JSZip();
      const rootZipFolder = zip.folder(sanitizedFolder);
      if (!rootZipFolder) throw new Error("Could not create zip structure");
      
      let processedFiles = 0;

      const addFolderToZip = async (folderPath: string, currentZipFolder: JSZip) => {
        const files = await FileSystem.readDirectoryAsync(folderPath);
        for (let i = 0; i < files.length; i++) {
          if (cancelZipRef.current) break; 
          
          const file = files[i];
          const fullPath = `${folderPath}${file}`;
          const info = await FileSystem.getInfoAsync(fullPath);
          
          if (info.isDirectory) {
            const newZipFolder = currentZipFolder.folder(file);
            if (newZipFolder) await addFolderToZip(`${fullPath}/`, newZipFolder);
          } else {
            // Aggressive GC yield to prevent OutOfMemoryError on large datasets
            await new Promise(resolve => setTimeout(resolve, 25)); 
            const base64 = await FileSystem.readAsStringAsync(fullPath, { encoding: FileSystem.EncodingType.Base64 });
            currentZipFolder.file(file, base64, { base64: true });
            
            processedFiles++;
            setZipProgress(Math.floor((processedFiles / totalFiles) * 50)); 
          }
        }
      };

      await addFolderToZip(sourcePath, rootZipFolder);
      if (cancelZipRef.current) throw new Error("Cancelled");
      
      setZipStatusText("Packaging archive...");
      
      // STORE mode uses significantly less RAM than DEFLATE
      const zipBase64 = await zip.generateAsync({ type: 'base64', compression: 'STORE' }, (metadata) => {
        if (cancelZipRef.current) return;
        setZipProgress(50 + Math.floor(metadata.percent / 2));
      });
      
      if (cancelZipRef.current) throw new Error("Cancelled");

      setZipStatusText("Saving to disk...");
      await FileSystem.writeAsStringAsync(targetPath, zipBase64, { encoding: FileSystem.EncodingType.Base64 });
      await FileSystem.writeAsStringAsync(metaCachePath, totalFiles.toString()); // Cache the file count
      
      setZipProgress(null);
      isExportingRef.current = false;
      await Sharing.shareAsync(targetPath, { dialogTitle: `Share Project: ${projectId}` });
      
    } catch (e: any) {
      setZipProgress(null);
      isExportingRef.current = false;
      if (e.message !== "Cancelled") {
        Alert.alert("Export Error", "Failed to compress folder. Try exporting smaller batches.");
      }
    }
  };

  const handleCancelZip = () => {
    cancelZipRef.current = true;
    setZipProgress(null);
    setIsZippingBackground(false);
    isExportingRef.current = false;
  };

  if (loading) return <View style={styles.centerLoading}><ActivityIndicator size="large" color="#2563EB" /><Text style={{ marginTop: 10, color: '#64748B' }}>Fetching Project Details...</Text></View>;
  
  if (dbError || !project) return (
    <View style={styles.centerLoading}>
      <Ionicons name="warning" size={48} color="#EF4444" style={{ marginBottom: 10 }} />
      <Text style={styles.errorText}>{!project ? "Project Not Found" : "Connection Interrupted"}</Text>
      <Text style={{ marginTop: 5, color: '#64748B', textAlign: 'center', marginBottom: 20 }}>
        {!project ? `Failed to load details for ID: ${projectId || 'Missing'}\nEnsure the database is fully seeded.` : dbError}
      </Text>
      <TouchableOpacity onPress={() => loadData(true)} style={[styles.goBackBtn, { backgroundColor: '#10B981', marginBottom: 10 }]}>
        <Ionicons name="refresh" size={16} color="#FFF" style={{marginRight: 6}} />
        <Text style={{color: '#FFF', fontWeight: 'bold'}}>Retry Data Fetch</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => router.back()} style={[styles.goBackBtn, { backgroundColor: '#64748B' }]}>
        <Ionicons name="arrow-back" size={16} color="#FFF" style={{marginRight: 6}} />
        <Text style={{color: '#FFF', fontWeight: 'bold'}}>Return to Dashboard</Text>
      </TouchableOpacity>
    </View>
  );

  const displayedPrevObs = showAllObs ? prevObs : prevObs.slice(0, 5);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}><Ionicons name="arrow-back" size={24} color="#1E293B" /></TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{project.project_id}</Text>
          <Text style={styles.headerSub}>{project.ulb}, {project.state}</Text>
        </View>
        <TouchableOpacity onPress={handleShareProjectZip} style={styles.backBtn}>
          <Ionicons name="share-social" size={24} color="#2563EB" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 15, paddingBottom: 60 }}>
        <View style={styles.card}>
          <View style={styles.dataRow}>
            <View style={styles.dataColumn}><Text style={styles.dataLabel}>Project Type</Text><Text style={styles.dataValue}>{project.project_type || 'N/A'}</Text></View>
            <View style={styles.dataColumn}><Text style={styles.dataLabel}>Tender ID</Text><Text style={styles.dataValue}>{project.tender_id || 'N/A'}</Text></View>
          </View>
          <Text style={styles.projectTitle}>{project.project_title || 'Untitled Project'}</Text>
          <View style={styles.dataRow}>
            <View style={styles.dataColumn}><Text style={styles.dataLabel}>NIT Issued Date</Text><Text style={styles.dataValue}>{project.nit_date || 'N/A'}</Text></View>
            <View style={styles.dataColumn}><Text style={styles.dataLabel}>Contract Awarded</Text><Text style={styles.dataValue}>{project.award_date || 'N/A'}</Text></View>
          </View>
          <View style={styles.dataRow}>
            <View style={styles.dataColumn}><Text style={styles.dataLabel}>Bidder Name</Text><Text style={styles.dataValue} numberOfLines={2}>{project.bidder_name || 'N/A'}</Text></View>
            <View style={styles.dataColumn}><Text style={styles.dataLabel}>CAPEX</Text><Text style={styles.dataValue}>₹{project.capex || '0'} Cr</Text></View>
          </View>
          <View style={styles.dataRow}>
            <View style={styles.dataColumn}><Text style={styles.dataLabel}>Physical Progress</Text><Text style={[styles.dataValue, { color: '#16A34A', fontWeight: 'bold' }]}>{project.physical_progress || '0'}%</Text></View>
            <View style={styles.dataColumn}><Text style={styles.dataLabel}>Financial Progress</Text><Text style={[styles.dataValue, { color: '#2563EB', fontWeight: 'bold' }]}>{project.financial_progress || '0'}%</Text></View>
          </View>
          <View style={styles.scopeBox}>
            <Text style={[styles.dataLabel, { textAlign: 'center', marginBottom: 6 }]}>Brief Scope of Work</Text>
            <Text style={[styles.scopeText, { textAlign: 'center' }]} numberOfLines={isScopeExpanded ? undefined : 5}>{project.scope || 'No scope details available.'}</Text>
            {project.scope && project.scope.length > 100 && (
              <TouchableOpacity onPress={() => setIsScopeExpanded(!isScopeExpanded)} style={{ marginTop: 8 }}>
                <Text style={{ color: '#2563EB', fontSize: 12, fontWeight: '700' }}>{isScopeExpanded ? 'View Less' : 'View More'}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        <VisitManager projectId={projectId} tenderId={tenderId} />

        <Text style={[styles.sectionTitle, { textAlign: 'center', marginTop: 10 }]}>IRMA Observations</Text>
        {latestObs.length === 0 && prevObs.length === 0 ? (
          <View style={styles.card}><Text style={{color: '#64748B', textAlign: 'center', fontStyle: 'italic'}}>No IRMA review records exist for this project code.</Text></View>
        ) : (
          <View>
            {latestObs.length > 0 && (
              <View style={{ marginBottom: 15 }}>
                <Text style={[styles.subSectionTitle, { textAlign: 'center' }]}>Most Recent ({latestObs[0].visit_date})</Text>
                {latestObs.map((obs, idx) => <ObservationCard key={`latest_${idx}`} obs={obs} />)}
              </View>
            )}
            {prevObs.length > 0 && (
              <View>
                <Text style={[styles.subSectionTitle, { textAlign: 'center' }]}>Previous Observations</Text>
                {displayedPrevObs.map((obs, idx) => <ObservationCard key={`prev_${idx}`} obs={obs} />)}
                {prevObs.length > 5 && (
                  <TouchableOpacity onPress={() => setShowAllObs(!showAllObs)} style={styles.viewMoreBtn}>
                    <Text style={styles.viewMoreText}>{showAllObs ? 'View Less' : `View More Observations (${prevObs.length - 5})`}</Text>
                    <Ionicons name={showAllObs ? "chevron-up" : "chevron-down"} size={14} color="#2563EB" style={{marginLeft: 4}}/>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* ZIP PROGRESS MODAL */}
      {zipProgress !== null && !isZippingBackground && (
        <Modal transparent animationType="fade">
          <View style={styles.zipOverlay}>
            <View style={styles.zipCard}>
              <ActivityIndicator size="large" color="#2563EB" />
              <Text style={styles.zipTitle}>Exporting Project</Text>
              <Text style={styles.zipStatus}>{zipStatusText}</Text>
              
              <View style={styles.zipProgressBarBg}>
                 <View style={[styles.zipProgressBarFill, { width: `${zipProgress}%` }]} />
              </View>
              <Text style={styles.zipPercent}>{zipProgress}%</Text>

              <View style={{ flexDirection: 'row', width: '100%', justifyContent: 'space-between', marginTop: 25, gap: 10 }}>
                <TouchableOpacity style={[styles.zipBtn, { backgroundColor: '#FEE2E2' }]} onPress={handleCancelZip}>
                  <Text style={{ color: '#EF4444', fontWeight: 'bold' }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.zipBtn, { backgroundColor: '#EFF6FF' }]} onPress={() => setIsZippingBackground(true)}>
                  <Text style={{ color: '#2563EB', fontWeight: 'bold' }}>Background</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

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
  container: { flex: 1, backgroundColor: '#F1F5F9' },
  centerLoading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F1F5F9' },
  errorText: { fontSize: 18, color: '#EF4444', fontWeight: 'bold' },
  goBackBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 10, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8, minWidth: 200 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFF', paddingTop: 60, paddingBottom: 15, paddingHorizontal: 15, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  backBtn: { padding: 5 },
  headerTitle: { fontSize: 18, fontWeight: '800', color: '#1E293B' },
  headerSub: { fontSize: 12, color: '#64748B', fontWeight: '500', marginTop: 2 },
  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 16, marginBottom: 20, borderWidth: 1, borderColor: '#E2E8F0', elevation: 1 },
  projectTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A', marginBottom: 4, lineHeight: 24, textAlign: 'center' },
  dataRow: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#F1F5F9', paddingBottom: 12, marginBottom: 12 },
  dataColumn: { flex: 1, paddingRight: 10 },
  dataLabel: { fontSize: 11, color: '#64748B', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  dataValue: { fontSize: 14, color: '#334155', fontWeight: '600' },
  scopeBox: { backgroundColor: '#F8FAFC', padding: 15, borderRadius: 8, marginTop: 5, borderWidth: 1, borderColor: '#E2E8F0', alignItems: 'center' },
  scopeText: { fontSize: 13, color: '#475569', lineHeight: 22 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  subSectionTitle: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 10, marginTop: 5, textTransform: 'uppercase' },
  viewMoreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 12, marginTop: 5, backgroundColor: '#EFF6FF', borderRadius: 8, borderWidth: 1, borderColor: '#BFDBFE' },
  viewMoreText: { color: '#2563EB', fontWeight: 'bold', fontSize: 13 },
  obsCard: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0', borderLeftWidth: 5, borderLeftColor: '#334155' },
  obsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  obsDate: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  obsSeverity: { fontSize: 11, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  obsCategory: { fontSize: 13, fontWeight: '700', color: '#1E293B', marginBottom: 6 },
  obsText: { fontSize: 14, color: '#475569', lineHeight: 22 },

  // Zip Progress Modal
  zipOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  zipCard: { backgroundColor: '#FFF', padding: 30, borderRadius: 16, width: '85%', alignItems: 'center', elevation: 5 },
  zipTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginTop: 15 },
  zipStatus: { fontSize: 14, color: '#64748B', marginTop: 5, marginBottom: 20 },
  zipProgressBarBg: { width: '100%', height: 10, backgroundColor: '#E2E8F0', borderRadius: 5, overflow: 'hidden' },
  zipProgressBarFill: { height: '100%', backgroundColor: '#2563EB' },
  zipPercent: { marginTop: 10, fontSize: 14, fontWeight: 'bold', color: '#2563EB' },
  zipBtn: { flex: 1, padding: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }
});