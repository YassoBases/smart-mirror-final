import React, { useState, useCallback, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router-dom';
import SmartMirror from './pages/SmartMirror';
import Settings from './pages/Settings';
import Model from './pages/Model';
import ModelSettings from './pages/ModelSettings';
import PhonePair from './pages/PhonePair';
import Alerts from './pages/Alerts';
import PairingScreen from './components/PairingScreen';
import WelcomeScreen from './components/WelcomeScreen';
import SetupMode from './components/SetupMode';
import PairingCodeOverlay from './components/PairingCodeOverlay';
import VirtualKeyboard from './components/VirtualKeyboard';
import { LanguageProvider } from './contexts/LanguageContext';
import { ProfileProvider } from './contexts/ProfileContext';
import { GuestModeProvider } from './contexts/GuestModeContext';
import { backendApi } from './services/backendApi';

// Wraps PairingScreen as a navigable route — completion or guest entry returns to mirror.
function PairingRoute() {
  const navigate = useNavigate();
  return <PairingScreen onComplete={() => navigate('/')} autoAdvance={false} />;
}


// Flow: [SetupMode if offline] → 'pairing' → 'welcome' (3 s) → 'mirror'
function AppShell() {
  const [introPhase, setIntroPhase] = useState('pairing');
  // null = initial check in progress; true = no LAN IP yet; false = online
  const [isOffline, setIsOffline] = useState(null);

  const handlePairingComplete = useCallback(() => setIntroPhase('welcome'), []);
  const handleWelcomeDone     = useCallback(() => setIntroPhase('mirror'),  []);

  // Poll netinfo — show SetupMode whenever the Pi has no LAN IP. The poll keeps
  // running after the first success, so a runtime WiFi drop (local backend returns
  // 503 offline) flips the screen back to SetupMode within ~5 s, with no F5.
  // Require 3 consecutive failures (~15 s) before declaring offline so a
  // boot-time race (backend slow / no IP yet) doesn't flash the setup screen.
  useEffect(() => {
    let cancelled = false;
    let timerId = null;
    let failures = 0;

    const check = async () => {
      try {
        await backendApi.getNetInfo();
        if (!cancelled) {
          failures = 0;
          setIsOffline(false);
        }
      } catch (e) {
        if (!cancelled) {
          if (e.offline) {
            setIsOffline(true);
          } else {
            failures += 1;
            if (failures >= 3) setIsOffline(v => (v === false ? false : true));
          }
        }
      }
    };

    check();
    timerId = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(timerId);
    };
  }, []);

  // Brief connecting state — overlay stays mounted so a pairing code can show
  // even before we know the network state.
  if (isOffline === null) return (
    <>
      <PairingCodeOverlay />
      <div className="fixed inset-0 bg-black" />
    </>
  );

  // Pi has no LAN IP yet — guide the customer through WiFi setup. The pairing-code
  // overlay sits on top so the 6-digit code appears during the BLE bond.
  if (isOffline) {
    return (
      <>
        <PairingCodeOverlay />
        <SetupMode />
      </>
    );
  }

  return (
    <>
    <PairingCodeOverlay />
    <Router
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <div className="App">
        {/* Global on-screen keyboard — appears whenever a text field is focused,
            on every screen (pairing, mirror, settings). Typed via pinch-click. */}
        <VirtualKeyboard />
        {introPhase === 'pairing' && (
          <PairingScreen onComplete={handlePairingComplete} />
        )}
        {introPhase === 'welcome' && (
          <WelcomeScreen onDone={handleWelcomeDone} />
        )}
        {introPhase === 'mirror' && (
          <Routes>
            <Route path="/"              element={<SmartMirror />} />
            <Route path="/settings"      element={<Settings />} />
            <Route path="/model"         element={<Model />} />
            <Route path="/modelsettings" element={<ModelSettings />} />
            <Route path="/pairing"       element={<PairingRoute />} />
          </Routes>
        )}
      </div>
    </Router>
    </>
  );
}

function App() {
  // /phone-pair is a standalone page for phones scanning the mirror QR code.
  // It runs outside the mirror's intro flow and doesn't need the mirror contexts.
  if (window.location.pathname === '/phone-pair') {
    return <PhonePair />;
  }

  // /alerts is the phone-side security alerts viewer — no mirror intro flow needed.
  if (window.location.pathname === '/alerts') {
    return <Alerts />;
  }

  return (
    <GuestModeProvider>
      <ProfileProvider>
        <LanguageProvider>
          <AppShell />
        </LanguageProvider>
      </ProfileProvider>
    </GuestModeProvider>
  );
}

export default App;
