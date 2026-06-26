// Translates backend settings (from parseSettings()) → mirror localStorage format.
// Called by ProfileContext whenever settings change on the phone app.

const STORAGE_KEY = 'smartMirrorSettings';

const sensitivityMap = { low: 0.5, normal: 1.0, high: 1.5, very_high: 2.0 };
const smoothingMap   = { minimal: 0.2, low: 0.5, normal: 0.8, high: 0.9 };
const refreshMap     = { '1m': 60000, '5m': 300000, '10m': 600000, '30m': 1800000 };

export function applyBackendSettings(settings) {
  if (!settings) return;

  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');

  // ── Widget enabled/disabled (settings.widgets.*) ──────────────────────────
  const w = settings.widgets || {};
  // time_calendar is the Flutter key; datetime is the mirror localStorage key.
  // Accept either so both the phone-sourced and local-settings paths work.
  if (w.time_calendar !== undefined) {
    stored.datetime = { ...stored.datetime, enabled: w.time_calendar };
  } else if (w.datetime !== undefined) {
    stored.datetime = { ...stored.datetime, enabled: w.datetime };
  }
  if (w.weather !== undefined) {
    stored.weather = { ...stored.weather, enabled: w.weather };
  }
  if (w.news !== undefined) {
    stored.news = { ...stored.news, enabled: w.news };
  }
  if (w.gmail !== undefined) {
    stored.gmail = { ...stored.gmail, enabled: w.gmail };
  }
  if (w.spotify !== undefined) {
    stored.spotify = { ...stored.spotify, enabled: w.spotify };
  }
  if (w.gesture !== undefined) {
    stored.general = { ...stored.general, gestureEnabled: w.gesture };
  }
  // NOTE: camera/handtracking.enabled is NOT touched here — always on for face recognition.

  // ── Weather location (settings.location.*) ────────────────────────────────
  const loc = settings.location || {};
  if (loc.city || loc.units) {
    stored.weather = stored.weather || {};
    stored.weather.settings = stored.weather.settings || {};
    if (loc.city)  stored.weather.settings.location = loc.city;
    if (loc.units) stored.weather.settings.units    = loc.units;
  }

  // ── Clock preferences (settings.clockPreferences.*) ──────────────────────
  const clk = settings.clockPreferences || {};
  if (Object.keys(clk).length > 0) {
    stored.clock = stored.clock || {};
    stored.clock.settings = stored.clock.settings || {};
    if (clk.format24h   !== undefined) stored.clock.settings.format24h   = clk.format24h;
    if (clk.showSeconds !== undefined) stored.clock.settings.showSeconds  = clk.showSeconds;
    if (clk.fontSize)                  stored.clock.settings.fontSize     = clk.fontSize;
  }

  // ── Date preferences (settings.datePreferences.*) ─────────────────────────
  const dt = settings.datePreferences || {};
  if (Object.keys(dt).length > 0) {
    stored.date = stored.date || {};
    stored.date.settings = stored.date.settings || {};
    if (dt.format)             stored.date.settings.format   = dt.format;
    if (dt.showYear !== undefined) stored.date.settings.showYear = dt.showYear;
  }

  // ── News preferences (settings.newsPreferences.*) ─────────────────────────
  const np = settings.newsPreferences || {};
  if (Object.keys(np).length > 0) {
    stored.news = stored.news || {};
    stored.news.settings = stored.news.settings || {};
    if (np.sources)                   stored.news.settings.sources         = np.sources.map(s => s.toLowerCase());
    if (np.maxArticles !== undefined) stored.news.settings.maxItems         = np.maxArticles;
    if (np.refreshInterval)           stored.news.settings.refreshInterval  = refreshMap[np.refreshInterval] || 300000;
  }

  // ── Gmail preferences (settings.gmailPreferences.*) ──────────────────────
  const gm = settings.gmailPreferences || {};
  if (Object.keys(gm).length > 0) {
    stored.gmail = stored.gmail || {};
    stored.gmail.settings = stored.gmail.settings || {};
    if (gm.emailsToDisplay !== undefined) stored.gmail.settings.maxEmails      = gm.emailsToDisplay;
    if (gm.showSnippets    !== undefined) stored.gmail.settings.showSnippets   = gm.showSnippets;
    if (gm.showUnreadBadge !== undefined) stored.gmail.settings.showUnreadCount = gm.showUnreadBadge;
  }

  // ── Gesture / hand tracking preferences (settings.gesturePreferences.*) ──
  const gp = settings.gesturePreferences || {};
  if (Object.keys(gp).length > 0) {
    stored.handtracking = stored.handtracking || {};
    stored.handtracking.settings = stored.handtracking.settings || {};
    if (gp.sensitivity)     stored.handtracking.settings.sensitivity    = sensitivityMap[gp.sensitivity] ?? 1.0;
    if (gp.smoothing)       stored.handtracking.settings.smoothing      = smoothingMap[gp.smoothing]   ?? 0.8;
    if (gp.cameraPosition)  stored.handtracking.settings.cameraPosition = gp.cameraPosition;
  }

  // ── AI assistant settings (settings.ai — legacy per-profile block) ──────────
  // AI config is now household-level (synced via the shared settings); only apply
  // a per-profile block when it actually carries a key, and never let it clobber
  // an already-stored (household-hydrated) value with empty.
  const ai = settings.ai;
  if (ai && ai.apiKey) {
    const prev = stored.aiAssistant?.settings || {};
    stored.aiAssistant = {
      enabled:         ai.enabled ?? stored.aiAssistant?.enabled ?? true,
      settingsVersion: 2,
      settings: {
        ...prev,
        name:               ai.name               || prev.name               || 'Mirror',
        apiKey:             ai.apiKey             || prev.apiKey             || '',
        chatModel:          ai.chatModel          || prev.chatModel          || 'gpt-4o',
        realtimeModel:      ai.realtimeModel      || prev.realtimeModel      || 'gpt-4o-realtime-preview-2024-12-17',
        voice:              ai.voice              || prev.voice              || 'alloy',
        elevenLabsKey:      ai.elevenLabsKey      || prev.elevenLabsKey      || '',
        elevenLabsVoiceId:  ai.elevenLabsVoiceId  || prev.elevenLabsVoiceId  || '',
        showRawTranscripts: ai.showRawTranscripts ?? prev.showRawTranscripts ?? false,
      },
    };
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  // Fire storage event so SmartMirror re-evaluates widget visibility
  window.dispatchEvent(new Event('storage'));

  console.log('[MirrorSync] Applied backend settings to localStorage:', {
    widgets: w,
    location: loc.city,
    units: loc.units,
    note: 'camera/handtracking enabled state is NOT overwritten — always on for face recognition',
  });
}
