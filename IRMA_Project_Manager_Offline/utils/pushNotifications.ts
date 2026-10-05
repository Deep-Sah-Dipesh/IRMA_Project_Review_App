import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from './firebaseConfig';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export const registerAndSavePushToken = async (userId: string): Promise<string | null> => {
  if (!Device.isDevice) {
    console.log('Must use physical device for Push Notifications');
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('Failed to get push token for push notification!');
    return null;
  }

  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
    
    if (!projectId) {
       console.warn('Project ID not found. Ensure app.json has eas.projectId configured.');
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData?.data;

    if (token && userId) {
      await updateDoc(doc(db, 'users', userId), { 
        pushToken: token,
        updatedAt: new Date()
      });
    }

    return token || null;
  } catch (error: any) {
    const errMessage = error?.message || String(error);
    if (errMessage.includes('FIS_AUTH_ERROR')) {
      console.warn('[PushNotifications] Push token retrieval skipped (FIS_AUTH_ERROR: Firebase Installations API restricted or not enabled on Google Cloud key). Offline & dev mode continuing normally.');
    } else {
      console.warn('[PushNotifications] Could not retrieve push token:', errMessage);
    }
    return null;
  }
};

export const sendTestNotification = async (expoPushToken: string) => {
  const message = {
    to: expoPushToken,
    sound: 'default',
    title: 'Test Notification 🚀',
    body: 'This is a test notification to verify your setup!',
    data: { testData: 'Verification successful' },
  };

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });
    
    return await response.json();
  } catch (error) {
    console.error('Failed to send test notification:', error);
    throw error;
  }
};