import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { Stack } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import * as SplashScreen from 'expo-splash-screen';
import { syncStaticData, getExpectedCounts } from '../utils/dbMigrator';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    async function initializeApp() {
      try {
        const db = await SQLite.openDatabaseAsync('civil_projects.db');
        await db.execAsync(`PRAGMA journal_mode = WAL;`);

        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
          
          CREATE TABLE IF NOT EXISTS tenders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT, ulb TEXT, state TEXT, district TEXT, 
            project_type TEXT, project_title TEXT, tender_id TEXT, tender_name TEXT, 
            nit_date TEXT, award_date TEXT, bidder_name TEXT, capex TEXT, 
            onm TEXT, scope TEXT, physical_progress TEXT, financial_progress TEXT
          );
          
          CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT, project_code TEXT, state TEXT, 
            ulb TEXT, project_type TEXT, project_title TEXT, visit_date TEXT, 
            form_type TEXT, category TEXT, component TEXT, severity TEXT, observations TEXT
          );
        `);

        const expected = getExpectedCounts();
        
        let actualTenders = 0;
        let actualObs = 0;
        
        try {
          const tCount = await db.getFirstAsync<{c: number}>("SELECT COUNT(*) as c FROM tenders");
          const oCount = await db.getFirstAsync<{c: number}>("SELECT COUNT(*) as c FROM observations");
          actualTenders = tCount?.c || 0;
          actualObs = oCount?.c || 0;
        } catch (e) {
          // Ignore
        }

        if (actualTenders !== expected.tenders || actualObs !== expected.observations) {
          console.log(`Dataset Mismatch! Expected ${expected.tenders} projects, found ${actualTenders}. Resyncing...`);
          await syncStaticData();
        } else {
          console.log(`Database Verified: 100% Match. Loaded ${actualTenders} projects and ${actualObs} observations.`);
        }

        setIsReady(true);
      } catch (e: any) {
        console.error("Init Error:", e);
        setInitError(e.message);
      } finally {
        await SplashScreen.hideAsync();
      }
    }
    initializeApp();
  }, []);

  if (initError) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <Text style={{ color: 'red', fontWeight: 'bold', fontSize: 18 }}>Database Setup Failed</Text>
        <Text style={{ textAlign: 'center', marginTop: 10 }}>{initError}</Text>
      </View>
    );
  }

  if (!isReady) return null;

  // CRITICAL FIX: Wrapping the app in SQLiteProvider prevents connection drops during navigation
  return (
    <SQLite.SQLiteProvider databaseName="civil_projects.db">
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="project/[id]" options={{ presentation: 'card' }} />
      </Stack>
    </SQLite.SQLiteProvider>
  );
}