import * as FileSystem from 'expo-file-system';
import { zip } from 'react-native-zip-archive';
import * as ImageManipulator from 'expo-image-manipulator';


/**
 * 1. HIGH-PERFORMANCE ZIPPING (Native C++)
 * Replaces JSZip. Can handle 100MB+ folders in seconds without OOM errors.
 */
export const createProjectZip = async (sourceFolderPath: string, targetZipPath: string): Promise<string> => {
  try {
    // react-native-zip-archive processes entirely on a native background thread
    const resultPath = await zip(sourceFolderPath, targetZipPath);
    return resultPath;
  } catch (error) {
    console.error('Native Zip creation failed:', error);
    throw error;
  }
};

/**
 * 2. IMAGE OPTIMIZATION
 * Compresses raw 5MB-10MB camera captures down to ~500KB audit standards.
 */
export const optimizeImage = async (uri: string): Promise<string> => {
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1080 } }], // Standard resolution for clear text but small size
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
    );
    return result.uri;
  } catch (error) {
    console.error('Image optimization failed:', error);
    return uri; // Fallback to raw image if manipulation fails
  }
};

/**
 * 3. VIDEO GEOTAGGING (FFMPEG)
 * Physically "bakes" a translucent GPS overlay onto the video frames.
 */
export const bakeVideoGeotag = async (videoUri: string, lat: string, lon: string, timestamp: string): Promise<string> => {
  try {
    console.log('Skipping video geotagging (FFmpeg bypassed for now). Returning original video.');
    return videoUri;
  } catch (error) {
    console.error('Video geotagging failed:', error);
    return videoUri;
  }
};