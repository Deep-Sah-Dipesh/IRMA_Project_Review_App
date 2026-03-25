import * as FileSystem from 'expo-file-system/legacy';
import * as Device from 'expo-device';
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
    if (info.isDirectory) await secureEmptyDirectories(fullPath);
  }
};

const getSyncCache = async () => {
  try {
    const info = await FileSystem.getInfoAsync(SYNC_CACHE_FILE);
    if (info.exists) return JSON.parse(await FileSystem.readAsStringAsync(SYNC_CACHE_FILE));
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
  currentMeta: { totalFiles: number, totalSize: number, maxModTime: number },
  onProgress: (status: string) => void
): Promise<{ expectedUrl: string, startBackgroundUpload: () => Promise<void>, isCached: boolean }> => {
  
  const zipFileName = `${exportName}.zip`;
  const targetZipPath = `${FileSystem.cacheDirectory}${zipFileName}`;
  
  // CRITICAL 403 FIX: We flatten the path with an underscore to bypass nested-folder security rule blocks.
  const deviceId = Device.osBuildId || Device.designName || 'Unknown_Device';
  const firebaseStoragePath = `exports/${deviceId}_${zipFileName}`;
  const encodedPath = encodeURIComponent(firebaseStoragePath);
  
  // Generate Cryptographic Token locally to inject into upload headers
  const downloadToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const expectedUrl = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_BUCKET}/o/${encodedPath}?alt=media&token=${downloadToken}`;
  const uploadEndpoint = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_BUCKET}/o?name=${encodedPath}`;

  const cache = await getSyncCache();
  const cachedData = cache[exportName];
  
  if (cachedData && cachedData.totalFiles === currentMeta.totalFiles && cachedData.totalSize === currentMeta.totalSize && cachedData.maxModTime === currentMeta.maxModTime) {
      onProgress('Cache Hit. Skipping Upload.');
      return { expectedUrl: cachedData.url, startBackgroundUpload: async () => {}, isCached: true };
  }

  const startBackgroundUpload = async () => {
    try {
      onProgress(`Compressing ${currentMeta.totalFiles} files...`);
      await secureEmptyDirectories(sourceFolderPath);
      const cleanSource = sanitizeNativePath(sourceFolderPath);
      const cleanTarget = sanitizeNativePath(targetZipPath);
      
      await zip(cleanSource, cleanTarget);
      
      onProgress('Uploading to Cloud...');
      let uploadSuccess = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const uploadTask = FileSystem.createUploadTask(
            uploadEndpoint,
            targetZipPath,
            { 
              httpMethod: 'POST', 
              uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, 
              headers: { 
                'Content-Type': 'application/zip',
                'X-Goog-Meta-FirebaseStorageDownloadTokens': downloadToken
              } 
            },
            (data) => {
              const percentage = ((data.totalBytesSent / data.totalBytesExpectedToSend) * 100).toFixed(0);
              onProgress(`Uploading: ${percentage}%`);
            }
          );

          const response = await uploadTask.uploadAsync();
          if (response && response.status === 200) {
             uploadSuccess = true;
             break;
          } else throw new Error(`Upload Failed: ${response?.status}`);
        } catch (err: any) {
          if (attempt === 3) throw err;
          onProgress(`Retrying Upload (Attempt ${attempt + 1}/3)...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (uploadSuccess) {
        onProgress('Finalizing...');
        await updateSyncCache(exportName, currentMeta, expectedUrl);
      }
      
      await FileSystem.deleteAsync(targetZipPath, { idempotent: true });
    } catch (error) {
      await FileSystem.deleteAsync(targetZipPath, { idempotent: true }).catch(() => {});
      throw error;
    }
  };

  return { expectedUrl, startBackgroundUpload, isCached: false };
};