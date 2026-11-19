import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const requiredConfig = [
  'apiKey',
  'authDomain',
  'projectId',
  'appId',
] as const;

const missingConfig = requiredConfig.filter((key) => !firebaseConfig[key]);

export const firebaseConfigurationError = missingConfig.length > 0
  ? `Missing Firebase configuration: ${missingConfig
      .map((key) => `VITE_FIREBASE_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`)
      .join(', ')}`
  : '';

export const firebaseApp = firebaseConfigurationError
  ? null
  : getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = firebaseApp ? getAuth(firebaseApp) : null;
export const db = firebaseApp ? getFirestore(firebaseApp) : null;
export const storage = firebaseApp ? getStorage(firebaseApp) : null;

/*
  The exports above are intentionally initialized only after checking required
  configuration. App components must handle firebaseConfigurationError.
*/
