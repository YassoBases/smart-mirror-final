import { useState, useEffect, useCallback } from 'react';

// API base uses the mirror's LAN IP (same host as the React app, different port)
const API_BASE = `http://${window.location.hostname}:3000`;

/**
 * Phone pairing page — served at /phone-pair?sid=...&code=...
 *
 * Flow:
 *   1. Phone camera scans the mirror QR → phone browser opens this page
 *   2. If not logged in: show login form
 *   3. After login: show "Pair this mirror?" confirmation
 *   4. On confirm: POST /api/mirrors/pair → mirror transitions to 'ready'
 *   5. Save mirror server URL in localStorage for future use
 */
export default function PhonePair() {
  const params = new URLSearchParams(window.location.search);
  const sid    = params.get('sid');
  const code   = params.get('code');

  const [step,     setStep]     = useState('login'); // login | confirm | done | error
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [token,    setToken]    = useState(() => localStorage.getItem('mirrorBackendToken'));
  const [error,    setError]    = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [reachable, setReachable] = useState(null); // null=checking, true, false

  // ── FCM web push registration ────────────────────────────────────────────────
  // Requires Firebase to be configured (REACT_APP_FIREBASE_* env vars).
  // Runs once after the mirror is successfully paired and a JWT is available.
  const registerFcmToken = useCallback(async (jwtToken) => {
    try {
      // These env vars must be set in your .env file for web push to work.
      // See NOTIFICATIONS_SETUP.md for full instructions.
      const firebaseConfig = {
        apiKey:            process.env.REACT_APP_FIREBASE_API_KEY,
        authDomain:        process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
        projectId:         process.env.REACT_APP_FIREBASE_PROJECT_ID,
        storageBucket:     process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
        appId:             process.env.REACT_APP_FIREBASE_APP_ID,
      };
      const vapidKey = process.env.REACT_APP_FIREBASE_VAPID_KEY;

      // Skip silently when Firebase is not configured (dev / no push setup)
      if (!firebaseConfig.projectId || !vapidKey) return;

      const { initializeApp, getApps } = await import('firebase/app');
      const { getMessaging, getToken, isSupported } = await import('firebase/messaging');

      if (!await isSupported()) return; // browser doesn't support web push

      const fbApp = getApps().length === 0
        ? initializeApp(firebaseConfig)
        : getApps()[0];
      const messaging = getMessaging(fbApp);

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      const fcmToken = await getToken(messaging, { vapidKey });
      if (!fcmToken) return;

      // Register the token with our backend
      await fetch(`${API_BASE}/api/devices/token`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${jwtToken}`,
        },
        body: JSON.stringify({ token: fcmToken, platform: 'web' }),
      });

      console.log('[PhonePair] FCM token registered');
    } catch (e) {
      // Non-fatal — the alerts page polling still works without push
      console.warn('[PhonePair] FCM registration failed:', e.message);
    }
  }, []);

  // Skip login step if already authenticated
  useEffect(() => {
    if (token) setStep('confirm');
  }, [token]);

  // Check that the mirror server is reachable before showing the form
  useEffect(() => {
    fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(4000) })
      .then(r => setReachable(r.ok))
      .catch(() => setReachable(false));
  }, []);

  if (!sid || !code) {
    return (
      <Page>
        <ErrorCard>
          QR code is missing mirror server address. Please scan the QR code again.
        </ErrorCard>
      </Page>
    );
  }

  if (reachable === false) {
    return (
      <Page>
        <ErrorCard>
          Cannot connect to mirror at {API_BASE}. Make sure your phone and the mirror
          are on the same Wi-Fi network.
        </ErrorCard>
      </Page>
    );
  }

  if (step === 'login') {
    const handleLogin = async (e) => {
      e.preventDefault();
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/api/auth/login`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');
        localStorage.setItem('mirrorBackendToken', data.token);
        setToken(data.token);
        setStep('confirm');
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    return (
      <Page>
        <h1 style={s.title}>Sign in to pair</h1>
        <p style={s.sub}>Connect your account to this mirror</p>
        <form onSubmit={handleLogin} style={s.form}>
          <input
            style={s.input}
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <input
            style={s.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
          {error && <p style={s.errorText}>{error}</p>}
          <Btn type="submit" loading={loading}>Sign in</Btn>
        </form>
      </Page>
    );
  }

  if (step === 'confirm') {
    const handlePair = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/api/mirrors/pair`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization:  `Bearer ${token}`,
          },
          body: JSON.stringify({ sid, shortCode: code }),
        });
        const data = await res.json();
        if (res.status === 401) {
          // Token expired — re-login
          localStorage.removeItem('mirrorBackendToken');
          setToken(null);
          setStep('login');
          setError('Session expired. Please sign in again.');
          return;
        }
        if (!res.ok) throw new Error(data.error || 'Pairing failed');

        // Save mirror address so the app can call the backend in the future
        localStorage.setItem('mirrorServerUrl', API_BASE);
        localStorage.setItem('mirrorId', data.mirrorId);
        // Register for FCM web push (non-blocking, fails silently if unconfigured)
        registerFcmToken(token);
        setStep('done');
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    return (
      <Page>
        <div style={s.mirrorIcon}>🪞</div>
        <h1 style={s.title}>Pair this mirror?</h1>
        <p style={s.sub}>Code: <strong style={{ color: 'rgba(255,255,255,0.7)', letterSpacing: '0.15em' }}>{code}</strong></p>
        <p style={{ ...s.sub, fontSize: '0.75rem', marginBottom: '24px' }}>
          Mirror server: {API_BASE}
        </p>
        {error && <p style={s.errorText}>{error}</p>}
        <Btn onClick={handlePair} loading={loading}>Pair Mirror</Btn>
        <Btn
          secondary
          onClick={() => {
            localStorage.removeItem('mirrorBackendToken');
            setToken(null);
            setStep('login');
          }}
        >
          Use a different account
        </Btn>
      </Page>
    );
  }

  if (step === 'done') {
    return (
      <Page>
        <div style={{ fontSize: '3rem', marginBottom: '16px' }}>✓</div>
        <h1 style={{ ...s.title, color: '#4ade80' }}>Mirror paired!</h1>
        <p style={s.sub}>Your mirror is now linked to your account.</p>
        <p style={{ ...s.sub, marginBottom: '24px' }}>
          You will receive security alerts when an unknown face is detected.
        </p>
        <Btn onClick={() => { window.location.href = '/alerts'; }}>
          View Security Alerts
        </Btn>
        <Btn secondary onClick={() => { /* stay on page */ }}>
          Close
        </Btn>
      </Page>
    );
  }

  return null;
}

function Page({ children }) {
  return (
    <div style={s.page}>
      <div style={s.card}>{children}</div>
    </div>
  );
}

function ErrorCard({ children }) {
  return (
    <div style={s.errorCard}>
      <p style={{ margin: 0, lineHeight: 1.6 }}>{children}</p>
    </div>
  );
}

function Btn({ children, secondary, loading, ...props }) {
  return (
    <button
      style={secondary ? { ...s.btn, ...s.btnSecondary } : s.btn}
      disabled={loading}
      {...props}
    >
      {loading ? '…' : children}
    </button>
  );
}

const s = {
  page: {
    minHeight: '100vh',
    background: '#080808',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: '100%',
    maxWidth: '360px',
  },
  mirrorIcon: { fontSize: '2.5rem', marginBottom: '12px' },
  title: { fontSize: '1.6rem', fontWeight: 300, marginBottom: '6px', textAlign: 'center' },
  sub: { fontSize: '0.875rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px', textAlign: 'center' },
  form: { display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', marginTop: '8px' },
  input: {
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '10px',
    padding: '14px 16px',
    color: '#fff',
    fontSize: '1rem',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  btn: {
    marginTop: '8px',
    width: '100%',
    padding: '14px',
    background: 'rgba(56,189,248,0.12)',
    border: '1px solid rgba(56,189,248,0.25)',
    borderRadius: '10px',
    color: '#38bdf8',
    fontSize: '1rem',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  btnSecondary: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.35)',
  },
  errorText: { color: '#f87171', fontSize: '0.85rem', margin: '4px 0' },
  errorCard: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.25)',
    borderRadius: '12px',
    padding: '20px',
    color: '#fca5a5',
    fontSize: '0.9rem',
    textAlign: 'center',
  },
};
