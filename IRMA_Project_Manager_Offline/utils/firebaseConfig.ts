import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAnalytics, isSupported } from 'firebase/analytics';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCvXa2qgN2StFVT9N9LwuF1hpK57iuIzHg", // google maps api key
  authDomain: "irma-project-manager-2k26.firebaseapp.com",
  projectId: "irma-project-manager-2k26",
  storageBucket: "irma-project-manager-2k26.firebasestorage.app",
  messagingSenderId: "845766509958",
  // measurementId: "G-DT8N9XL4TK", // unchanged as of now
  appId: "1:845766509958:android:16e7ff899f3d24e7ae9807"
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firestore
export const db = getFirestore(app, "default");

// Safely initialize Analytics ONLY if the environment supports it (e.g., Web)
// This prevents fatal crashes on React Native iOS/Android environments.
export let analytics: any = null;
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
  }
});