import { useState, useEffect, useCallback } from 'react';

const MIRROR_SERVER_KEY  = 'mirrorServerUrl';
const TOKEN_KEY          = 'mirrorBackendToken';
const MIRROR_ID_KEY      = 'mirrorId';
const POLL_INTERVAL_MS   = 30_000; // 30 s

/**
 * Phone-side Alerts page — accessed at /alerts on the mirror's web server.
 * Polls GET /api/alerts every 30 s and displays security alerts for the household.
 */
export default function Alerts() {
  const mirrorServer = localStorage.getItem(MIRROR_SERVER_KEY)
    || `http://${window.location.hostname}:3000`;
  const token    = localStorage.getItem(TOKEN_KEY);
  const mirrorId = localStorage.getItem(MIRROR_ID_KEY);

  const [alerts,      setAlerts]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testMsg,     setTestMsg]     = useState(null);

  const fetchAlerts = useCallback(async () => {
    if (!token) { setError('Not logged in — please scan the mirror QR code first.'); setLoading(false); return; }
    try {
      const res = await fetch(`${mirrorServer}/api/alerts?limit=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { setError('Session expired. Please re-pair with the mirror.'); setLoading(false); return; }
      if (!res.ok) { setError(`Server error (${res.status})`); return; }
      const data = await res.json();
      setAlerts(data.alerts || []);
      setError(null);
      setLastUpdated(new Date());
    } catch (e) {
      setError('Cannot reach mirror server — check that you are on the same Wi-Fi.');
    } finally {
      setLoading(false);
    }
  }, [mirrorServer, token]);

  useEffect(() => {
    fetchAlerts();
    const id = setInterval(fetchAlerts, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  const sendTestAlert = async () => {
    if (!mirrorId) { setTestMsg('No paired mirror found. Please pair first.'); return; }
    setTestLoading(true);
    setTestMsg(null);
    try {
      const res = await fetch(`${mirrorServer}/api/alerts/test`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ mirrorId }),
      });
      const data = await res.json();
      if (!res.ok) { setTestMsg(data.error || 'Test failed'); return; }
      setTestMsg(`Test alert #${data.alertId} sent!`);
      setTimeout(fetchAlerts, 800);
    } catch (e) {
      setTestMsg('Connection error');
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div style={s.page}>
      <div style={s.container}>

        {/* ── Header ── */}
        <div style={s.header}>
          <div style={s.headerLeft}>
            <span style={s.shieldIcon}>🛡</span>
            <div>
              <h1 style={s.title}>Security Alerts</h1>
              {lastUpdated && (
                <p style={s.subtitle}>Updated {lastUpdated.toLocaleTimeString()}</p>
              )}
            </div>
          </div>
          <button style={s.refreshBtn} onClick={fetchAlerts} title="Refresh">
            ↻
          </button>
        </div>

        {/* ── Error banner ── */}
        {error && <div style={s.errorBanner}>{error}</div>}

        {/* ── Test alert button ── */}
        <div style={s.testSection}>
          <button
            style={testLoading ? { ...s.testBtn, opacity: 0.6 } : s.testBtn}
            onClick={sendTestAlert}
            disabled={testLoading}
          >
            {testLoading ? '…' : 'Send Test Alert'}
          </button>
          {testMsg && <span style={s.testMsg}>{testMsg}</span>}
        </div>

        {/* ── Alert list ── */}
        {loading ? (
          <div style={s.emptyState}>Loading…</div>
        ) : alerts.length === 0 ? (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>🔔</div>
            <p style={s.emptyText}>No alerts yet</p>
            <p style={s.emptySubtext}>
              When an unknown face is detected at your mirror, it will appear here.
            </p>
          </div>
        ) : (
          <div style={s.list}>
            {alerts.map(alert => (
              <AlertCard key={alert.id} alert={alert} mirrorServer={mirrorServer} />
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

function AlertCard({ alert, mirrorServer }) {
  const date = new Date(alert.timestamp);
  const isTest = alert.alertType?.includes('TEST');

  const confidenceLabel = alert.confidence != null
    ? `Distance: ${Number(alert.confidence).toFixed(3)}`
    : null;

  return (
    <div style={s.card}>
      {/* Left accent bar */}
      <div style={isTest ? { ...s.accentBar, background: '#38bdf8' } : s.accentBar} />

      <div style={s.cardBody}>
        {/* Type + time row */}
        <div style={s.cardRow}>
          <span style={s.alertTypeBadge}>
            {isTest ? '🧪 Test Alert' : '⚠ Unknown Face'}
          </span>
          <span style={s.alertTime}>
            {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            {' '}
            {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        {/* Mirror ID */}
        <p style={s.mirrorLabel}>
          Mirror: <span style={s.mirrorId}>{alert.mirrorId || '—'}</span>
        </p>

        {/* Confidence */}
        {confidenceLabel && (
          <p style={s.confidenceLabel}>{confidenceLabel}</p>
        )}

        {/* Snapshot image */}
        {alert.imageUrl && (
          <img
            src={`${mirrorServer}${alert.imageUrl}`}
            alt="Alert snapshot"
            style={s.snapshot}
            loading="lazy"
          />
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  page: {
    minHeight:   '100vh',
    background:  '#080808',
    color:       '#fff',
    fontFamily:  'system-ui, -apple-system, sans-serif',
    padding:     '0 0 40px',
  },
  container: {
    maxWidth:  '480px',
    margin:    '0 auto',
    padding:   '0 16px',
  },
  header: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '28px 0 16px',
  },
  headerLeft: {
    display:    'flex',
    alignItems: 'center',
    gap:        '12px',
  },
  shieldIcon: { fontSize: '2rem' },
  title: {
    fontSize:     '1.4rem',
    fontWeight:   '300',
    margin:       0,
    letterSpacing: '-0.01em',
  },
  subtitle: {
    fontSize: '0.75rem',
    color:    'rgba(255,255,255,0.3)',
    margin:   '2px 0 0',
  },
  refreshBtn: {
    background:   'rgba(255,255,255,0.06)',
    border:       '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    color:        'rgba(255,255,255,0.5)',
    fontSize:     '1.2rem',
    width:        '36px',
    height:       '36px',
    cursor:       'pointer',
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'center',
  },
  errorBanner: {
    background:   'rgba(239,68,68,0.12)',
    border:       '1px solid rgba(239,68,68,0.25)',
    borderRadius: '10px',
    padding:      '12px 14px',
    fontSize:     '0.85rem',
    color:        '#fca5a5',
    marginBottom: '16px',
  },
  testSection: {
    display:       'flex',
    alignItems:    'center',
    gap:           '10px',
    marginBottom:  '20px',
  },
  testBtn: {
    background:   'rgba(56,189,248,0.08)',
    border:       '1px solid rgba(56,189,248,0.2)',
    borderRadius: '8px',
    color:        '#38bdf8',
    fontSize:     '0.82rem',
    padding:      '8px 14px',
    cursor:       'pointer',
    whiteSpace:   'nowrap',
  },
  testMsg: {
    fontSize: '0.8rem',
    color:    'rgba(255,255,255,0.4)',
  },
  emptyState: {
    textAlign: 'center',
    padding:   '60px 0',
    color:     'rgba(255,255,255,0.3)',
  },
  emptyIcon:    { fontSize: '2.5rem', marginBottom: '12px' },
  emptyText:    { fontSize: '1rem',   fontWeight: 300, margin: '0 0 6px' },
  emptySubtext: { fontSize: '0.82rem', lineHeight: 1.6, maxWidth: '260px', margin: '0 auto' },
  list: {
    display:       'flex',
    flexDirection: 'column',
    gap:           '10px',
  },
  card: {
    display:      'flex',
    background:   'rgba(255,255,255,0.04)',
    border:       '1px solid rgba(255,255,255,0.08)',
    borderRadius: '12px',
    overflow:     'hidden',
  },
  accentBar: {
    width:      '4px',
    flexShrink: 0,
    background: '#facc15',
  },
  cardBody: {
    padding: '12px 14px',
    flex:    1,
  },
  cardRow: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    marginBottom:   '6px',
  },
  alertTypeBadge: {
    fontSize:     '0.82rem',
    fontWeight:   500,
    color:        '#facc15',
  },
  alertTime: {
    fontSize: '0.75rem',
    color:    'rgba(255,255,255,0.35)',
  },
  mirrorLabel: {
    fontSize: '0.78rem',
    color:    'rgba(255,255,255,0.35)',
    margin:   '0 0 4px',
  },
  mirrorId: {
    color:       'rgba(255,255,255,0.55)',
    fontFamily:  'monospace',
    fontSize:    '0.75rem',
    wordBreak:   'break-all',
  },
  confidenceLabel: {
    fontSize: '0.75rem',
    color:    'rgba(255,255,255,0.3)',
    margin:   '2px 0 0',
  },
  snapshot: {
    marginTop:    '10px',
    width:        '100%',
    borderRadius: '8px',
    objectFit:    'cover',
    maxHeight:    '200px',
    border:       '1px solid rgba(255,255,255,0.08)',
  },
};
