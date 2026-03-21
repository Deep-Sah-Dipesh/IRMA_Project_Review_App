import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { Stack } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import * as SplashScreen from 'expo-splash-screen';
import * as FileSystem from 'expo-file-system/legacy';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function initializeApp() {
      try {
        const db = await SQLite.openDatabaseAsync('civil_projects.db');
        
        // Initialize tables in a single batch
        await db.execAsync(`
          PRAGMA journal_mode = WAL;
          
          CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT
          );

          CREATE TABLE IF NOT EXISTS tenders (
            project_id TEXT PRIMARY KEY,
            ulb TEXT, state TEXT, district TEXT, project_type TEXT, 
            project_title TEXT, tender_id TEXT, tender_name TEXT, 
            nit_date TEXT, award_date TEXT, bidder_name TEXT, 
            capex TEXT, onm TEXT, scope TEXT, 
            physical_progress TEXT, financial_progress TEXT
          );

          CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_code TEXT, state TEXT, ulb TEXT, project_type TEXT, 
            project_title TEXT, visit_date TEXT, form_type TEXT, 
            category TEXT, component TEXT, severity TEXT, 
            observations TEXT
          );
        `);

        const baseDir = `${FileSystem.documentDirectory}projects/`;
        const dirInfo = await FileSystem.getInfoAsync(baseDir);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(baseDir, { intermediates: true });
        }

        setIsReady(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        await SplashScreen.hideAsync();
      }
    }
    initializeApp();
  }, []);

  if (error) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <Text style={{ color: 'red', fontWeight: 'bold' }}>System Error</Text>
        <Text style={{ textAlign: 'center', marginTop: 10 }}>{error}</Text>
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