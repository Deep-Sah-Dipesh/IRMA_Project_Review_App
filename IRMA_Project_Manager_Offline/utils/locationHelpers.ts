// Fix: Prevent the same crash on KML scanning by using legacy API
import * as FileSystem from 'expo-file-system/legacy';
import * as Linking from 'expo-linking';
import { Alert } from 'react-native';

export const openGoogleMaps = (lat: string, lng: string) => {
  if (!lat || !lng || lat.trim() === '' || lng.trim() === '') {
    Alert.alert("Location Unavailable", "No GPS coordinates are mapped for this project.");
    return;
  }
  const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  Linking.openURL(url).catch(err => {
    console.error("Failed to open maps", err);
    Alert.alert("Error", "Could not open the mapping application.");
  });
};

export const shareLocalKml = async (projectId: string, tenderId: string) => {
  try {
    const safeId = String(projectId).replace(/[\/\\]/g, '-');
    const safeTender = String(tenderId || 'NoTender').replace(/[\/\\]/g, '-');
    const folderName = `${safeId}_${safeTender}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = FileSystem.documentDirectory + folderName + '/';
    
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
        Alert.alert("Not Found", "No local Visit Report found for this project.");
        return;
    }

    const files = await FileSystem.readDirectoryAsync(dir);
    const kmlFile = files.find(f => f.toLowerCase().endsWith('.kml'));
    
    if (kmlFile) {
        const uri = dir + kmlFile;
        const content = await FileSystem.readAsStringAsync(uri);
        const coordMatch = content.match(/<coordinates>([^,]+),([^,]+)/);
        
        if (coordMatch) {
            const url = `https://maps.google.com/?q=${coordMatch[2]},${coordMatch[1]}`;
            Linking.openURL(url).catch(() => Alert.alert("Error", "Could not open Maps."));
        } else {
            Alert.alert("Invalid Data", "Could not extract coordinates from the verified KML pin.");
        }
    } else {
        Alert.alert("Not Found", "No KML file was generated in this Visit Report.");
    }
  } catch (error) {
    console.error("Error opening KML:", error);
    Alert.alert("Error", "Could not process local files.");
  }
};

export const getProjectsWithLocalKmls = async (): Promise<Set<string>> => {
    const kmlSet = new Set<string>();
    try {
        const baseDir = FileSystem.documentDirectory;
        if (!baseDir) return kmlSet;
        const folders = await FileSystem.readDirectoryAsync(baseDir);
        
        for (const folder of folders) {
            if (folder === 'SQLite') continue;
            const folderPath = baseDir + folder + '/';
            const info = await FileSystem.getInfoAsync(folderPath);
            if (info.isDirectory) {
                const files = await FileSystem.readDirectoryAsync(folderPath);
                if (files.some(f => f.toLowerCase().endsWith('.kml'))) {
                    kmlSet.add(folder); 
                }
            }
        }
    } catch(e) { console.error("Error scanning KMLs:", e); }
    return kmlSet;
}