import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Share } from 'react-native';
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

import VisitManager from '../../components/VisitManager';
import { generateCloudLinkAndUpload } from '../../utils/cloudUploader';
import { db } from '../../utils/firebaseConfig';
import { globalStyles } from '../../styles/globalStyles';
import { openGoogleMaps, shareLocalKml, getProjectsWithLocalKmls } from '../../utils/locationHelpers';
import { useUserStore } from '../../store/userStore'; 

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
  
  const sanitizedFolder = `${projectId}_${tenderId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  const [activeTab, setActiveTab] = useState<'details' | 'visits'>('details');
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [project, setProject] = useState<any>(null);
  const [hasKml, setHasKml] = useState(false);
  
  const [latestObs, setLatestObs] = useState<any[]>([]);
  const [prevObs, setPrevObs] = useState<any[]>([]);
  const [showAllObs, setShowAllObs] = useState(false);
  const [isScopeExpanded, setIsScopeExpanded] = useState(false);
  const [hasEdited, setHasEdited] = useState(false);

  const store = useUserStore();
  
  const [exportState, setExportState] = useState<{ active: boolean, status: string, isCancellable: boolean }>({ active: false, status: '', isCancellable: false });
  const isExportingRef = useRef(false);

  const loadData = useCallback(() => {
    if (!projectId || projectId === 'UNKNOWN_PROJ') return;
    setLoading(true); setDbError(null);
    try {
      let projData;
      if (tenderId && tenderId !== 'UNKNOWN_TENDER' && tenderId.trim() !== '') {
        projData = sqlDb.getFirstSync(`SELECT t.*, pd.* FROM tenders t LEFT JOIN project_details pd ON t.project_id = pd.project_id WHERE t.project_id = ? AND t.tender_id = ? LIMIT 1`, [projectId, tenderId]);
      }
      if (!projData) {
        projData = sqlDb.getFirstSync(`SELECT t.*, pd.* FROM tenders t LEFT JOIN project_details pd ON t.project_id = pd.project_id WHERE t.project_id = ? LIMIT 1`, [projectId]);
      }

      if (!projData) { setProject(null); setLoading(false); return; }
      setProject(projData);

      const obsData = sqlDb.getAllSync(`SELECT * FROM observations WHERE project_code = ?`, [projectId]) as any[];
      if (obsData && obsData.length > 0) {
        const sortedObs = [...obsData].sort((a: any, b: any) => parseDateString(b.visit_date) - parseDateString(a.visit_date));
        setLatestObs([sortedObs[0]]);
        setPrevObs(sortedObs.length > 1 ? sortedObs.slice(1) : []);
      }
      setLoading(false);
    } catch (error: any) {
      setDbError(`Database Interruption: ${error.message}`); setLoading(false);
    }
  }, [projectId, tenderId, sqlDb]);

  useEffect(() => {
    let isMounted = true;
    if (!projectId) return;
    const timeout = setTimeout(() => { 
      if (isMounted) {
        loadData(); 
        getProjectsWithLocalKmls().then(kmls => {
          if (isMounted) setHasKml(kmls.has(sanitizedFolder));
        });
      }
    }, 50);
    return () => { isMounted = false; clearTimeout(timeout); };
  }, [loadData, projectId, sanitizedFolder]);

  const handleBackNavigation = () => router.back();

  const getDirectoryMetadata = async (folderPath: string) => {
    let totalFiles = 0, totalSize = 0, maxModTime = 0;
    const traverse = async (currentPath: string) => {
      const files = await FileSystem.readDirectoryAsync(currentPath);
      for (const file of files) {
        const fullPath = `${currentPath}${file}`;
        const info = await FileSystem.getInfoAsync(fullPath);
        if (info.isDirectory) await traverse(`${fullPath}/`);
        else {
          totalFiles++; totalSize += info.size || 0;
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

    Alert.alert("Share Project Data", `Ready to export ${currentMeta.totalFiles} files (~${formatBytes(currentMeta.totalSize)})`, [
      { text: "Cancel", style: "cancel" },
      { text: "Share as Link (Cloud)", onPress: () => handleCloudShare(sourcePath, currentMeta) },
      { text: "Share as ZIP (Local)", onPress: () => handleLocalShare(sourcePath) }
    ]);
  };

  const handleCloudShare = async (sourcePath: string, currentMeta: any) => {
    try {
      isExportingRef.current = true;
      setExportState({ active: true, status: 'Preparing Cloud Sync...', isCancellable: false });

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
      } catch (e) {
        console.warn("Failed to fetch user details", e);
      }

      const { expectedUrl, startBackgroundUpload } = await generateCloudLinkAndUpload(sanitizedFolder, sourcePath, uName, currentMeta, (status) => {
         setExportState(prev => ({ ...prev, status }));
      });
      
      const msg = `Project Data Export for ${projectId}:\n${expectedUrl}\n\nNote: The link might not be fully ready until the files are uploaded completely by the sender.`;
      
      setExportState({ active: true, status: 'Starting Upload...', isCancellable: true });
      await Share.share({ message: msg });

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
      setExportState({ active: true, status: 'Compressing directory...\nThis may take a while depending on the total size.', isCancellable: true });
      
      const targetZipPath = `${FileSystem.cacheDirectory}${sanitizedFolder}.zip`;
      let cleanSource = sourcePath.replace('file://', '');
      try { cleanSource = decodeURIComponent(cleanSource); } catch(e){}
      let cleanTarget = targetZipPath.replace('file://', '');
      
      setTimeout(async () => {
        try {
          await zip(cleanSource, cleanTarget);
          setExportState({ active: false, status: '', isCancellable: false });
          await Sharing.shareAsync(targetZipPath, { dialogTitle: `Share Project: ${projectId}` });
        } catch(e) {
          Alert.alert("Zipping Failed", "Could not create local ZIP file.");
        } finally {
          isExportingRef.current = false;
        }
      }, 300);
    } catch (e) {
      isExportingRef.current = false; setExportState({ active: false, status: '', isCancellable: false });
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Alert.alert("Copied", `${label} details copied to clipboard.`);
  };

  const handleAddToPlanner = () => {
    store.addPlannerItem({
      id: `${project.project_id}_${project.tender_id}`,
      projectId: project.project_id,
      tenderId: project.tender_id,
      title: project.project_title,
      ulb: project.ulb
    });
    Alert.alert("Added to Planner", `Project added to Visits Pending list.`);
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
  const isAlreadyPlanned = store.plannerItems.some(i => i.id === `${project.project_id}_${project.tender_id}`);
  const hasVisited = latestObs.length > 0 || prevObs.length > 0 || hasEdited || hasKml;

  return (
    <View style={globalStyles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBackNavigation} style={styles.backBtn}><Ionicons name="arrow-back" size={24} color="#1E293B" /></TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{project.project_id}</Text>
          <Text style={styles.headerSub}>{project.ulb}, {project.state}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {(!isAlreadyPlanned && !hasVisited) && (
            <TouchableOpacity onPress={handleAddToPlanner} style={[styles.backBtn, { marginRight: 10 }]}>
              <Ionicons name="add-circle" size={26} color="#10B981" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleShareOptions} style={styles.backBtn}>
            <Ionicons name="share-social" size={24} color="#2563EB" />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.tabContainer}>
         <TouchableOpacity onPress={() => setActiveTab('details')} style={[styles.tabBtn, activeTab === 'details' && styles.tabBtnActive]}>
            <Ionicons name="document-text" size={16} color={activeTab === 'details' ? "#2563EB" : "#64748B"} style={{marginRight: 6}} />
            <Text style={[styles.tabText, activeTab === 'details' && styles.tabTextActive]}>Project Info</Text>
         </TouchableOpacity>
         <TouchableOpacity onPress={() => setActiveTab('visits')} style={[styles.tabBtn, activeTab === 'visits' && styles.tabBtnActive]}>
            <Ionicons name="location" size={16} color={activeTab === 'visits' ? "#2563EB" : "#64748B"} style={{marginRight: 6}} />
            <Text style={[styles.tabText, activeTab === 'visits' && styles.tabTextActive]}>Field Visits</Text>
         </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={globalStyles.scrollContent}>
        {activeTab === 'details' && (
          <View>
            <View style={globalStyles.card}>
              <Text style={styles.projectTitle}>{project.project_title || 'Untitled Project'}</Text>
              <Text style={styles.projectTypeTag}>{project.project_type || 'N/A'}</Text>
              
              <View style={styles.dataGrid}>
                <DataCell label="Tender ID" value={project.tender_id} />
                <DataCell label="No. of Tenders" value={project.no_of_tenders} />
                <DataCell label="NIT Date" value={project.nit_date} />
                <DataCell label="Award Date" value={project.award_date} />
                <DataCell label="Sch. Completion" value={project.sch_completion_date} />
                <DataCell label="Bidder Name" value={project.bidder_name} fullWidth />
                
                <DataCell label="Est. CAPEX" value={`₹${project.est_capex || '0'} Cr`} />
                <DataCell label="Est. O&M" value={`₹${project.est_o_m || '0'} Cr`} />
                <DataCell label="Awarded CAPEX" value={`₹${project.awarded_capex || project.capex || '0'} Cr`} color="#2563EB" />
                <DataCell label="Awarded O&M" value={`₹${project.awarded_om || project.om || '0'} Cr`} color="#2563EB" />
                
                <DataCell label="Physical Progress" value={`${project.physical_progress || '0'}%`} color="#16A34A" />
                <DataCell label="Financial Progress" value={`${project.financial_progress || '0'}%`} color="#D97706" />
              </View>

              <View style={[globalStyles.btnRow, { marginBottom: 15 }]}>
                <View style={{ flex: 1, marginRight: 5 }}>
                  {project.latitude && project.longitude && (
                    <TouchableOpacity style={globalStyles.locateYellowBtn} onPress={() => openGoogleMaps(project.latitude, project.longitude)}>
                      <Ionicons name="navigate-circle-outline" size={20} color="white" />
                      <Text style={globalStyles.locateBtnText}>Map Direct</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <View style={{ flex: 1, marginLeft: 5 }}>
                  {hasKml && (
                    <TouchableOpacity style={globalStyles.locateGreenBtn} onPress={() => shareLocalKml(projectId, tenderId)}>
                      <Ionicons name="earth" size={20} color="white" />
                      <Text style={globalStyles.locateBtnText}>View KML</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              <View style={styles.scopeBox}>
                <Text style={[styles.dataLabel, { textAlign: 'center', marginBottom: 6 }]}>Brief Scope of Work</Text>
                <Text style={styles.scopeText} numberOfLines={isScopeExpanded ? undefined : 3}>{project.scope || 'No scope details available.'}</Text>
                {(project.scope && project.scope.length > 120) && (
                  <TouchableOpacity onPress={() => setIsScopeExpanded(!isScopeExpanded)} style={{ marginTop: 8, alignSelf: 'center' }}>
                    <Text style={{ color: '#2563EB', fontSize: 12, fontWeight: '700' }}>{isScopeExpanded ? 'View Less' : 'View More'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <Text style={styles.sectionHeader}>Personnel Details</Text>
            <ContactCard title="State Officer" name={project.state_officer} designation="State Representative" phone={project.so_contact} email={project.so_email} onCopy={copyToClipboard} />
            <ContactCard title="IRMA Personnel" name={project.irma_personnel} designation={project.designation} phone={project.contact} email={project.email} onCopy={copyToClipboard} />
          </View>
        )}

        {activeTab === 'visits' && (
          <View>
            <VisitManager projectId={projectId} tenderId={tenderId} folderName={sanitizedFolder} onEdit={() => setHasEdited(true)} />

            <Text style={[styles.sectionHeader, { textAlign: 'center', marginTop: 10 }]}>IRMA Observations</Text>
            {latestObs.length === 0 && prevObs.length === 0 ? (
              <View style={globalStyles.card}><Text style={{color: '#64748B', textAlign: 'center', fontStyle: 'italic'}}>No IRMA review records exist for this project code.</Text></View>
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
                      <TouchableOpacity onPress={() => setShowAllObs(!showAllObs)} style={[styles.viewMoreBtn, showAllObs && { marginTop: 8 }]}>
                        <Text style={styles.viewMoreText}>{showAllObs ? 'Collapse Observations' : `View All Previous Observations (${prevObs.length})`}</Text>
                        <Ionicons name={showAllObs ? "chevron-up" : "chevron-down"} size={14} color="#2563EB" style={{marginLeft: 4}}/>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                <View style={styles.endOfObservationsMarker}>
                   <Text style={{ color: '#94A3B8', fontSize: 11, fontStyle: 'italic', letterSpacing: 2 }}>--------------- end of observations ---------------</Text>
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

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

const DataCell = ({ label, value, fullWidth, color }: any) => (
  <View style={[styles.dataColumn, fullWidth && { width: '100%' }]}>
    <Text style={styles.dataLabel}>{label}</Text>
    <Text style={[styles.dataValue, color && { color, fontWeight: 'bold' }]}>{value || 'N/A'}</Text>
  </View>
);

const ContactCard = ({ title, name, designation, phone, email, onCopy }: any) => {
  if (!name && !phone && !email) return null;
  const formattedPhone = phone ? (phone.startsWith('+') ? phone : `+91 ${phone}`) : '';

  const handleCopy = () => {
    onCopy(`${title}: ${name}\nPhone: ${formattedPhone}\nEmail: ${email}`, title);
  };

  return (
    <View style={styles.contactCard}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
         <Text style={styles.contactHeader}>{title}</Text>
         <TouchableOpacity onPress={handleCopy} style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#EFF6FF', borderRadius: 8 }}>
            <Text style={{color: '#2563EB', fontWeight: 'bold', fontSize: 11}}>Copy Contact</Text>
         </TouchableOpacity>
      </View>
      <View style={styles.contactNameRow}>
        <Ionicons name="person-circle" size={36} color="#475569" style={{marginRight: 10}} />
        <View style={{flex: 1}}>
           <Text style={styles.contactName}>{name || 'Unknown'}</Text>
           <Text style={styles.contactDesig}>{designation || 'Personnel'}</Text>
        </View>
      </View>
      
      {email ? (
        <View style={styles.contactRow}>
          <Text style={styles.contactLabel}>Email:</Text>
          <Text style={styles.contactValue} numberOfLines={1}>{email}</Text>
          <TouchableOpacity style={styles.iconBtn} onPress={() => Linking.openURL(`mailto:${email}`)}><Ionicons name="mail" size={16} color="#FFF" /></TouchableOpacity>
        </View>
      ) : null}

      {phone ? (
        <View style={styles.contactRow}>
          <Text style={styles.contactLabel}>Contact:</Text>
          <Text style={styles.contactValue}>{formattedPhone}</Text>
          <TouchableOpacity style={[styles.iconBtn, {backgroundColor: '#10B981'}]} onPress={() => Linking.openURL(`tel:${formattedPhone}`)}><Ionicons name="call" size={16} color="#FFF" /></TouchableOpacity>
          <TouchableOpacity style={[styles.iconBtn, {backgroundColor: '#25D366'}]} onPress={() => Linking.openURL(`whatsapp://send?phone=${formattedPhone.replace(/\D/g,'')}`)}><Ionicons name="logo-whatsapp" size={16} color="#FFF" /></TouchableOpacity>
        </View>
      ) : null}
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
  
  tabContainer: { flexDirection: 'row', backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 15 },
  tabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 15, borderBottomWidth: 3, borderColor: 'transparent' },
  tabBtnActive: { borderColor: '#2563EB' },
  tabText: { fontSize: 14, fontWeight: '700', color: '#64748B' },
  tabTextActive: { color: '#2563EB' },

  sectionHeader: { fontSize: 16, fontWeight: '900', color: '#0F172A', marginBottom: 12, marginTop: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionHeaderRow: { marginBottom: 5 },
  
  projectTypeTag: { fontSize: 12, color: '#2563EB', marginBottom: 6, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'center' },
  projectTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A', marginBottom: 15, lineHeight: 24, textAlign: 'center' },
  dataGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  dataColumn: { width: '48%', marginBottom: 15 },
  dataLabel: { fontSize: 10, color: '#64748B', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  dataValue: { fontSize: 13, color: '#334155', fontWeight: '600' },
  scopeBox: { backgroundColor: '#F8FAFC', padding: 15, borderRadius: 8, marginTop: 5, borderWidth: 1, borderColor: '#E2E8F0' },
  scopeText: { fontSize: 13, color: '#475569', lineHeight: 22, textAlign: 'justify' },
  
  contactCard: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 15, borderWidth: 1, borderColor: '#E2E8F0' },
  contactHeader: { fontSize: 11, fontWeight: '800', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1, marginTop: 4 },
  contactNameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  contactName: { fontSize: 16, fontWeight: 'bold', color: '#1E293B' },
  contactDesig: { fontSize: 12, color: '#64748B', fontWeight: '500' },
  contactRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  contactLabel: { fontSize: 13, fontWeight: 'bold', color: '#475569', width: 60 },
  contactValue: { flex: 1, fontSize: 13, color: '#1E293B', fontWeight: '600' },
  iconBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#2563EB', justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
  
  subSectionTitle: { fontSize: 13, fontWeight: '700', color: '#64748B', marginBottom: 10, marginTop: 5, textTransform: 'uppercase' },
  viewMoreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 12, marginTop: -5, marginBottom: 5, backgroundColor: '#EFF6FF', borderRadius: 8, borderWidth: 1, borderColor: '#BFDBFE' },
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