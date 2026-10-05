/**
 * userSession.ts
 * ──────────────
 * Module-level session cache that eliminates repeated Firestore getDoc calls
 * on every tab focus. The userId / username are fetched once per app session
 * and reused for every subsequent call. Call clearUserCache() on logout.
 */
import * as SecureStore from 'expo-secure-store';
import { doc, getDoc } from 'firebase/firestore';
import { db as firestoreDb } from './firebaseConfig';

let _cachedUserId: string | null = null;
let _cachedUsername: string | null = null;

/** Reset cached values (call on logout or account switch) */
export const clearUserCache = () => {
  _cachedUserId = null;
  _cachedUsername = null;
};

export let isDashboardDirty = true;
export const setDashboardDirty = (val: boolean) => { isDashboardDirty = val; };

/** Returns the resolved uniqueUserId for the active session. Cached after first call. */
export const getActiveUserId = async (): Promise<string> => {
  if (_cachedUserId) return _cachedUserId;
  try {
    const sessionStr = await SecureStore.getItemAsync('irma_device_auth_session');
    if (sessionStr) {
      const parsedSession = JSON.parse(sessionStr);
      let uId = parsedSession.uniqueUserId || parsedSession.userId;
      try {
        const userSnap = await getDoc(doc(firestoreDb, 'users', parsedSession.userId));
        if (userSnap.exists() && userSnap.data().uniqueUserId) {
          uId = userSnap.data().uniqueUserId;
          if (parsedSession.uniqueUserId !== uId) {
            parsedSession.uniqueUserId = uId;
            await SecureStore.setItemAsync('irma_device_auth_session', JSON.stringify(parsedSession));
          }
        }
      } catch (e) { console.warn('[userSession] Firestore lookup failed, using local session:', e); }
      _cachedUserId = uId || 'AnonymousUser';
      return _cachedUserId as string;
    }
  } catch (e) { console.warn('[userSession] SecureStore error:', e); }
  return 'AnonymousUser';
};

/** Returns the display username for the active session. Cached after first call. */
export const getActiveUsername = async (): Promise<string> => {
  if (_cachedUsername) return _cachedUsername;
  try {
    const sessionStr = await SecureStore.getItemAsync('irma_device_auth_session');
    if (sessionStr) {
      const parsedSession = JSON.parse(sessionStr);
      let uName: string = parsedSession.username || parsedSession.uniqueUserId || parsedSession.userId || 'User';
      try {
        const userSnap = await getDoc(doc(firestoreDb, 'users', parsedSession.userId));
        if (userSnap.exists() && userSnap.data().username) {
          uName = userSnap.data().username;
        }
      } catch (e) { /* network unavailable – use local name */ }
      _cachedUsername = uName;
      return _cachedUsername as string;
    }
  } catch (e) { console.warn('[userSession] SecureStore error:', e); }
  return 'User';
};
