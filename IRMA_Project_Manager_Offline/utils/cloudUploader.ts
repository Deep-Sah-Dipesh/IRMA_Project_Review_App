import * as FileSystem from 'expo-file-system/legacy';
import { zip } from 'react-native-zip-archive';

const FIREBASE_BUCKET = 'irma-project-manager-offline.firebasestorage.app'; 
const SYNC_CACHE_FILE = `${FileSystem.documentDirectory}cloud_sync_cache.json`;

const sanitizeNativePath = (path: string) => {
  let cleanPath = path.replace('file://', '');
  try { cleanPath = decodeURIComponent(cleanPath); } catch (e) {}
  return cleanPath;
};

const secureEmptyDirectories = async (dirPath: string) => {
  if (typeof dirPath !== 'string') return;
  const normalizedPath = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  const files = await FileSystem.readDirectoryAsync(normalizedPath);
  
  if (files.length === 0) {
    await FileSystem.writeAsStringAsync(`${normalizedPath}.keep`, 'keep');
    return;
  }
  
  for (const file of files) {
    const fullPath = `${normalizedPath}${file}`;
    const info = await FileSystem.getInfoAsync(fullPath);
    if (info.isDirectory) {
      await secureEmptyDirectories(fullPath);
    }
  }
};

const getSyncCache = async () => {
  try {
    const info = await FileSystem.getInfoAsync(SYNC_CACHE_FILE);
    if (info.exists) {
      const data = await FileSystem.readAsStringAsync(SYNC_CACHE_FILE);
      return JSON.parse(data);
    }
  } catch (e) {}
  return {};
};

const updateSyncCache = async (exportKey: string, meta: any, url: string) => {
  const cache = await getSyncCache();
  cache[exportKey] = { ...meta, url };
  await FileSystem.writeAsStringAsync(SYNC_CACHE_FILE, JSON.stringify(cache));
};

export const generateCloudLinkAndUpload = async (
  exportName: string,
  sourceFolderPath: string,
  currentMeta: { totalFiles: number, totalSize: number, maxModTime: number }
): Promise<{ expectedUrl: string, startBackgroundUpload: () => Promise<void>, isCached: boolean }> => {
  
  const zipFileName = `${exportName}.zip`;
  const targetZipPath = `${FileSystem.cacheDirectory}${zipFileName}`;
  const firebaseStoragePath = `exports/${zipFileName}`;
  const encodedPath = encodeURIComponent(firebaseStoragePath);
  
  const expectedUrl = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_BUCKET}/o/${encodedPath}?alt=media&token=${Date.now()}`;
  const uploadEndpoint = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_BUCKET}/o?name=${encodedPath}`;

  const cache = await getSyncCache();
  const cachedData = cache[exportName];
  
  if (cachedData && 
      cachedData.totalFiles === currentMeta.totalFiles && 
      cachedData.totalSize === currentMeta.totalSize && 
      cachedData.maxModTime === currentMeta.maxModTime) {
      console.log('Cache Hit: No changes detected. Skipping zip and upload.');
      return { expectedUrl: cachedData.url, startBackgroundUpload: async () => {}, isCached: true };
  }

  const startBackgroundUpload = async () => {
    try {
      console.log('Securing directories and generating ZIP archive...');
      await secureEmptyDirectories(sourceFolderPath);
      const cleanSource = sanitizeNativePath(sourceFolderPath);
      const cleanTarget = sanitizeNativePath(targetZipPath);
      await zip(cleanSource, cleanTarget);
      
      // IMPLEMENTATION: Robust 3-Attempt Retry Loop for spotty connections
      const MAX_RETRIES = 3;
      let uploadSuccess = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          console.log(`Uploading to Firebase (Attempt ${attempt}/${MAX_RETRIES})...`);
          const uploadTask = FileSystem.createUploadTask(
            uploadEndpoint,
            targetZipPath,
            {
              httpMethod: 'POST',
              uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
              headers: { 'Content-Type': 'application/zip' }
            }
          );

          await uploadTask.uploadAsync();
          uploadSuccess = true;
          break; // Exit loop on success
        } catch (uploadError: any) {
          console.log(`Attempt ${attempt} Failed: ${uploadError.message}`);
          if (attempt === MAX_RETRIES) throw uploadError;
          // Exponential backoff: Wait 2s, then 4s before retrying
          await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        }
      }

      if (uploadSuccess) {
        console.log('Upload complete. Updating local cache.');
        await updateSyncCache(exportName, currentMeta, expectedUrl);
      }
      
      // Always cleanup local zip file to save storage
      await FileSystem.deleteAsync(targetZipPath, { idempotent: true });

    } catch (error) {
      console.error('Final Background Upload Failure:', error);
      // Failsafe cleanup in case of catastrophic error
      await FileSystem.deleteAsync(targetZipPath, { idempotent: true }).catch(() => {});
    }
  };

  return { expectedUrl, startBackgroundUpload, isCached: false };
};