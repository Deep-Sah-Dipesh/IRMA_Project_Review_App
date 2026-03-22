import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import * as SplashScreen from 'expo-splash-screen';
import * as FileSystem from 'expo-file-system/legacy';
import { syncStaticData } from '../utils/dbMigrator';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  const initializeApp = async () => {
    let dbInstance: SQLite.SQLiteDatabase | null = null;
    
    try {
      setIsRetrying(true);
      setInitError(null);
      
      // Open primary connection
      dbInstance = await SQLite.openDatabaseAsync('civil_projects.db');
      
      // High busy_timeout prevents "database is locked" during concurrent native reads
      await dbInstance.execAsync(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;`);

      await dbInstance.execAsync(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
      `);

      // Check if DB was already completely and successfully seeded
      const isSeeded = await dbInstance.getFirstAsync<{value: string}>("SELECT value FROM metadata WHERE key = 'last_sync_v2'");
      
      if (isSeeded && isSeeded.value) {
        console.log("Database already synced. Fast booting...");
        setIsReady(true);
        await SplashScreen.hideAsync();
        return dbInstance;
      }

      console.log("Applying Data Sanitization Update...");
      
      // Pass the active DB connection to the migrator to prevent lock conflicts
      await syncStaticData(dbInstance);
      
      setIsReady(true);
      await SplashScreen.hideAsync();
      return dbInstance;
      
    } catch (e: any) {
      console.error("Init Error:", e);
      setInitError(e.message);
      await SplashScreen.hideAsync();
      return dbInstance;
    } finally {
      setIsRetrying(false);
    }
  };

  useEffect(() => {
    let db: SQLite.SQLiteDatabase | null = null;
    
    initializeApp().then(instance => {
      db = instance;
    });

    // CRITICAL FIX: On Hot Reload, the component unmounts.
    // We MUST force the native DB to close, otherwise dangling NativeStatements lock the DB file forever.
    return () => {
      if (db) {
        console.log("Hot Reload detected. Closing DB to release locks...");
        db.closeAsync().catch(() => {});
      }
    };
  }, []);

  const handleForceReset = async () => {
    try {
      setIsRetrying(true);
      // Hard wipe the SQLite files to clear any irreversible OS-level ghost locks
      const dbPath = `${FileSystem.documentDirectory}SQLite/civil_projects.db`;
      await FileSystem.deleteAsync(dbPath, { idempotent: true });
      await FileSystem.deleteAsync(`${dbPath}-wal`, { idempotent: true });
      await FileSystem.deleteAsync(`${dbPath}-shm`, { idempotent: true });
      
      console.log("Database wiped. Restarting initialization...");
      await initializeApp();
    } catch (e) {
      Alert.alert("Reset Failed", "Could not delete database file.");
      setIsRetrying(false);
    }
  };

  if (initError) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: '#F8FAFC' }}>
        <View style={{ backgroundColor: '#FEE2E2', padding: 20, borderRadius: 12, alignItems: 'center', width: '100%' }}>
           <Text style={{ color: '#EF4444', fontWeight: '900', fontSize: 18, marginBottom: 10 }}>Database Locked</Text>
           <Text style={{ textAlign: 'center', color: '#7F1D1D', marginBottom: 20, fontSize: 13 }}>
             An incomplete background process locked the database.\nError: {initError}
           </Text>
           
           <TouchableOpacity 
             onPress={handleForceReset} 
             disabled={isRetrying}
             style={{ backgroundColor: '#EF4444', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center' }}
           >
             {isRetrying ? <ActivityIndicator color="#FFF" style={{ marginRight: 10 }} /> : null}
             <Text style={{ color: '#FFF', fontWeight: 'bold' }}>{isRetrying ? "Rebuilding..." : "Wipe & Rebuild Database"}</Text>
           </TouchableOpacity>
        </View>
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