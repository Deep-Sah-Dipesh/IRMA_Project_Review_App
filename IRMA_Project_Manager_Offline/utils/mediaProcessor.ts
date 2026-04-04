import * as FileSystem from 'expo-file-system';
import { zip } from 'react-native-zip-archive';
import * as ImageManipulator from 'expo-image-manipulator';
import { FFmpegKit, ReturnCode } from 'ffmpeg-kit-react-native';

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
    const outputUri = `${FileSystem.cacheDirectory}geotagged_vid_${Date.now()}.mp4`;
    
    // FFmpeg drawtext filter syntax requires colons inside the text to be strictly escaped
    const safeTimestamp = timestamp.replace(/:/g, '\\:');
    const watermarkText = `Lat: ${lat}   Lon: ${lon}   Date: ${safeTimestamp}`;

    // FFmpeg Command Breakdown:
    // -i : Input file
    // -vf : Video Filter (drawtext for watermark, box for background)
    // -c:v libx264 : Explicitly use x264 encoder (Required when using -vf)
    // -preset ultrafast : Crucial for mobile devices to prevent CPU freezing
    // -crf 28 : Constant Rate Factor (Controls quality/size ratio. 28 is highly compressed but acceptable for audits)
    // -c:a copy : Copies original audio stream without re-encoding
    const command = `-i ${videoUri} -vf "drawtext=text='${watermarkText}':x=30:y=H-th-30:fontcolor=white:fontsize=36:box=1:boxcolor=black@0.6:boxborderw=15" -c:v libx264 -preset ultrafast -crf 28 -c:a copy ${outputUri}`;

    const session = await FFmpegKit.execute(command);
    const returnCode = await session.getReturnCode();

    if (ReturnCode.isSuccess(returnCode)) {
      return outputUri;
    } else {
      console.error('FFmpeg rendering failed. Return code:', returnCode);
      return videoUri; // Fallback to raw video so data isn't lost
    }
  } catch (error) {
    console.error('Video geotagging failed:', error);
    return videoUri;
  }
};