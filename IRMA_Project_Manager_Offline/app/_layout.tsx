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

        // Create base tables if they don't exist
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

        // 🚀 FASTER STARTUP: Check if DB is already seeded to avoid massive re-parsing delays
        const isSeeded = await db.getFirstAsync<{value: string}>("SELECT value FROM metadata WHERE key = 'last_sync'");
        
        if (isSeeded && isSeeded.value) {
          console.log("Database already synced. Fast booting...");
          setIsReady(true);
          await SplashScreen.hideAsync();
          return;
        }

        // If not seeded, run the heavy migration
        console.log("First time setup: Syncing dataset...");
        await syncStaticData();
        
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
    <SQLite.SQLiteProvider databaseName="civil_projects.db">
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="project/[id]" options={{ presentation: 'card' }} />
      </Stack>
    </SQLite.SQLiteProvider>
  );
}