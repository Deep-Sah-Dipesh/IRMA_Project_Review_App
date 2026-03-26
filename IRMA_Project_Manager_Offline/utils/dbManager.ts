// Fix: Use the legacy import path required by Expo SDK 54+
import * as FileSystem from 'expo-file-system/legacy';

export const DB_NAME = "mainDataBase_26032026.db";
const FIREBASE_DB_URL = "https://firebasestorage.googleapis.com/v0/b/irma-project-manager-offline.firebasestorage.app/o/Database%2FmainDataBase_26032026.db?alt=media";

export const downloadAndInitDatabase = async (
  onProgress: (progress: number) => void,
  maxRetries: number = 3 // Built-in background retry limit
): Promise<boolean> => {
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const dbDir = FileSystem.documentDirectory + 'SQLite/';
      const targetDbPath = dbDir + DB_NAME;
      const tempDbPath = FileSystem.cacheDirectory + 'temp_' + DB_NAME;

      const dirInfo = await FileSystem.getInfoAsync(dbDir);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(dbDir, { intermediates: true });
      }

      // Check if DB already exists locally
      const fileInfo = await FileSystem.getInfoAsync(targetDbPath);
      if (fileInfo.exists) {
        onProgress(1);
        return true;
      }

      // Start the download resumable stream
      const downloadResumable = FileSystem.createDownloadResumable(
        FIREBASE_DB_URL,
        tempDbPath,
        {},
        (downloadProgress) => {
          const progress = downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite;
          onProgress(progress * 0.9); // Cap at 90% until move is complete
        }
      );

      const result = await downloadResumable.downloadAsync();
      
      if (result && result.status === 200) {
        await FileSystem.moveAsync({ from: tempDbPath, to: targetDbPath });
        onProgress(1);
        return true;
      } else {
        await FileSystem.deleteAsync(tempDbPath, { idempotent: true });
        throw new Error("Failed to secure database payload.");
      }

    } catch (error) {
      console.error(`Database sync attempt ${attempt} failed:`, error);
      
      if (attempt === maxRetries) {
        return false; // Exhausted all retries
      }
      
      // Exponential backoff: Wait before trying again in the background (2s, 4s...)
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }
  
  return false;
};

export const wipeSecureDatabase = async () => {
  try {
    const dbPath = FileSystem.documentDirectory + 'SQLite/' + DB_NAME;
    await FileSystem.deleteAsync(dbPath, { idempotent: true });
  } catch (error) {
    console.error("Failed to wipe database:", error);
  }
};