import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { backendApi } from '../services/backendApi';
import { applyBackendSettings } from '../utils/applyBackendSettings';

// ── Default shape ─────────────────────────────────────────────────────────────
// Used while loading or when no backend profile exists.
// All widgets fall through to "show with defaults".
const DEFAULT_PROFILE = {
  profileId:    null,
  name:         null,
  settings: {
    datetime: true,
    weather:  true,
    news:     true,
    gmail:    false,
    spotify:  false,
  },
  integrations: {
    gmail:   { connected: false, email: null },
    spotify: { connected: false },
  },
  location: { city: 'Istanbul', country: null, lat: null, lon: null },
  preferences: { units: 'celsius', newsSources: ['bbc', 'trt'], language: 'en' },
};

const POLL_MS = 2000;

// ── Context ───────────────────────────────────────────────────────────────────
const ProfileContext = createContext({
  activeProfile: DEFAULT_PROFILE,
  isLoading:     true,
  lastSynced:    null,
  mirrorId:      null,
});

// ── Provider ──────────────────────────────────────────────────────────────────
export const ProfileProvider = ({ children }) => {
  const [mirrorId, setMirrorId]           = useState(() => backendApi.getMirrorId());
  const [activeProfile, setActiveProfile] = useState(DEFAULT_PROFILE);
  const [isLoading, setIsLoading]         = useState(true);
  const [lastSynced, setLastSynced]       = useState(null);
  const prevProfileIdRef                  = useRef(null);
  const prevSettingsHashRef               = useRef(null);
  const prevAiSettingsHashRef             = useRef(null);
  const hasSyncedRef                      = useRef(false);

  // Resolve the real mirror public key from the sync bridge.
  // Retries every 2 s until the bridge is online and returns the key,
  // so a slow bridge startup doesn't leave us stuck with a random UUID.
  useEffect(() => {
    let timer;
    const fetchKey = () => {
      fetch('http://localhost:4002/status', { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
          if (data.mirrorPublicKey) {
            localStorage.setItem('smartMirrorId', data.mirrorPublicKey);
            setMirrorId(data.mirrorPublicKey);
          } else {
            timer = setTimeout(fetchKey, 2000);
          }
        })
        .catch(() => { timer = setTimeout(fetchKey, 2000); });
    };
    fetchKey();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    console.log('[ProfileContext] Mirror ID:', mirrorId);

    const poll = async () => {
      const profile = await backendApi.getActiveProfile(mirrorId);

      if (!profile) {
        // Backend unreachable or no active profile — keep defaults, stop loading
        setIsLoading(false);
        console.log('[ProfileContext] No profile returned — using defaults.');
        return;
      }

      // Detect what changed
      const settingsHash    = JSON.stringify(profile.settings);
      const aiSettingsHash  = JSON.stringify(profile.aiSettings);
      const settingsChanged   = settingsHash   !== prevSettingsHashRef.current;
      const aiSettingsChanged = aiSettingsHash !== prevAiSettingsHashRef.current;
      const profileChanged    = profile.profileId !== prevProfileIdRef.current;

      // Skip re-render when nothing changed
      if (!profileChanged && !settingsChanged && !aiSettingsChanged && hasSyncedRef.current) {
        console.log('[ProfileContext] Profile unchanged (id:', profile.profileId, ') — skip.');
        return;
      }

      prevProfileIdRef.current       = profile.profileId;
      prevSettingsHashRef.current    = settingsHash;
      prevAiSettingsHashRef.current  = aiSettingsHash;

      // Apply backend settings to localStorage so mirror widgets re-evaluate.
      // Also force-apply on every profile switch so a new profile's widget set
      // immediately replaces the previous profile's localStorage state.
      if (settingsChanged || aiSettingsChanged || profileChanged) {
        applyBackendSettings({ widgets: profile.settings, ai: profile.aiSettings });
      }

      setActiveProfile(profile);
      setLastSynced(Date.now());
      hasSyncedRef.current = true;
      setIsLoading(false);

      console.log('[ProfileContext] Widget render decisions:', {
        datetime: profile.settings.datetime,
        weather:  profile.settings.weather,
        news:     profile.settings.news,
        gmail:    profile.integrations.gmail.connected,
        spotify:  profile.integrations.spotify.connected,
      });
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [mirrorId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate the household-level AI settings (single OpenAI key + model/voice,
  // shared via the backend) into the localStorage runtime cache so the voice
  // assistant uses the same key the phone set — even if Settings was never
  // opened. Merge-only: never clobbers a stored value with empty.
  useEffect(() => {
    let cancelled = false;
    let timer;
    let lastHash = null;
    const pull = async () => {
      try {
        const s = await backendApi.getIntegrations();
        if (!cancelled && s) {
          const ai = {
            apiKey: s.openaiApiKey || '',
            chatModel: s.chatModel || 'gpt-4o',
            realtimeModel: s.realtimeModel || 'gpt-4o-realtime-preview-2024-12-17',
            voice: s.voice || 'alloy',
            name: s.assistantName || 'Mirror',
            elevenLabsKey: s.elevenLabsKey || '',
            elevenLabsVoiceId: s.elevenLabsVoiceId || '',
            showRawTranscripts: !!s.showRawTranscripts,
          };
          const hash = JSON.stringify(ai);
          if (hash !== lastHash) {
            lastHash = hash;
            const KEY = 'smartMirrorSettings';
            const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
            const prev = (stored.aiAssistant && stored.aiAssistant.settings) || {};
            stored.aiAssistant = {
              enabled: (stored.aiAssistant && stored.aiAssistant.enabled) ?? true,
              settingsVersion: 2,
              settings: {
                ...prev,
                ...ai,
                apiKey: ai.apiKey || prev.apiKey || '',
                elevenLabsKey: ai.elevenLabsKey || prev.elevenLabsKey || '',
              },
            };
            localStorage.setItem(KEY, JSON.stringify(stored));
            window.dispatchEvent(new Event('storage'));
          }
        }
      } catch (_) {}
      if (!cancelled) timer = setTimeout(pull, 5000);
    };
    pull();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return (
    <ProfileContext.Provider value={{ activeProfile, isLoading, lastSynced, mirrorId }}>
      {children}
    </ProfileContext.Provider>
  );
};

// ── Consumer hook ─────────────────────────────────────────────────────────────
export const useProfile = () => useContext(ProfileContext);
