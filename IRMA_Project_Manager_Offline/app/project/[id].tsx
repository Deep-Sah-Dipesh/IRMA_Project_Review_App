import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Modal, TouchableWithoutFeedback, FlatList } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';

const parseDateString = (dateStr: string) => {
  if (!dateStr) return 0;
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])).getTime();
  }
  return 0;
};

const getFormattedDateTime = () => {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${date}_${time}`;
};

const safeDecode = (val: any): string => {
  if (val === undefined || val === null) return '';
  const strVal = String(val);
  if (strVal === 'undefined' || strVal === 'null' || strVal.trim() === '') return '';
  try { return decodeURIComponent(strVal); } 
  catch (e) { return strVal; }
};

export default function ProjectDetails() {
  const params = useLocalSearchParams();
  const router = useRouter();
  
  const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
  const rawTenderId = Array.isArray(params.tender_id) ? params.tender_id[0] : params.tender_id;
  
  const projectId = safeDecode(rawId);
  const tenderId = safeDecode(rawTenderId);
  
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [project, setProject] = useState<any>(null);
  
  const [latestObs, setLatestObs] = useState<any[]>([]);
  const [prevObs, setPrevObs] = useState<any[]>([]);
  
  const [visits, setVisits] = useState<string[]>([]);
  const [activeVisit, setActiveVisit] = useState<string | null>(null);
  const [showVisitModal, setShowVisitModal] = useState(false);

  useEffect(() => {
    let isMounted = true;
    if (projectId && tenderId) {
      loadAllData(isMounted);
    } else {
      const timeout = setTimeout(() => { if(isMounted) setLoading(false); }, 800);
      return () => clearTimeout(timeout);
    }
    return () => { isMounted = false; };
  }, [projectId, tenderId]);

  const loadAllData = useCallback(async (isMounted: boolean = true) => {
    if (!projectId || !tenderId) return;
    
    setLoading(true);
    setDbError(null);

    try {
      // FIX 1: Add a tiny delay to let the Router transition animation finish.
      // This stops the Native Bridge from panicking during fast component mounts.
      await new Promise(resolve => setTimeout(resolve, 100));

      // FIX 2: Open an isolated DB connection specific to this exact fetch.
      // Do not use the Context Provider.
      const db = await SQLite.openDatabaseAsync('civil_projects.db');
      
      const pId = String(projectId);
      const tId = String(tenderId);

      // Strict String Array Bindings
      const projData = await db.getFirstAsync(
        "SELECT * FROM tenders WHERE project_id = ? AND tender_id = ?",
        [pId, tId]
      );
      
      if (!isMounted) return;
      
      if (!projData) {
        setProject(null);
        setLoading(false);
        return; 
      }
      
      setProject(projData);

      const obsData = await db.getAllAsync(
        "SELECT * FROM observations WHERE project_code = ?",
        [pId]
      );
      
      if (obsData && obsData.length > 0 && isMounted) {
        const sortedObs = [...obsData].sort((a: any, b: any) => parseDateString(b.visit_date) - parseDateString(a.visit_date));
        const newestTimestamp = parseDateString(sortedObs[0].visit_date);
        
        const recent = sortedObs.filter((o: any) => parseDateString(o.visit_date) === newestTimestamp);
        const older = sortedObs.filter((o: any) => parseDateString(o.visit_date) !== newestTimestamp);
        
        setLatestObs(recent);
        setPrevObs(older);
      }

      await scanExistingVisits(projectId, tenderId);

    } catch (error: any) {
      console.error("Database Interruption:", error);
      if (isMounted) {
        setDbError(error.message || "Failed to initialize the database connection safely.");
      }
    } finally {
      if (isMounted) setLoading(false);
    }
  }, [projectId, tenderId]);

  const getBaseDirectory = (pId: string, tId: string) => {
    const sanitizedFolder = `${pId}_${tId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${FileSystem.documentDirectory}projects/${sanitizedFolder}/`;
  };

  const scanExistingVisits = async (pId: string, tId: string) => {
    try {
      const baseUri = getBaseDirectory(pId, tId);
      const dirInfo = await FileSystem.getInfoAsync(baseUri);
      
      if (dirInfo.exists) {
        const files = await FileSystem.readDirectoryAsync(baseUri);
        const visitDirs = files.filter(f => f.startsWith('visit_')).sort();
        setVisits(visitDirs);
        if (visitDirs.length > 0) {
          setActiveVisit(visitDirs[visitDirs.length - 1]);
        }
      }
    } catch (error) {
      console.error("Failed to scan visits:", error);
    }
  };

  const createNewVisit = async () => {
    if (!projectId || !tenderId) return;

    try {
      const baseUri = getBaseDirectory(projectId, tenderId);
      const dirInfo = await FileSystem.getInfoAsync(baseUri);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(baseUri, { intermediates: true });
      }

      const visitNumber = visits.length + 1;
      const timestamp = getFormattedDateTime();
      const newVisitName = `visit_${visitNumber}_${timestamp}`;
      const newVisitUri = `${baseUri}${newVisitName}/`;

      await FileSystem.makeDirectoryAsync(newVisitUri, { intermediates: true });
      
      const newVisitsList = [...visits, newVisitName].sort();
      setVisits(newVisitsList);
      setActiveVisit(newVisitName); 
      
      Alert.alert("New Visit Created", `Session securely locked to:\n${newVisitName}`);
    } catch (error) {
      console.error("Failed to create visit directory:", error);
      Alert.alert("Error", "Could not create visit directory.");
    }
  };

  const selectVisit = (visitName: string) => {
    setActiveVisit(visitName);
    setShowVisitModal(false);
    Alert.alert("Session Locked", `All media captures will be routed to:\n${visitName}`);
  };

  const handleMultimediaAction = async (actionName: string, subfolder: string) => {
    if (!activeVisit || !projectId || !tenderId) {
      Alert.alert("No Visit Active", "Please 'Create New Visit' or 'Select Past Visit' before proceeding.");
      return;
    }
    
    try {
      const baseUri = getBaseDirectory(projectId, tenderId);
      const targetFolderUri = `${baseUri}${activeVisit}/${subfolder}/`;
      
      const dirInfo = await FileSystem.getInfoAsync(targetFolderUri);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(targetFolderUri, { intermediates: true });
      }
      
      Alert.alert(`${actionName} Ready`, `Media securely routed to:\n.../${activeVisit}/${subfolder}/`);
    } catch (error) {
      console.error(`Failed to provision ${subfolder} folder:`, error);
      Alert.alert("System Error", "Could not mount the required file system structure.");
    }
  };

  if (loading) {
    return (
      <View style={styles.centerLoading}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={{ marginTop: 10, color: '#64748B' }}>Fetching Project Details...</Text>
      </View>
    );
  }

  if (dbError) {
    return (
      <View style={styles.centerLoading}>
        <Ionicons name="warning" size={48} color="#EF4444" style={{ marginBottom: 10 }} />
        <Text style={styles.errorText}>Connection Interrupted</Text>
        <Text style={{ marginTop: 5, color: '#64748B', textAlign: 'center', paddingHorizontal: 30, marginBottom: 20 }}>
          The database connection dropped during navigation.
        </Text>
        
        <TouchableOpacity onPress={() => loadAllData(true)} style={[styles.goBackBtn, { backgroundColor: '#10B981', marginBottom: 10 }]}>
          <Ionicons name="refresh" size={16} color="#FFF" style={{marginRight: 6}} />
          <Text style={{color: '#FFF', fontWeight: 'bold'}}>Retry / Refresh Data</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.back()} style={[styles.goBackBtn, { backgroundColor: '#64748B' }]}>
          <Ionicons name="arrow-back" size={16} color="#FFF" style={{marginRight: 6}} />
          <Text style={{color: '#FFF', fontWeight: 'bold'}}>Return to Dashboard</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!project) {
    return (
      <View style={styles.centerLoading}>
        <Text style={styles.errorText}>Project Record Not Found</Text>
        <Text style={{ marginTop: 5, color: '#64748B' }}>Ensure the project exists in the current CSV index.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.goBackBtn}>
          <Text style={{color: '#FFF', fontWeight: 'bold'}}>Return to Dashboard</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#1E293B" />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{project.project_id}</Text>
          <Text style={styles.headerSub}>{project.ulb}, {project.state}</Text>
        </View>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 15, paddingBottom: 60 }}>
        
        <View style={styles.card}>
          <View style={styles.dataRow}>
            <View style={styles.dataColumn}>
              <Text style={styles.dataLabel}>Project Type</Text>
              <Text style={styles.dataValue}>{project.project_type || 'N/A'}</Text>
            </View>
            <View style={styles.dataColumn}>
              <Text style={styles.dataLabel}>Tender ID</Text>
              <Text style={styles.dataValue}>{project.tender_id || 'N/A'}</Text>
            </View>
          </View>

          <Text style={styles.projectTitle}>{project.project_title || 'Untitled Project'}</Text>
          <Text style={styles.tenderNameText}>{project.tender_name || 'Tender Name N/A'}</Text>

          <View style={styles.dataRow}>
            <View style={styles.dataColumn}>
              <Text style={styles.dataLabel}>NIT Issued Date</Text>
              <Text style={styles.dataValue}>{project.nit_date || 'N/A'}</Text>
            </View>
            <View style={styles.dataColumn}>
              <Text style={styles.dataLabel}>Contract Awarded</Text>
              <Text style={styles.dataValue}>{project.award_date || 'N/A'}</Text>
            </View>
          </View>

          <View style={styles.dataRow}>
            <View style={styles.dataColumn}>
              <Text style={styles.dataLabel}>Bidder Name</Text>
              <Text style={styles.dataValue} numberOfLines={2}>{project.bidder_name || 'N/A'}</Text>
            </View>
            <View style={styles.dataColumn}>
              <Text style={styles.dataLabel}>CAPEX</Text>
              <Text style={styles.dataValue}>₹{project.capex || '0'} Cr</Text>
            </View>
          </View>

          <View style={styles.dataRow}>
            <View style={styles.dataColumn}>
              <Text style={styles.dataLabel}>Physical Progress</Text>
              <Text style={[styles.dataValue, { color: '#16A34A', fontWeight: 'bold' }]}>{project.physical_progress || '0'}%</Text>
            </View>
            <View style={styles.dataColumn}>
              <Text style={styles.dataLabel}>Financial Progress</Text>
              <Text style={[styles.dataValue, { color: '#2563EB', fontWeight: 'bold' }]}>{project.financial_progress || '0'}%</Text>
            </View>
          </View>

          <View style={styles.scopeBox}>
            <Text style={styles.dataLabel}>Brief Scope of Work</Text>
            <Text style={styles.scopeText}>{project.scope || 'No scope details available.'}</Text>
          </View>
        </View>

        <View style={styles.visitContainer}>
          <Text style={styles.sectionTitle}>Field Visit Session</Text>
          
          <View style={styles.visitControls}>
            <TouchableOpacity 
              style={[styles.visitBtn, { backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: '#CBD5E1', flex: 1, marginRight: 10 }]} 
              onPress={() => setShowVisitModal(true)}
            >
              <Ionicons name="list" size={16} color="#334155" style={{ marginRight: 6 }} />
              <Text style={{ color: '#334155', fontWeight: 'bold', fontSize: 13 }}>Select Past Visit</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.visitBtn, { backgroundColor: '#2563EB', flex: 1 }]} 
              onPress={createNewVisit}
            >
              <Ionicons name="add-circle" size={16} color="#FFF" style={{ marginRight: 6 }} />
              <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 13 }}>Create New</Text>
            </TouchableOpacity>
          </View>

          {activeVisit ? (
            <View style={styles.activeVisitBox}>
              <Ionicons name="shield-checkmark" size={16} color="#15803D" style={{ marginRight: 6 }} />
              <Text style={styles.activeVisitText}>Locked: <Text style={{fontWeight: 'bold'}}>{activeVisit}</Text></Text>
            </View>
          ) : (
            <Text style={styles.noVisitText}>Select or Create a visit report session to unlock media buttons.</Text>
          )}

          <View style={[styles.actionGrid, !activeVisit && { opacity: 0.3 }]}>
            <ActionButton icon="camera" label="Take Photo" color="#2563EB" onPress={() => handleMultimediaAction('Camera Mounted', 'photos')} disabled={!activeVisit} />
            <ActionButton icon="videocam" label="Record Video" color="#DB2777" onPress={() => handleMultimediaAction('Video Mounted', 'videos')} disabled={!activeVisit} />
            <ActionButton icon="mic" label="Voice Note" color="#EA580C" onPress={() => handleMultimediaAction('Microphone Mounted', 'audio')} disabled={!activeVisit} />
            <ActionButton icon="chatbubble-ellipses" label="Comment" color="#059669" onPress={() => handleMultimediaAction('Comment Logged', 'comments')} disabled={!activeVisit} />
            <ActionButton icon="attach" label="Attach File" color="#7C3AED" onPress={() => handleMultimediaAction('File Selected', 'documents')} disabled={!activeVisit} />
            <ActionButton icon="location" label="Geotag" color="#0891B2" onPress={() => handleMultimediaAction('Location Saved', 'location')} disabled={!activeVisit} />
          </View>
        </View>

        <Text style={styles.sectionTitle}>IRMA Observations</Text>
        
        {latestObs.length === 0 && prevObs.length === 0 ? (
          <View style={styles.card}>
            <Text style={{color: '#64748B', textAlign: 'center', fontStyle: 'italic'}}>No IRMA review records exist for this project code.</Text>
          </View>
        ) : (
          <View>
            {latestObs.length > 0 && (
              <View style={{ marginBottom: 15 }}>
                <Text style={styles.subSectionTitle}>Most Recent ({latestObs[0].visit_date})</Text>
                {latestObs.map((obs, idx) => <ObservationCard key={`latest_${idx}`} obs={obs} />)}
              </View>
            )}

            {prevObs.length > 0 && (
              <View>
                <Text style={styles.subSectionTitle}>Previous Observations</Text>
                {prevObs.map((obs, idx) => <ObservationCard key={`prev_${idx}`} obs={obs} />)}
              </View>
            )}
          </View>
        )}

      </ScrollView>

      <Modal visible={showVisitModal} transparent animationType="fade">
        <TouchableWithoutFeedback onPress={() => setShowVisitModal(false)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.modalContent}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Select Visit Session</Text>
                  <TouchableOpacity onPress={() => setShowVisitModal(false)}>
                    <Ionicons name="close" size={24} color="#64748B" />
                  </TouchableOpacity>
                </View>
                
                <FlatList
                  data={visits}
                  keyExtractor={(item) => item}
                  renderItem={({ item }) => (
                    <TouchableOpacity 
                      style={[styles.modalItem, activeVisit === item && { backgroundColor: '#EFF6FF' }]} 
                      onPress={() => selectVisit(item)}
                    >
                      <Ionicons name={activeVisit === item ? "shield-checkmark" : "folder-outline"} size={20} color={activeVisit === item ? "#2563EB" : "#64748B"} style={{marginRight: 10}} />
                      <Text style={[styles.modalItemText, activeVisit === item && { color: '#2563EB', fontWeight: 'bold' }]}>{item}</Text>
                    </TouchableOpacity>
                  )}
                  ListEmptyComponent={<Text style={{ padding: 20, textAlign: 'center', color: '#94A3B8' }}>No existing visits found. Please create a new one.</Text>}
                />
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

const ActionButton = ({ icon, label, color, disabled, onPress }: any) => (
  <TouchableOpacity style={styles.actionBtn} disabled={disabled} onPress={onPress} activeOpacity={0.7}>
    <View style={[styles.actionIconWrap, { backgroundColor: `${color}15` }]}>
      <Ionicons name={icon} size={24} color={color} />
    </View>
    <Text style={styles.actionLabel}>{label}</Text>
  </TouchableOpacity>
);

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
        <Text style={[styles.obsSeverity, { color: getSeverityColor(obs.severity), backgroundColor: `${getSeverityColor(obs.severity)}15` }]}>
          {obs.severity || 'Unknown'} Severity
        </Text>
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
  projectTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A', marginBottom: 4, lineHeight: 24 },
  tenderNameText: { fontSize: 13, color: '#64748B', marginBottom: 20, fontStyle: 'italic', lineHeight: 18 },
  
  dataRow: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: '#F1F5F9', paddingBottom: 12, marginBottom: 12 },
  dataColumn: { flex: 1, paddingRight: 10 },
  dataLabel: { fontSize: 11, color: '#64748B', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  dataValue: { fontSize: 14, color: '#334155', fontWeight: '600' },
  
  scopeBox: { backgroundColor: '#F8FAFC', padding: 15, borderRadius: 8, marginTop: 5, borderWidth: 1, borderColor: '#E2E8F0' },
  scopeText: { fontSize: 13, color: '#475569', lineHeight: 22, marginTop: 4 },

  sectionTitle: { fontSize: 15, fontWeight: '800', color: '#0F172A', marginBottom: 12, marginLeft: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  subSectionTitle: { fontSize: 12, fontWeight: '700', color: '#64748B', marginBottom: 8, marginTop: 5, textTransform: 'uppercase' },

  visitContainer: { backgroundColor: '#FFF', padding: 16, borderRadius: 16, marginBottom: 25, borderWidth: 1, borderColor: '#E2E8F0' },
  visitControls: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 },
  visitBtn: { flexDirection: 'row', padding: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  activeVisitBox: { flexDirection: 'row', backgroundColor: '#DCFCE7', padding: 12, borderRadius: 8, alignItems: 'center', marginBottom: 15, borderWidth: 1, borderColor: '#BBF7D0' },
  activeVisitText: { color: '#166534', fontSize: 13, flex: 1 },
  noVisitText: { color: '#94A3B8', fontSize: 13, textAlign: 'center', marginBottom: 15, fontStyle: 'italic' },

  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between' },
  actionBtn: { width: '31%', backgroundColor: '#F8FAFC', padding: 12, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  actionIconWrap: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  actionLabel: { fontSize: 11, fontWeight: '600', color: '#475569', textAlign: 'center' },

  obsCard: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0', borderLeftWidth: 5, borderLeftColor: '#334155' },
  obsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  obsDate: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  obsSeverity: { fontSize: 11, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  obsCategory: { fontSize: 13, fontWeight: '700', color: '#1E293B', marginBottom: 6 },
  obsText: { fontSize: 14, color: '#475569', lineHeight: 22 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%', paddingBottom: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  modalItem: { flexDirection: 'row', padding: 18, borderBottomWidth: 1, borderColor: '#F1F5F9', alignItems: 'center' },
  modalItemText: { fontSize: 16, color: '#334155' }
});