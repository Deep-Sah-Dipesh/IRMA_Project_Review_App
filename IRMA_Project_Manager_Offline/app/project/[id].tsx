import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Share } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { zip } from 'react-native-zip-archive';
import { Ionicons } from '@expo/vector-icons';
import VisitManager from '../../components/VisitManager';
import { generateCloudLinkAndUpload } from '../../utils/cloudUploader';

const parseDateString = (dateStr: string) => {
  if (!dateStr) return 0;
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    if (parts[0].length === 4) return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])).getTime();
    return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])).getTime();
  }
  return new Date(dateStr).getTime() || 0;
};

export default function ProjectDetails() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const db = SQLite.useSQLiteContext();
  
  // CRITICAL FIX: Safe parameter extraction guaranteed by the updated Router pushes.
  // Prevents the "undefined_undefined" fallback that caused all projects to share files.
  const projectId = typeof params.id === 'string' ? params.id : (Array.isArray(params.id) ? params.id[0] : 'UNKNOWN_PROJ');
  const tenderId = typeof params.tender_id === 'string' ? params.tender_id : (Array.isArray(params.tender_id) ? params.tender_id[0] : 'UNKNOWN_TENDER');
  
  const sanitizedFolder = `${projectId}_${tenderId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [project, setProject] = useState<any>(null);
  
  const [latestObs, setLatestObs] = useState<any[]>([]);
  const [prevObs, setPrevObs] = useState<any[]>([]);
  const [showAllObs, setShowAllObs] = useState(false);
  const [isScopeExpanded, setIsScopeExpanded] = useState(false);
  const [hasEdited, setHasEdited] = useState(false);

  const [isZippingBackground, setIsZippingBackground] = useState(false);
  const isExportingRef = useRef(false);

  const loadData = useCallback(() => {
    if (!projectId || !tenderId) return;
    setLoading(true); setDbError(null);
    try {
      const projData = db.getFirstSync(`SELECT * FROM tenders WHERE project_id = ? AND tender_id = ?`, [projectId, tenderId]);
      if (!projData) { setProject(null); setLoading(false); return; }
      setProject(projData);

      const obsData = db.getAllSync(`SELECT * FROM observations WHERE project_code = ?`, [projectId]) as any[];
      if (obsData && obsData.length > 0) {
        const sortedObs = [...obsData].sort((a: any, b: any) => parseDateString(b.visit_date) - parseDateString(a.visit_date));
        const newestTimestamp = parseDateString(sortedObs[0].visit_date);
        setLatestObs(sortedObs.filter((o: any) => parseDateString(o.visit_date) === newestTimestamp));
        setPrevObs(sortedObs.filter((o: any) => parseDateString(o.visit_date) !== newestTimestamp));
      }
      setLoading(false);
    } catch (error: any) {
      setDbError(`Database Interruption: ${error.message}`); setLoading(false);
    }
  }, [projectId, tenderId, db]);

  useEffect(() => {
    let isMounted = true;
    if (!projectId || !tenderId) return;
    const timeout = setTimeout(() => { if (isMounted) loadData(); }, 50);
    return () => { isMounted = false; clearTimeout(timeout); };
  }, [loadData, projectId, tenderId]);

  const handleBackNavigation = () => hasEdited ? router.replace('/(tabs)/dashboard') : router.back();

  const getDirectoryMetadata = async (folderPath: string) => {
    let totalFiles = 0;
    let totalSize = 0;
    let maxModTime = 0;

    const traverse = async (currentPath: string) => {
      const files = await FileSystem.readDirectoryAsync(currentPath);
      for (const file of files) {
        const fullPath = `${currentPath}${file}`;
        const info = await FileSystem.getInfoAsync(fullPath);
        if (info.isDirectory) {
          await traverse(`${fullPath}/`);
        } else {
          totalFiles++;
          totalSize += info.size || 0;
          if (info.modificationTime && info.modificationTime > maxModTime) maxModTime = info.modificationTime;
        }
      }
    };
    await traverse(folderPath);
    return { totalFiles, totalSize, maxModTime };
  };

  const handleShareOptions = async () => {
    if (isExportingRef.current) return;
    const sourcePath = `${FileSystem.documentDirectory}projects/${sanitizedFolder}/`;
    
    const dirInfo = await FileSystem.getInfoAsync(sourcePath);
    if (!dirInfo.exists) return Alert.alert("No Data", "No files exist to share.");

    const currentMeta = await getDirectoryMetadata(sourcePath);
    if (currentMeta.totalFiles === 0) return Alert.alert("Empty Directory", "No files exist to share.");

    Alert.alert(
      "Share Project Data",
      "Choose how you want to share this project:",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Share as Link (Cloud)", onPress: () => handleCloudShare(sourcePath, currentMeta) },
        { text: "Share as ZIP (Local)", onPress: () => handleLocalShare(sourcePath) }
      ]
    );
  };

  const handleCloudShare = async (sourcePath: string, currentMeta: any) => {
    try {
      isExportingRef.current = true;
      setIsZippingBackground(true);

      const { expectedUrl, startBackgroundUpload, isCached } = await generateCloudLinkAndUpload(sanitizedFolder, sourcePath, currentMeta);

      const msg = isCached 
        ? `Project Data Export for ${projectId}:\n${expectedUrl}`
        : `Project Data Export for ${projectId}:\n${expectedUrl}\n\nNote: The file is currently uploading. If the link does not work immediately, please wait a minute.`;

      await Share.share({ message: msg });

      startBackgroundUpload().finally(() => {
        isExportingRef.current = false;
        setIsZippingBackground(false);
      });

    } catch (e: any) {
      isExportingRef.current = false; setIsZippingBackground(false);
      Alert.alert("Export Error", "Failed to initialize cloud upload.");
    }
  };

  const handleLocalShare = async (sourcePath: string) => {
    try {
      isExportingRef.current = true;
      setIsZippingBackground(true);
      
      const targetZipPath = `${FileSystem.cacheDirectory}local_${sanitizedFolder}.zip`;
      
      let cleanSource = sourcePath.replace('file://', '');
      try { cleanSource = decodeURIComponent(cleanSource); } catch(e){}
      let cleanTarget = targetZipPath.replace('file://', '');
      
      await zip(cleanSource, cleanTarget);
      
      setIsZippingBackground(false);
      await Sharing.shareAsync(targetZipPath, { dialogTitle: `Share Project: ${projectId}` });
      isExportingRef.current = false;
    } catch (e) {
      isExportingRef.current = false; setIsZippingBackground(false);
      Alert.alert("Zipping Failed", "Could not create local ZIP file.");
    }
  };

  if (loading) return <View style={styles.centerLoading}><ActivityIndicator size="large" color="#2563EB" /><Text style={{ marginTop: 10, color: '#64748B' }}>Fetching Project Details...</Text></View>;
  
  if (dbError || !project) return (
    <View style={styles.centerLoading}>
      <Ionicons name="warning" size={48} color="#EF4444" style={{ marginBottom: 10 }} />
      <Text style={styles.errorText}>{!project ? "Project Not Found" : "Connection Interrupted"}</Text>
      <TouchableOpacity onPress={() => loadData()} style={[styles.goBackBtn, { backgroundColor: '#10B981', marginBottom: 10 }]}><Text style={{color: '#FFF'}}>Retry</Text></TouchableOpacity>
      <TouchableOpacity onPress={handleBackNavigation} style={[styles.goBackBtn, { backgroundColor: '#64748B' }]}><Text style={{color: '#FFF'}}>Return</Text></TouchableOpacity>
    </View>
  );

  const displayedPrevObs = showAllObs ? prevObs : prevObs.slice(0, 5);
  const isLongScope = project.scope && project.scope.length > 120;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBackNavigation} style={styles.backBtn}><Ionicons name="arrow-back" size={24} color="#1E293B" /></TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{project.project_id}</Text>
          <Text style={styles.headerSub}>{project.ulb}, {project.state}</Text>
        </View>
        <TouchableOpacity onPress={handleShareOptions} style={styles.backBtn}>
          <Ionicons name="share-social" size={24} color="#2563EB" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 15, paddingBottom: 60 }}>
        
        <View style={styles.card}>
          <Text style={styles.projectTypeTag}>{project.project_type || 'N/A'}</Text>
          <Text style={styles.projectTitle}>{project.project_title || 'Untitled Project'}</Text>
          
          <View style={styles.dataRow}>
            <View style={styles.dataColumn}><Text style={styles.dataLabel}>Tender ID</Text><Text style={styles.dataValue}>{project.tender_id || 'N/A'}</Text></View>
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
            <Text style={styles.scopeText} numberOfLines={isScopeExpanded ? undefined : 3}>{project.scope || 'No scope details available.'}</Text>
            {isLongScope && (
              <TouchableOpacity onPress={() => setIsScopeExpanded(!isScopeExpanded)} style={{ marginTop: 8 }}>
                <Text style={{ color: '#2563EB', fontSize: 12, fontWeight: '700' }}>{isScopeExpanded ? 'View Less' : 'View More'}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        <VisitManager projectId={projectId} tenderId={tenderId} folderName={sanitizedFolder} onEdit={() => setHasEdited(true)} />

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

      {isZippingBackground && (
        <View style={styles.backgroundToast}>
          <ActivityIndicator size="small" color="#FFF" style={{marginRight: 10}} />
          <Text style={{color: '#FFF', fontWeight: 'bold', fontSize: 13}}>Processing Project Data...</Text>
        </View>
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
  goBackBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8, minWidth: 200, alignItems: 'center', marginTop: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFF', paddingTop: 60, paddingBottom: 15, paddingHorizontal: 15, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  backBtn: { padding: 5 },
  headerTitle: { fontSize: 18, fontWeight: '800', color: '#1E293B' },
  headerSub: { fontSize: 12, color: '#64748B', fontWeight: '500', marginTop: 2 },
  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 16, marginBottom: 20, borderWidth: 1, borderColor: '#E2E8F0', elevation: 1 },
  projectTypeTag: { fontSize: 12, color: '#2563EB', marginBottom: 6, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'center' },
  projectTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A', marginBottom: 15, lineHeight: 24, textAlign: 'center' },
  dataRow: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#F1F5F9', paddingBottom: 12, marginBottom: 12 },
  dataColumn: { flex: 1, paddingRight: 10 },
  dataLabel: { fontSize: 11, color: '#64748B', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  dataValue: { fontSize: 14, color: '#334155', fontWeight: '600' },
  scopeBox: { backgroundColor: '#F8FAFC', padding: 15, borderRadius: 8, marginTop: 5, borderWidth: 1, borderColor: '#E2E8F0', alignItems: 'center' },
  scopeText: { fontSize: 13, color: '#475569', lineHeight: 22, textAlign: 'justify' },
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
  backgroundToast: { position: 'absolute', bottom: 30, alignSelf: 'center', backgroundColor: '#334155', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 30, elevation: 5 }
});