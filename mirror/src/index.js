import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { ModelSettingsProvider } from './contexts/ModelSettingsContext';
import { migrateGeneralSettingsIfNeeded } from './data/generalSettings';

// Run one-time settings migrations before first render so the mirror boots with
// the corrected flags (e.g. face recognition enabled for legacy installs).
migrateGeneralSettingsIfNeeded();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <ModelSettingsProvider>
    <App />
  </ModelSettingsProvider>
);
