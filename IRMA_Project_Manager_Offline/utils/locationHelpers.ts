import * as FileSystem from 'expo-file-system/legacy';
import * as Linking from 'expo-linking';
import { Alert } from 'react-native';

export const openGoogleMaps = (lat: string, lng: string) => {
  if (!lat || !lng || lat.trim() === '' || lng.trim() === '') {
    Alert.alert("Location Unavailable", "No GPS coordinates are mapped for this project.");
    return;
  }
  const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  Linking.openURL(url).catch(() => Alert.alert("Error", "Could not open the mapping application."));
};

export const shareLocalKml = async (projectId: string, tenderId: string) => {
  try {
    const safeId = String(projectId).replace(/[\/\\]/g, '-');
    const safeTender = String(tenderId || 'NoTender').replace(/[\/\\]/g, '-');
    const folderName = `${safeId}_${safeTender}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const projDir = FileSystem.documentDirectory + 'projects/' + folderName + '/';
    
    const dirInfo = await FileSystem.getInfoAsync(projDir);
    if (!dirInfo.exists) return Alert.alert("Not Found", "No local Visit Report found.");

    // Deep scan inside VISIT_ folders to find the actual KML file
    const visits = await FileSystem.readDirectoryAsync(projDir);
    let targetKmlUri = '';

    for (const v of visits.sort().reverse()) {
        if (v.startsWith('VISIT_')) {
            const visitPath = projDir + v + '/';
            const files = await FileSystem.readDirectoryAsync(visitPath);
            const kmlFile = files.find(f => f.toLowerCase().endsWith('.kml'));
            if (kmlFile) {
                targetKmlUri = visitPath + kmlFile;
                break;
            }
        }
    }
    
    if (targetKmlUri) {
        const content = await FileSystem.readAsStringAsync(targetKmlUri);
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
    Alert.alert("Error", "Could not process local files.");
  }
};

export const getProjectsWithLocalKmls = async (): Promise<Set<string>> => {
    const kmlSet = new Set<string>();
    try {
        const baseDir = FileSystem.documentDirectory + 'projects/';
        const folders = await FileSystem.readDirectoryAsync(baseDir).catch(()=>[]);
        
        for (const folder of folders) {
            const projDir = baseDir + folder + '/';
            const info = await FileSystem.getInfoAsync(projDir);
            if (info.isDirectory) {
                const visits = await FileSystem.readDirectoryAsync(projDir);
                for (const v of visits) {
                    if (v.startsWith('VISIT_')) {
                        const files = await FileSystem.readDirectoryAsync(projDir + v + '/');
                        if (files.some(f => f.toLowerCase().endsWith('.kml'))) {
                            kmlSet.add(folder); 
                            break; // Move to next project once found
                        }
                    }
                }
            }
        }
    } catch(e) {}
    return kmlSet;
}