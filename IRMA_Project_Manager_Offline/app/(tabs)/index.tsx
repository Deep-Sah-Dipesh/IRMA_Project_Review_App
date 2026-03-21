import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, ScrollView } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as DocumentPicker from 'expo-document-picker';
import * as XLSX from 'xlsx';
import * as FileSystem from 'expo-file-system/legacy';

export default function HomeScreen() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState({ monitoringDate: null as string | null, irmaDate: null as string | null });

  useEffect(() => { fetchImportStatus(); }, []);

  const fetchImportStatus = async () => {
    try {
      const db = await SQLite.openDatabaseAsync('civil_projects.db');
      const mRes = await db.getFirstAsync<{value: string}>("SELECT value FROM metadata WHERE key = 'monitoring_date'");
      const iRes = await db.getFirstAsync<{value: string}>("SELECT value FROM metadata WHERE key = 'irma_date'");
      setStatus({ monitoringDate: mRes?.value || null, irmaDate: iRes?.value || null });
    } catch (e) { console.error(e); }
  };

  // Critical fix for Android NullPointerException
  const toSqlSafe = (val: any): string => {
    if (val === undefined || val === null || val === "") return "";
    return String(val).trim();
  };

  const processExcel = async (uri: string, type: 'monitoring' | 'irma') => {
    try {
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      
      // Step 1: Fast Validation (Check structure without reading rows)
      const workbook = XLSX.read(b64, { type: 'base64', bookSheets: true });
      const sheetNames = workbook.SheetNames;

      if (type === 'monitoring' && (!sheetNames.includes('Tender Details') || !sheetNames.includes('Project Details'))) {
        throw new Error("Invalid File: Missing 'Tender Details' or 'Project Details' sheets.");
      }
      if (type === 'irma' && !sheetNames.includes('Major-Observation')) {
        throw new Error("Invalid File: Missing 'Major-Observation' sheet.");
      }

      // Step 2: Full Parse
      const fullWorkbook = XLSX.read(b64, { type: 'base64' });
      const db = await SQLite.openDatabaseAsync('civil_projects.db');

      if (type === 'monitoring') {
        const data = XLSX.utils.sheet_to_json(fullWorkbook.Sheets['Tender Details']) as any[];
        await db.withTransactionAsync(async () => {
          const stmt = await db.prepareAsync(`
            INSERT OR REPLACE INTO tenders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `);
          try {
            for (const r of data) {
              if (!r['Project ID']) continue;
              await stmt.executeAsync([
                toSqlSafe(r['Project ID']), toSqlSafe(r['ULB']), toSqlSafe(r['State']),
                toSqlSafe(r['District']), toSqlSafe(r['Project Type']), toSqlSafe(r['Project Title']),
                toSqlSafe(r['Tender ID']), toSqlSafe(r['Tender Name']), toSqlSafe(r['NIT Issued Date']),
                toSqlSafe(r['Contract Award Date']), toSqlSafe(r['Successful Bidder Name']),
                toSqlSafe(r['CAPEX (in Cr.)']), toSqlSafe(r['O&M (in CR.)']),
                toSqlSafe(r['Brief Scope of Work']), toSqlSafe(r['Physical Progress (in %)']),
                toSqlSafe(r['Financial Progress (in %)'])
              ]);
            }
          } finally { await stmt.finalizeAsync(); }
          await db.runAsync("INSERT OR REPLACE INTO metadata VALUES ('monitoring_date', datetime('now'))");
        });
      } else {
        const data = XLSX.utils.sheet_to_json(fullWorkbook.Sheets['Major-Observation']) as any[];
        await db.withTransactionAsync(async () => {
          await db.runAsync("DELETE FROM observations");
          const stmt = await db.prepareAsync(`
            INSERT INTO observations (project_code, state, ulb, project_type, project_title, visit_date, form_type, category, component, severity, observations) 
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `);
          try {
            for (const r of data) {
              if (!r['Project Code']) continue;
              await stmt.executeAsync([
                toSqlSafe(r['Project Code']), toSqlSafe(r['State']), toSqlSafe(r['ULB']),
                toSqlSafe(r['Project Type']), toSqlSafe(r['Project Title']), toSqlSafe(r['Date of Visit']),
                toSqlSafe(r['Form-Type']), toSqlSafe(r['Category']), toSqlSafe(r['Component']),
                toSqlSafe(r['Severity']), toSqlSafe(r['IRMA Major Observations'])
              ]);
            }
          } finally { await stmt.finalizeAsync(); }
          await db.runAsync("INSERT OR REPLACE INTO metadata VALUES ('irma_date', datetime('now'))");
        });
      }
      fetchImportStatus();
      Alert.alert("Success", "Data indexed successfully.");
    } catch (e: any) {
      Alert.alert("Import Error", e.message);
    } finally { setIsProcessing(false); }
  };

  const handleImport = async (type: 'monitoring' | 'irma') => {
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] });
    if (!res.canceled) {
      setIsProcessing(true);
      setTimeout(() => processExcel(res.assets[0].uri, type), 150);
    }
  };

  if (isProcessing) return (
    <View style={styles.center}><ActivityIndicator size="large" color="#2563EB" />
    <Text style={styles.loadingText}>Optimizing Database...</Text></View>
  );

  const isReady = status.monitoringDate && status.irmaDate;

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.header}>Data Initialization</Text>
      <Text style={styles.sub}>Import master files to unlock the dashboard.</Text>

      {[
        { label: 'Project Monitoring Form', date: status.monitoringDate, type: 'monitoring' as const },
        { label: 'IRMA Review Form', date: status.irmaDate, type: 'irma' as const }
      ].map((item, idx) => (
        <View key={idx} style={styles.card}>
          <Text style={styles.cardTitle}>{item.label}</Text>
          <Text style={[styles.status, { color: item.date ? '#166534' : '#991B1B' }]}>
            {item.date ? `✓ Updated: ${item.date}` : '✗ Missing'}
          </Text>
          <TouchableOpacity style={styles.btn} onPress={() => handleImport(item.type)}>
            <Text style={styles.btnText}>Import Excel</Text>
          </TouchableOpacity>
        </View>
      ))}

      <TouchableOpacity style={[styles.mainBtn, !isReady && { opacity: 0.5 }]} disabled={!isReady}>
        <Text style={styles.mainBtnText}>Continue to Dashboard</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC', padding: 20, paddingTop: 60 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { fontSize: 24, fontWeight: '800', color: '#1E293B' },
  sub: { fontSize: 14, color: '#64748B', marginBottom: 20 },
  loadingText: { marginTop: 10, fontWeight: '600' },
  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, marginBottom: 15, borderWidth: 1, borderColor: '#E2E8F0' },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  status: { fontSize: 12, marginVertical: 5, fontWeight: '600' },
  btn: { backgroundColor: '#EFF6FF', padding: 10, borderRadius: 8, alignItems: 'center', marginTop: 10 },
  btnText: { color: '#2563EB', fontWeight: '700' },
  mainBtn: { backgroundColor: '#2563EB', padding: 18, borderRadius: 10, alignItems: 'center', marginTop: 10 },
  mainBtnText: { color: '#FFF', fontWeight: '800', fontSize: 16 }
});