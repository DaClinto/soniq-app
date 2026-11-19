import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { firebaseConfigurationError } from './firebase';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {firebaseConfigurationError ? (
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'sans-serif' }}>
          <section style={{ maxWidth: 560 }}>
            <h1>Firebase setup required</h1>
            <p>{firebaseConfigurationError}</p>
            <p>Add the VITE_FIREBASE_* values as GitHub Actions repository secrets, then rerun the deployment workflow.</p>
          </section>
        </main>
      ) : (
        <App />
      )}
    </React.StrictMode>
  );
}
