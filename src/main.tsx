import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { supabaseConfigurationError } from './supabase';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {supabaseConfigurationError ? (
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, fontFamily: 'sans-serif' }}>
          <section style={{ maxWidth: 560 }}>
            <h1>Supabase setup required</h1>
            <p>{supabaseConfigurationError}</p>
            <p>Add the VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY values as GitHub Actions repository secrets, then rerun the deployment workflow.</p>
          </section>
        </main>
      ) : (
        <App />
      )}
    </React.StrictMode>
  );
}
