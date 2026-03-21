import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { Stack } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import * as SplashScreen from 'expo-splash-screen';
import { syncStaticData } from '../utils/dbMigrator';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    async function initializeApp() {
      try {
        const db = await SQLite.openDatabaseAsync('civil_projects.db');
        await db.execAsync(`PRAGMA journal_mode = WAL;`);

        // 1. Ensure schema exists (Removed DROP TABLE to keep your seeded data safe)
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
          
          CREATE TABLE IF NOT EXISTS tenders (
            project_id TEXT, ulb TEXT, state TEXT, district TEXT, 
            project_type TEXT, project_title TEXT, tender_id TEXT, tender_name TEXT, 
            nit_date TEXT, award_date TEXT, bidder_name TEXT, capex TEXT, 
            onm TEXT, scope TEXT, physical_progress TEXT, financial_progress TEXT,
            PRIMARY KEY (project_id, tender_id)
          );
          
          CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT, project_code TEXT, state TEXT, 
            ulb TEXT, project_type TEXT, project_title TEXT, visit_date TEXT, 
            form_type TEXT, category TEXT, component TEXT, severity TEXT, observations TEXT
          );
        `);

        // 2. Check if the database has already been seeded
        let needsSync = false;
        try {
          const meta = await db.getFirstAsync<{value: string}>("SELECT value FROM metadata WHERE key = 'last_sync'");
          if (!meta) needsSync = true;
        } catch (e) {
          needsSync = true; // Table doesn't exist, we need to sync
        }

        // 3. Seed ONLY if it hasn't been done yet
        if (needsSync) {
          console.log("Seeding database for the first time...");
          await syncStaticData();
        } else {
          console.log("Database already seeded. Skipping CSV parsing.");
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

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}