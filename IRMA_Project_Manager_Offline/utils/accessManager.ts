import { doc, getDoc, setDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from './firebaseConfig'; 

export type AccessStatus = 'allowed' | 'inactive' | 'device_mismatch' | 'not_found';

export const verifyUserAccess = async (userId: string, currentDeviceId: string): Promise<AccessStatus> => {
  try {
    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) return 'not_found';

    const userData = userSnap.data();

    // 1. Admin Kill Switch Check
    if (userData.isActive === false) return 'inactive';

    // 2. Multi-Device / Single-Device Check
    const activeDevices: string[] = userData.activeDeviceIds || [];
    
    // If their device isn't in the active list, it's a mismatch
    if (!activeDevices.includes(currentDeviceId)) {
      return 'device_mismatch';
    }

    return 'allowed';
  } catch (error) {
    console.error("Error verifying access:", error);
    return 'not_found';
  }
};

export const registerDeviceToUser = async (userId: string, newDeviceId: string): Promise<boolean> => {
  try {
    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);
    
    if (!userSnap.exists()) return false;
    
    const userData = userSnap.data();

    if (userData.multiAccess === true) {
      // If Admin allowed multi-access, append the new device to the list
      await updateDoc(userRef, {
        activeDeviceIds: arrayUnion(newDeviceId),
        lastLogin: new Date().toISOString()
      });
    } else {
      // DEFAULT: Single-access. Overwrite the array with ONLY the new device.
      // This immediately locks out the old device on its next app launch.
      await updateDoc(userRef, {
        activeDeviceIds: [newDeviceId],
        lastLogin: new Date().toISOString()
      });
    }
    return true;
  } catch (error) {
    console.error("Failed to register new device:", error);
    return false;
  }
};