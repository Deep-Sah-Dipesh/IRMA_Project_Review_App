import * as FileSystem from 'expo-file-system/legacy';

export const DB_NAME = "mainDataBase_20260425.db";
const FIREBASE_DB_URL = "https://firebasestorage.googleapis.com/v0/b/irma-project-manager-2k26.firebasestorage.app/o/Database%2FmainDataBase_20260425.db?alt=media";

export const downloadAndInitDatabase = async (
  onProgress: (progress: number) => void,
  maxRetries: number = 3
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

      const fileInfo = await FileSystem.getInfoAsync(targetDbPath);
      if (fileInfo.exists) {
        onProgress(1);
        return true;
      }

      const downloadResumable = FileSystem.createDownloadResumable(
        FIREBASE_DB_URL,
        tempDbPath,
        {},
        (downloadProgress) => {
          const progress = downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite;
          onProgress(progress * 0.9);
        }
      );

      const result = await downloadResumable.downloadAsync();
      
      if (result && result.status === 200) {
        await FileSystem.moveAsync({ from: tempDbPath, to: targetDbPath });
        onProgress(1);
        return true;
      } else {
        // --- DIAGNOSTIC LOGGING START ---
        const statusCode = result?.status || 'Unknown';
        console.error(`[Attempt ${attempt}] Download failed with status:`, statusCode);
        
        let firebaseErrorDetail = "No additional details.";
        
        try {
          // If status !== 200, Firebase writes the error JSON to the file stream
          const errorBody = await FileSystem.readAsStringAsync(tempDbPath);
          firebaseErrorDetail = errorBody;
          console.error(`[Attempt ${attempt}] Firebase Error Response:`, errorBody);
        } catch (readErr) {
          console.error("Could not read error body from temp file.");
        }
        // --- DIAGNOSTIC LOGGING END ---

        await FileSystem.deleteAsync(tempDbPath, { idempotent: true });
        throw new Error(`Failed to secure database payload. HTTP ${statusCode} - ${firebaseErrorDetail}`);
      }

    } catch (error) {
      console.error(`Database sync attempt ${attempt} failed:`, error);
      
      if (attempt === maxRetries) {
        return false;
      }
      
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