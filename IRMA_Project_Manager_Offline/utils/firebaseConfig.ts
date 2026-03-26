import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAnalytics, isSupported } from 'firebase/analytics';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyC22s8TtGJowGC0Xb1mKkNKSNXl5Ilgplk",
  authDomain: "irma-project-manager-offline.firebaseapp.com",
  projectId: "irma-project-manager-offline",
  storageBucket: "irma-project-manager-offline.firebasestorage.app",
  messagingSenderId: "259388218274",
  appId: "1:259388218274:web:5cafb1281c12085f6ef0fb",
  measurementId: "G-DT8N9XL4TK"
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firestore
export const db = getFirestore(app);

// Safely initialize Analytics ONLY if the environment supports it (e.g., Web)
// This prevents fatal crashes on React Native iOS/Android environments.
export let analytics: any = null;
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
  }
});