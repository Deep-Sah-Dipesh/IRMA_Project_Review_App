import { StyleSheet, Platform } from 'react-native';

export const globalStyles = StyleSheet.create({
  // Base Layouts
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  darkContainer: { flex: 1, backgroundColor: '#0F172A' },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  scrollContent: { padding: 16, paddingBottom: 100 },

  // Cards
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 12, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4, borderWidth: 1, borderColor: '#E2E8F0' },
  darkCard: { backgroundColor: '#1E293B', padding: 25, borderRadius: 16, elevation: 10, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10 },
  infoCard: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0' },

  // Typography
  title: { fontSize: 24, fontWeight: 'bold', color: '#FFF', textAlign: 'center', marginBottom: 25 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#1E293B', marginBottom: 6 },
  cardSubtitle: { fontSize: 13, color: '#475569', fontWeight: '600', marginBottom: 4 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: '#1E293B', marginBottom: 12 },
  textMuted: { color: '#64748B', fontSize: 12, fontWeight: '500' },
  
  // Inputs & Controls
  input: { backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: '#CBD5E1', padding: 15, borderRadius: 12, fontSize: 16, marginBottom: 15, color: '#1E293B' },
  searchBar: { flex: 1, height: 45, backgroundColor: '#FFF', borderRadius: 8, paddingHorizontal: 15, fontSize: 15, elevation: 2, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 2, borderWidth: 1, borderColor: '#E2E8F0' },
  
  // Buttons
  primaryBtn: { backgroundColor: '#3B82F6', padding: 15, borderRadius: 10, alignItems: 'center', marginTop: 10 },
  primaryBtnText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  linkText: { color: '#94A3B8', fontSize: 14 },
  fab: { position: 'absolute', bottom: 30, right: 20, backgroundColor: '#2563EB', width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center', elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 3 },
  
  // Custom Locate Buttons
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  locateYellowBtn: { flex: 1, flexDirection: 'row', backgroundColor: '#EAB308', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center', elevation: 2 },
  locateGreenBtn: { flex: 1, flexDirection: 'row', backgroundColor: '#10B981', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center', elevation: 2 },
  locateBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13, marginLeft: 6 },
  pinBtnRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 10, width: '100%' },
  pinBtnHalf: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 9, paddingHorizontal: 10, borderRadius: 8, elevation: 2 },
  pinBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },

  // Badges & Details
  progressBadge: { backgroundColor: '#DBEAFE', color: '#1D4ED8', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, fontSize: 12, fontWeight: '800', overflow: 'hidden' },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  detailLabel: { fontSize: 13, color: '#64748B', flex: 1 },
  detailValue: { fontSize: 13, fontWeight: '700', color: '#1E293B', flex: 1.5, textAlign: 'right' },

  // Loading States
  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 100 }
});