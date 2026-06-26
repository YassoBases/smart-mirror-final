import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useGuestMode } from '../contexts/GuestModeContext';
import MirrorIdQRCode from '../components/MirrorIdQRCode';
import GestureControl from '../components/GestureControl';
import { apps, saveAppSettings, toggleAppEnabled } from '../data/apps';
import { getUsers, migrateUsersIfNeeded } from '../data/users';
import { backendApi } from '../services/backendApi';
import {
  getAiAssistantSettings,
  saveAiAssistantSettings,
  setAiAssistantEnabled
} from '../data/aiAssistant';
import {
  ACCENT_OPTIONS,
  FONT_OPTIONS,
  getAccentOption,
  getFontOption,
  getGeneralSettings,
  saveGeneralSettings
} from '../data/generalSettings';
import { LANGUAGES } from '../data/translations';
import { CAMERA_POSITION_OPTIONS } from '../utils/handTracking';

const REALTIME_MODELS = [
  { value: 'gpt-4o-realtime-preview-2024-12-17', label: 'GPT-4o Realtime (Dec 2024) — recommended' },
  { value: 'gpt-4o-mini-realtime-preview-2024-12-17', label: 'GPT-4o mini Realtime (Dec 2024) — faster' },
  { value: 'gpt-4o-realtime-preview', label: 'GPT-4o Realtime (latest alias)' },
  { value: 'gpt-4o-mini-realtime-preview', label: 'GPT-4o mini Realtime (latest alias)' },
];

const CHAT_MODELS = [
  { value: 'gpt-4o',          label: 'GPT-4o — recommended' },
  { value: 'gpt-4o-mini',     label: 'GPT-4o mini — faster & cheaper' },
  { value: 'gpt-4.1',         label: 'GPT-4.1' },
  { value: 'gpt-4.1-mini',    label: 'GPT-4.1 mini' },
  { value: 'gpt-4-turbo',     label: 'GPT-4 Turbo' },
];

const VOICE_OPTIONS = [
  { value: 'alloy',   label: 'Alloy' },
  { value: 'ash',     label: 'Ash' },
  { value: 'ballad',  label: 'Ballad' },
  { value: 'coral',   label: 'Coral' },
  { value: 'echo',    label: 'Echo' },
  { value: 'sage',    label: 'Sage' },
  { value: 'shimmer', label: 'Shimmer' },
  { value: 'verse',   label: 'Verse' },
  { value: 'aria',    label: 'Aria' },
];

const Settings = () => {
  const { guestMode, exitGuest } = useGuestMode();
  const [settings, setSettings] = useState({});
  const [selectedApp, setSelectedApp] = useState(null);
  const [generalSettings, setGeneralSettings] = useState(() => getGeneralSettings());
  const [aiAssistantSettings, setAiAssistantSettings] = useState(() => getAiAssistantSettings());
  const [showApiKey, setShowApiKey] = useState(false);
  const [usersState, setUsersState] = useState(() => { migrateUsersIfNeeded(); return getUsers(); });

  const [mirrorIdCopied, setMirrorIdCopied] = useState(false);
  const [backendProfiles, setBackendProfiles] = useState([]);
  const [backendActiveId, setBackendActiveId] = useState(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // Wardrobe / Replicate integration (stored server-side; renders run on backend)
  const [integrations, setIntegrations] = useState(null);
  const [replicateKeyInput, setReplicateKeyInput] = useState('');
  const [showReplicateKey, setShowReplicateKey] = useState(false);
  const [savingReplicate, setSavingReplicate] = useState(false);
  const [replicateSaved, setReplicateSaved] = useState(false);

  const assistantSettings = aiAssistantSettings.settings || {};
  const selectedAccent = getAccentOption(generalSettings.accent);
  const selectedFont = getFontOption(generalSettings.font);

  useEffect(() => {
    const savedSettings = JSON.parse(localStorage.getItem('smartMirrorSettings') || '{}');
    const resolvedGeneral = getGeneralSettings();
    setSettings({ ...savedSettings, general: resolvedGeneral });
    setGeneralSettings(resolvedGeneral);
    setAiAssistantSettings(getAiAssistantSettings());
  }, []);

  useEffect(() => {
    const mirrorId = backendApi.getMirrorId();
    let cancelled = false;
    const fetchProfiles = async () => {
      try {
        const [profiles, active] = await Promise.all([
          backendApi.getProfilesByMirror(mirrorId),
          backendApi.getActiveUser(mirrorId),
        ]);
        if (!cancelled) {
          setBackendProfiles(profiles);
          setBackendActiveId(active?.id ?? null);
        }
      } catch (_) {}
    };
    fetchProfiles();
    const timer = setInterval(fetchProfiles, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    backendApi.getIntegrations().then((data) => {
      if (cancelled || !data) return;
      setIntegrations(data);
      // Hydrate the AI-assistant config from the shared household settings so a
      // key/model/voice set on the phone shows here and the voice assistant uses
      // it (localStorage stays the runtime cache).
      const fromBackend = {};
      if (typeof data.openaiApiKey === 'string' && data.openaiApiKey) fromBackend.apiKey = data.openaiApiKey;
      if (data.chatModel) fromBackend.chatModel = data.chatModel;
      if (data.realtimeModel) fromBackend.realtimeModel = data.realtimeModel;
      if (data.voice) fromBackend.voice = data.voice;
      if (data.assistantName) fromBackend.name = data.assistantName;
      if (typeof data.elevenLabsKey === 'string' && data.elevenLabsKey) fromBackend.elevenLabsKey = data.elevenLabsKey;
      if (data.elevenLabsVoiceId) fromBackend.elevenLabsVoiceId = data.elevenLabsVoiceId;
      if (typeof data.showRawTranscripts === 'boolean') fromBackend.showRawTranscripts = data.showRawTranscripts;
      if (Object.keys(fromBackend).length) {
        saveAiAssistantSettings(fromBackend);
        setAiAssistantSettings(getAiAssistantSettings());
        window.dispatchEvent(new Event('storage'));
      }
    });
    return () => { cancelled = true; };
  }, []);

  const handleSaveReplicate = async () => {
    setSavingReplicate(true);
    setReplicateSaved(false);
    try {
      const payload = {};
      if (replicateKeyInput.trim()) payload.replicateApiToken = replicateKeyInput.trim();
      const data = await backendApi.saveIntegrations(payload);
      setIntegrations(data);
      setReplicateKeyInput('');
      setReplicateSaved(true);
      setTimeout(() => setReplicateSaved(false), 2500);
    } catch (e) {
      console.warn('[Settings] save Replicate key failed:', e.message);
    } finally {
      setSavingReplicate(false);
    }
  };

  const handleToggleApp = (appId, enabled) => {
    toggleAppEnabled(appId, enabled);
    setSettings(prev => ({
      ...prev,
      [appId]: {
        ...prev[appId],
        enabled
      }
    }));
    
    // Trigger storage event for other components
    window.dispatchEvent(new Event('storage'));
  };

  const handleSettingChange = (appId, settingKey, value, options = {}) => {
    const newSettings = {
      ...settings,
      [appId]: {
        ...settings[appId],
        settings: {
          ...settings[appId]?.settings,
          [settingKey]: value
        }
      }
    };

    setSettings(newSettings);
    saveAppSettings(appId, { [settingKey]: value });

    // Trigger storage event for other components
    window.dispatchEvent(new Event('storage'));
  };

  const isAppEnabled = (appId) => {
    return settings[appId]?.enabled !== false; // Default to true
  };

  const getAppSetting = (appId, settingKey, defaultValue) => {
    return settings[appId]?.settings?.[settingKey] ?? defaultValue;
  };

  const handleToggleAiAssistant = (enabled) => {
    setAiAssistantEnabled(enabled);
    setAiAssistantSettings(prev => ({
      ...prev,
      enabled
    }));
    window.dispatchEvent(new Event('storage'));
  };

  // AI-assistant localStorage field -> shared (household) backend field.
  const AI_TO_BACKEND = {
    apiKey: 'openaiApiKey',
    chatModel: 'chatModel',
    realtimeModel: 'realtimeModel',
    voice: 'voice',
    name: 'assistantName',
    elevenLabsKey: 'elevenLabsKey',
    elevenLabsVoiceId: 'elevenLabsVoiceId',
    showRawTranscripts: 'showRawTranscripts',
  };

  const handleAiAssistantSettingChange = (key, value) => {
    saveAiAssistantSettings({ [key]: value });
    setAiAssistantSettings(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        [key]: value
      }
    }));
    window.dispatchEvent(new Event('storage'));
    // Persist to the shared household settings so the backend stylist + the
    // phone app see the same value (single source of truth).
    const backendField = AI_TO_BACKEND[key];
    if (backendField) {
      backendApi
        .saveIntegrations({ [backendField]: value })
        .catch((e) => console.warn('[Settings] sync AI setting failed:', e.message));
    }
  };

  const handleGeneralSettingChange = (changes) => {
    const updatedGeneral = saveGeneralSettings(changes);
    setGeneralSettings(updatedGeneral);
    setSettings(prev => ({
      ...prev,
      general: updatedGeneral
    }));
    window.dispatchEvent(new Event('storage'));
  };

  const handleSwitchUser = async (profileId) => {
    const mirrorId = backendApi.getMirrorId();
    await backendApi.setActiveMirrorUser(mirrorId, profileId);
    setBackendActiveId(profileId);
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await backendApi.signOutFromMirror(backendApi.getMirrorId());
      setBackendActiveId(null);
    } catch (_) {}
    setIsSigningOut(false);
  };

  const handleDeleteAccount = async () => {
    setIsDeletingAccount(true);
    try {
      await backendApi.deleteActiveProfile(backendApi.getMirrorId());
      const deletedId = backendActiveId;
      setBackendProfiles(prev => prev.filter(p => p.id !== deletedId));
      setBackendActiveId(null);
    } catch (_) {}
    setIsDeletingAccount(false);
    setShowDeleteConfirm(false);
  };

  const handleCopyMirrorId = () => {
    navigator.clipboard.writeText(backendApi.getMirrorId());
    setMirrorIdCopied(true);
    setTimeout(() => setMirrorIdCopied(false), 2000);
  };

  const handleAccentSelect = (accentId) => {
    if (accentId === generalSettings.accent) {
      return;
    }
    handleGeneralSettingChange({ accent: accentId });
  };

  const handleFontSelect = (fontId) => {
    if (fontId === generalSettings.font) {
      return;
    }
    handleGeneralSettingChange({ font: fontId });
  };

  const renderAppSettings = (app) => {
    switch (app.id) {
      case 'clock':
        return (
          <div className="space-y-4">
            <div>
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={getAppSetting('clock', 'format24h', false)}
                  onChange={(e) => handleSettingChange('clock', 'format24h', e.target.checked)}
                  className="lux-checkbox"
                />
                <span>24-hour format</span>
              </label>
            </div>
            <div>
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={getAppSetting('clock', 'showSeconds', true)}
                  onChange={(e) => handleSettingChange('clock', 'showSeconds', e.target.checked)}
                  className="lux-checkbox"
                />
                <span>Show seconds</span>
              </label>
            </div>
            <div>
              <label className="block mb-2">Font Size</label>
              <select
                value={getAppSetting('clock', 'fontSize', 'large')}
                onChange={(e) => handleSettingChange('clock', 'fontSize', e.target.value)}
                className="lux-select"
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </div>
          </div>
        );

      case 'date':
        return (
          <div className="space-y-4">
            <div>
              <label className="block mb-2">Date Format</label>
              <select
                value={getAppSetting('date', 'format', 'long')}
                onChange={(e) => handleSettingChange('date', 'format', e.target.value)}
                className="lux-select"
              >
                <option value="short">Short</option>
                <option value="medium">Medium</option>
                <option value="long">Long</option>
              </select>
            </div>
            <div>
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={getAppSetting('date', 'showYear', true)}
                  onChange={(e) => handleSettingChange('date', 'showYear', e.target.checked)}
                  className="lux-checkbox"
                />
                <span>Show year</span>
              </label>
            </div>
          </div>
        );

      case 'weather':
        return (
          <div className="space-y-4">
            <div>
              <label className="block mb-2">Location</label>
              <input
                type="text"
                placeholder="Enter city name"
                value={getAppSetting('weather', 'location', '')}
                onChange={(e) => handleSettingChange('weather', 'location', e.target.value)}
                className="lux-select"
              />
            </div>
            <div>
              <label className="block mb-2">Temperature Units</label>
              <select
                value={getAppSetting('weather', 'units', 'fahrenheit')}
                onChange={(e) => handleSettingChange('weather', 'units', e.target.value)}
                className="lux-select"
              >
                <option value="fahrenheit">Fahrenheit</option>
                <option value="celsius">Celsius</option>
              </select>
            </div>
            <div>
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={getAppSetting('weather', 'showDetails', true)}
                  onChange={(e) => handleSettingChange('weather', 'showDetails', e.target.checked)}
                  className="lux-checkbox"
                />
                <span>Show weather details</span>
              </label>
            </div>
          </div>
        );

      case 'news': {
        const NEWS_CHANNELS = [
          { id: 'bbc',       label: 'BBC',        desc: 'BBC World News' },
          { id: 'aljazeera', label: 'Al Jazeera', desc: 'Al Jazeera English' },
          { id: 'dw',        label: 'DW World',   desc: 'Deutsche Welle international' },
          { id: 'reuters',   label: 'Reuters',    desc: 'Reuters world news' }
        ];
        const activeSources = getAppSetting('news', 'sources', ['bbc', 'trt']);
        const toggleSource = (id) => {
          const next = activeSources.includes(id)
            ? activeSources.filter(s => s !== id)
            : [...activeSources, id];
          // Always keep at least one source selected
          if (next.length === 0) return;
          handleSettingChange('news', 'sources', next);
        };

        return (
          <div className="space-y-5">
            <div>
              <label className="block mb-3 font-medium">News Channels</label>
              <div className="space-y-2">
                {NEWS_CHANNELS.map(ch => {
                  const isOn = activeSources.includes(ch.id);
                  return (
                    <button
                      key={ch.id}
                      onClick={() => toggleSource(ch.id)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border transition-all duration-150 text-left ${
                        isOn
                          ? 'bg-white/10 border-white/30 text-white'
                          : 'bg-transparent border-white/10 text-white/40 hover:border-white/20 hover:text-white/60'
                      }`}
                    >
                      <div>
                        <div className="font-medium text-sm">{ch.label}</div>
                        <div className="text-xs opacity-60 mt-0.5">{ch.desc}</div>
                      </div>
                      <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                        isOn ? 'bg-white/90 border-white' : 'border-white/25'
                      }`}>
                        {isOn && (
                          <svg className="w-2.5 h-2.5 text-black" fill="currentColor" viewBox="0 0 12 12">
                            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-white/30 text-xs mt-2">
                {activeSources.length} source{activeSources.length !== 1 ? 's' : ''} selected · articles merged newest-first
              </p>
            </div>

            <div>
              <label className="block mb-2">Max Articles</label>
              <select
                value={getAppSetting('news', 'maxItems', 8)}
                onChange={(e) => handleSettingChange('news', 'maxItems', parseInt(e.target.value))}
                className="lux-select"
              >
                <option value={5}>5</option>
                <option value={8}>8</option>
                <option value={12}>12</option>
              </select>
            </div>

            <div>
              <label className="block mb-2">Refresh Interval</label>
              <select
                value={getAppSetting('news', 'refreshInterval', 300000)}
                onChange={(e) => handleSettingChange('news', 'refreshInterval', parseInt(e.target.value))}
                className="lux-select"
              >
                <option value={60000}>1 minute</option>
                <option value={300000}>5 minutes</option>
                <option value={600000}>10 minutes</option>
                <option value={1800000}>30 minutes</option>
              </select>
            </div>
          </div>
        );
      }

      case 'spotify': {
        const activeUser =
          usersState.profiles.find(p => p.id === usersState.activeUserId) ||
          usersState.profiles[0] ||
          null;
        const hasPhoneUser = activeUser?.source === 'phone';

        return (
          <div className="space-y-4">
            {/* Status card */}
            <div className="rounded-xl px-4 py-4 space-y-3" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.025)' }}>
              <div className="flex items-center gap-2">
                <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 16, height: 16, color: '#34d399', flexShrink: 0 }}>
                  <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                </svg>
                <span className="text-sm font-medium text-white/75">Spotify</span>
              </div>

              {hasPhoneUser ? (
                <div className="text-sm text-white/55">
                  Active user: <span className="font-medium text-white">{activeUser.name}</span>
                </div>
              ) : (
                <div className="text-xs text-white/28">
                  No active user paired from the mobile app.
                </div>
              )}
            </div>

            {/* Instructions */}
            <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 space-y-1">
              <div className="text-sm font-medium text-white/65">Managed from mobile app</div>
              <div className="text-xs text-white/28">
                To connect Spotify, open the mobile app, go to your profile, and connect your
                Spotify account there. The mirror will automatically display Spotify playback
                for the active paired user.
              </div>
            </div>
          </div>
        );
      }

      case 'handtracking': {
        const isEnabled = getAppSetting('handtracking', 'enabled', false);
        const brightness = getAppSetting('handtracking', 'brightness', 1);
        const contrast = getAppSetting('handtracking', 'contrast', 1);
        const detectionConfidence = getAppSetting('handtracking', 'minDetectionConfidence', 0.5);
        const trackingConfidence = getAppSetting('handtracking', 'minTrackingConfidence', 0.5);
        const preprocessingQuality = getAppSetting('handtracking', 'preprocessingQuality', 'medium');

        const getFillPercent = (value, min, max) =>
          Math.min(Math.max(((value - min) / (max - min)) * 100, 0), 100);

        const brightnessFill = getFillPercent(brightness, 0.5, 3);
        const contrastFill = getFillPercent(contrast, 0.5, 1.5);
        const detectionFill = getFillPercent(detectionConfidence, 0.1, 0.95);
        const trackingFill = getFillPercent(trackingConfidence, 0.1, 0.95);

        return (
          <div className="space-y-4">
            <div className="bg-yellow-900/20 border border-yellow-500/30 rounded-lg p-4">
              <div className="flex items-center space-x-2 text-yellow-400">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <span className="font-medium">Camera Permission Required</span>
              </div>
              <p className="text-sm text-yellow-300 mt-2">
                This app requires access to your camera for hand tracking. Make sure to allow camera permissions when prompted.
              </p>
            </div>
            
            <div>
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={(e) => handleSettingChange('handtracking', 'enabled', e.target.checked)}
                  className="lux-checkbox"
                />
                <span>Enable Hand Tracking</span>
              </label>
              <p className="text-xs text-white/28 mt-1">
                Track your index finger to control a cursor on the mirror
              </p>
            </div>
            
            <div>
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={getAppSetting('handtracking', 'showPreview', false)}
                  onChange={(e) => handleSettingChange('handtracking', 'showPreview', e.target.checked)}
                  className="lux-checkbox"
                  disabled={!isEnabled}
                />
                <span>Show Camera Preview</span>
              </label>
              <p className="text-xs text-white/28 mt-1">
                Display camera feed with hand landmarks in the Hand Tracking app
              </p>
            </div>

            <div>
              <label className="block mb-2">Camera Position on Mirror</label>
              <select
                value={getAppSetting('handtracking', 'cameraPosition', 'top')}
                onChange={(e) => handleSettingChange('handtracking', 'cameraPosition', e.target.value)}
                className="lux-select"
                disabled={!isEnabled}
              >
                {CAMERA_POSITION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-white/28 mt-1">
                Rotate cursor movement to match where the camera is mounted on the mirror
              </p>
            </div>

            <div>
              <label className="block mb-2">Cursor Sensitivity</label>
              <select
                value={getAppSetting('handtracking', 'sensitivity', 1.0)}
                onChange={(e) => handleSettingChange('handtracking', 'sensitivity', parseFloat(e.target.value))}
                className="lux-select"
                disabled={!isEnabled}
              >
                <option value={0.5}>Low</option>
                <option value={1.0}>Normal</option>
                <option value={1.5}>High</option>
                <option value={2.0}>Very High</option>
              </select>
              <p className="text-xs text-white/28 mt-1">
                Adjust how responsive the cursor is to hand movements
              </p>
            </div>

            <div>
              <label className="block mb-2">Movement Smoothing</label>
              <select
                value={getAppSetting('handtracking', 'smoothing', 0.8)}
                onChange={(e) => handleSettingChange('handtracking', 'smoothing', parseFloat(e.target.value))}
                className="lux-select"
                disabled={!isEnabled}
              >
                <option value={0.2}>Minimal</option>
                <option value={0.5}>Low</option>
                <option value={0.8}>Normal</option>
                <option value={0.9}>High</option>
              </select>
              <p className="text-xs text-white/28 mt-1">
                Reduce cursor jitter with movement smoothing
              </p>
            </div>

            <div>
              <label className="block mb-2">Preprocessing Quality</label>
              <select
                value={preprocessingQuality}
                onChange={(e) => handleSettingChange('handtracking', 'preprocessingQuality', e.target.value)}
                className="lux-select"
                disabled={!isEnabled}
              >
                <option value="low">Low (fastest)</option>
                <option value="medium">Medium</option>
                <option value="full">Full (best detail)</option>
              </select>
              <p className="text-xs text-white/28 mt-1">
                Lower quality reduces the resolution sent to MediaPipe for better performance on small devices.
              </p>
            </div>

            <div>
              <label className="block mb-2">
                Detection Confidence: {Math.round(detectionConfidence * 100)}%
              </label>
              <input
                type="range"
                min="0.1"
                max="0.95"
                step="0.01"
                value={detectionConfidence}
                onChange={(e) => handleSettingChange('handtracking', 'minDetectionConfidence', parseFloat(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                disabled={!isEnabled}
                style={{
                  background: `linear-gradient(to right, var(--mirror-accent-color, #38bdf8) 0%, var(--mirror-accent-color, #38bdf8) ${detectionFill}%, rgba(255,255,255,0.07) ${detectionFill}%, rgba(255,255,255,0.07) 100%)`
                }}
              />
              <div className="flex justify-between text-[10px] text-white/25 mt-1">
                <span>More false positives</span>
                <span>More selective</span>
              </div>
              <p className="text-xs text-white/28 mt-1">
                Increase for more reliable detections or lower it to react faster in low light.
              </p>
            </div>

            <div>
              <label className="block mb-2">
                Tracking Confidence: {Math.round(trackingConfidence * 100)}%
              </label>
              <input
                type="range"
                min="0.1"
                max="0.95"
                step="0.01"
                value={trackingConfidence}
                onChange={(e) => handleSettingChange('handtracking', 'minTrackingConfidence', parseFloat(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                disabled={!isEnabled}
                style={{
                  background: `linear-gradient(to right, var(--mirror-accent-color, #38bdf8) 0%, var(--mirror-accent-color, #38bdf8) ${trackingFill}%, rgba(255,255,255,0.07) ${trackingFill}%, rgba(255,255,255,0.07) 100%)`
                }}
              />
              <div className="flex justify-between text-[10px] text-white/25 mt-1">
                <span>More responsive</span>
                <span>More stable</span>
              </div>
              <p className="text-xs text-white/28 mt-1">
                Lower values help weaker CPUs keep up, while higher values prefer steadier tracking.
              </p>
            </div>

            <div>
              <label className="block mb-2">
                Brightness: {Math.round(brightness * 100)}%
              </label>
              <input
                type="range"
                min="0.5"
                max="3"
                step="0.05"
                value={brightness}
                onChange={(e) => handleSettingChange('handtracking', 'brightness', parseFloat(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                disabled={!isEnabled}
                style={{
                  background: `linear-gradient(to right, var(--mirror-accent-color, #38bdf8) 0%, var(--mirror-accent-color, #38bdf8) ${brightnessFill}%, rgba(255,255,255,0.07) ${brightnessFill}%, rgba(255,255,255,0.07) 100%)`
                }}
              />
              <div className="flex justify-between text-[10px] text-white/25 mt-1">
                <span>Darker</span>
                <span>Brighter</span>
              </div>
              <p className="text-xs text-white/28 mt-1">
                Increase brightness to help the camera see more detail in low light
              </p>
            </div>

            <div>
              <label className="block mb-2">
                Contrast: {Math.round(contrast * 100)}%
              </label>
              <input
                type="range"
                min="0.5"
                max="1.5"
                step="0.05"
                value={contrast}
                onChange={(e) => handleSettingChange('handtracking', 'contrast', parseFloat(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                disabled={!isEnabled}
                style={{
                  background: `linear-gradient(to right, var(--mirror-accent-color, #38bdf8) 0%, var(--mirror-accent-color, #38bdf8) ${contrastFill}%, rgba(255,255,255,0.07) ${contrastFill}%, rgba(255,255,255,0.07) 100%)`
                }}
              />
              <div className="flex justify-between text-[10px] text-white/25 mt-1">
                <span>Softer</span>
                <span>Sharper</span>
              </div>
              <p className="text-xs text-white/28 mt-1">
                Adjust contrast to make your hand stand out from the background
              </p>
            </div>

            <div>
              <label className="block mb-2">
                Pinch Sensitivity: {Math.round(getAppSetting('handtracking', 'pinchSensitivity', 0.2) * 100)}%
              </label>
              <input
                type="range"
                min="0.05"
                max="0.5"
                step="0.05"
                value={getAppSetting('handtracking', 'pinchSensitivity', 0.2)}
                onChange={(e) => handleSettingChange('handtracking', 'pinchSensitivity', parseFloat(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                disabled={!isEnabled}
                style={{
                  background: `linear-gradient(to right, var(--mirror-accent-color, #38bdf8) 0%, var(--mirror-accent-color, #38bdf8) ${getAppSetting('handtracking', 'pinchSensitivity', 0.2) * 200}%, rgba(255,255,255,0.07) ${getAppSetting('handtracking', 'pinchSensitivity', 0.2) * 200}%, rgba(255,255,255,0.07) 100%)`
                }}
              />
              <div className="flex justify-between text-[10px] text-white/25 mt-1">
                <span>Very Sensitive (5%)</span>
                <span>Less Sensitive (50%)</span>
              </div>
              <p className="text-xs text-white/28 mt-1">
                How tightly you need to close your fingers to trigger a pinch.
              </p>
            </div>

            <div>
              <label className="block mb-2">
                Click Speed: {getAppSetting('handtracking', 'clickPinchMaxMs', 400)}ms
              </label>
              <input
                type="range"
                min="150"
                max="700"
                step="50"
                value={getAppSetting('handtracking', 'clickPinchMaxMs', 400)}
                onChange={(e) => handleSettingChange('handtracking', 'clickPinchMaxMs', parseInt(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                disabled={!isEnabled}
                style={{
                  background: `linear-gradient(to right, var(--mirror-accent-color, #38bdf8) 0%, var(--mirror-accent-color, #38bdf8) ${getFillPercent(getAppSetting('handtracking', 'clickPinchMaxMs', 400), 150, 700)}%, rgba(255,255,255,0.07) ${getFillPercent(getAppSetting('handtracking', 'clickPinchMaxMs', 400), 150, 700)}%, rgba(255,255,255,0.07) 100%)`
                }}
              />
              <div className="flex justify-between text-[10px] text-white/25 mt-1">
                <span>Fast click (150ms)</span>
                <span>Slow click (700ms)</span>
              </div>
              <p className="text-xs text-white/28 mt-1">
                Max pinch duration to register as a click — longer gives you more time to tap, but makes drag slower to start.
              </p>
            </div>
          </div>
        );
      }

      case 'gmail':
        return (
          <div className="space-y-4">
            <div>
              <label className="block mb-2">Emails to Display</label>
              <select
                value={getAppSetting('gmail', 'maxEmails', 5)}
                onChange={(e) => handleSettingChange('gmail', 'maxEmails', parseInt(e.target.value))}
                className="lux-select"
              >
                <option value={3}>3</option>
                <option value={5}>5</option>
                <option value={10}>10</option>
              </select>
            </div>
            <div>
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={getAppSetting('gmail', 'showSnippets', true)}
                  onChange={(e) => handleSettingChange('gmail', 'showSnippets', e.target.checked)}
                  className="lux-checkbox"
                />
                <span>Show email snippets</span>
              </label>
            </div>
            <div>
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={getAppSetting('gmail', 'showUnreadCount', true)}
                  onChange={(e) => handleSettingChange('gmail', 'showUnreadCount', e.target.checked)}
                  className="lux-checkbox"
                />
                <span>Show unread count badge</span>
              </label>
            </div>
            <p className="text-xs text-white/28">
              Gmail connection is managed by the mirror backend. Enable the widget once your account is linked.
            </p>
          </div>
        );

      default:
        return <div className="text-xs text-white/25">No settings available for this app.</div>;
    }
  };

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Hand-gesture cursor + pinch-to-click for this page (no face model). */}
      <GestureControl />
      <div className="container mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-10">
          <div>
            <p className="text-[9px] uppercase tracking-[0.3em] text-white/25 mb-1">Configuration</p>
            <h1
              className="text-3xl font-normal text-white/85 tracking-tight"
              style={{ fontFamily: "'Playfair Display', serif" }}
            >
              Settings
            </h1>
          </div>
          <Link
            to="/"
            className="rounded-full px-5 py-2 text-[10px] uppercase tracking-[0.2em] text-white/35 transition-all duration-200 hover:text-white/65 hover:border-white/20"
            style={{ border: '1px solid rgba(255,255,255,0.09)' }}
          >
            Back to Mirror
          </Link>
        </div>

        <div className="mb-10">
          <div className="rounded-2xl p-6" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.025)' }}>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
              <div>
                <p className="text-[9px] uppercase tracking-[0.28em] text-white/25 mb-1">Appearance</p>
                <h2
                  className="text-xl font-normal text-white/80"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >General</h2>
                <p className="text-xs text-white/30 mt-1">
                  Dial in the vibe for every widget with color, type, and subtle chrome.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-white/30">
                <span
                  className="px-3 py-1 rounded-full"
                  style={{ border: '1px solid rgba(255,255,255,0.07)', color: selectedAccent.color }}
                >
                  {selectedAccent.name}
                </span>
                <span className="px-3 py-1 rounded-full text-white/30" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
                  {selectedFont.name}
                </span>
              </div>
            </div>

            <div className="space-y-8">
              <div>
                <p className="text-[9px] uppercase tracking-[0.28em] text-white/25 mb-3">Accent Color</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                  {ACCENT_OPTIONS.map(accent => {
                    const isActive = generalSettings.accent === accent.id;
                    const isNone = accent.id === 'none';
                    return (
                      <button
                        key={accent.id}
                        type="button"
                        onClick={() => handleAccentSelect(accent.id)}
                        title={accent.description}
                        className={`group relative overflow-hidden rounded-lg border transition-all duration-200 text-left p-2.5 backdrop-blur-sm bg-white/5 ${
                          isActive ? 'shadow-md' : 'hover:border-white/20'
                        }`}
                        style={{
                          borderColor: isActive ? (isNone ? 'rgba(255,255,255,0.4)' : accent.color) : 'rgba(255, 255, 255, 0.1)',
                          boxShadow: isActive && !isNone ? `0 0 0 1px ${accent.color} inset, 0 8px 20px ${accent.color}44` : undefined
                        }}
                      >
                        {isNone ? (
                          <span className="flex items-center justify-center h-7 rounded-md mb-1.5 bg-white/5 border border-dashed border-white/12 text-white/25 text-xs">
                            ✕
                          </span>
                        ) : (
                          <span
                            className="block h-7 rounded-md mb-1.5"
                            style={{ background: `linear-gradient(135deg, ${accent.color} 0%, ${accent.glow} 100%)` }}
                          />
                        )}
                        <div className="font-medium text-xs text-white truncate">{accent.name}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="text-[9px] uppercase tracking-[0.28em] text-white/25 mb-3">Font Style</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {FONT_OPTIONS.map(font => {
                    const isActive = generalSettings.font === font.id;
                    return (
                      <button
                        key={font.id}
                        type="button"
                        onClick={() => handleFontSelect(font.id)}
                        className={`rounded-xl px-4 py-4 text-left transition-all duration-300`}
                        style={{
                          fontFamily: font.stack,
                          border: isActive ? '1px solid rgba(255,255,255,0.25)' : '1px solid rgba(255,255,255,0.07)',
                          background: isActive ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                          boxShadow: isActive ? '0 0 30px var(--mirror-accent-soft)' : undefined
                        }}
                      >
                        <div className="text-sm font-medium text-white/80">{font.name}</div>
                        <div className="text-xs text-white/30">{font.description}</div>
                        <div className="mt-3 text-base text-white/60 tracking-wide">
                          The future is bright.
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <label className="flex items-start gap-3 rounded-xl px-4 py-3 cursor-pointer" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                  <input
                    type="checkbox"
                    className="lux-checkbox mt-0.5"
                    checked={generalSettings.widgetBorders}
                    onChange={(event) => handleGeneralSettingChange({ widgetBorders: event.target.checked })}
                  />
                  <span>
                    <span className="block text-sm text-white/75">Widget borders</span>
                    <span className="block text-xs text-white/30 mt-1">
                      Outline every card with sleek edges.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 rounded-xl px-4 py-3 cursor-pointer" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                  <input
                    type="checkbox"
                    className="lux-checkbox mt-0.5"
                    checked={generalSettings.widgetShadows}
                    onChange={(event) => handleGeneralSettingChange({ widgetShadows: event.target.checked })}
                  />
                  <span>
                    <span className="block text-sm text-white/75">Widget shadows</span>
                    <span className="block text-xs text-white/30 mt-1">
                      Soft accent glow beneath each widget.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 rounded-xl px-4 py-3 cursor-pointer" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                  <input
                    type="checkbox"
                    className="lux-checkbox mt-0.5"
                    checked={generalSettings.widgetHoverHighlight}
                    onChange={(event) => handleGeneralSettingChange({ widgetHoverHighlight: event.target.checked })}
                  />
                  <span>
                    <span className="block text-sm text-white/75">Hover highlight</span>
                    <span className="block text-xs text-white/30 mt-1">
                      Flash border on cursor hover.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 rounded-xl px-4 py-3 cursor-pointer" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                  <input
                    type="checkbox"
                    className="lux-checkbox mt-0.5"
                    checked={generalSettings.faceRecognitionEnabled !== false}
                    onChange={(event) => handleGeneralSettingChange({ faceRecognitionEnabled: event.target.checked, faceRecognitionMigrated: true })}
                  />
                  <span>
                    <span className="block text-sm text-white/75">Face recognition</span>
                    <span className="block text-xs text-white/30 mt-1">
                      Auto-switch profile for known faces &amp; alert on unknown ones.
                    </span>
                  </span>
                </label>
              </div>

              <div className="rounded-xl px-4 py-4 space-y-4" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div>
                    <p className="text-sm text-white/75">Sleep timeout</p>
                    <p className="text-xs text-white/30 mt-1">
                      Fade to black after inactivity — wake with a fist-to-open gesture.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-white/50 cursor-pointer">
                    <input
                      type="checkbox"
                      className="lux-checkbox"
                      checked={Boolean(generalSettings.mirrorTimeoutEnabled)}
                      onChange={(event) => handleGeneralSettingChange({ mirrorTimeoutEnabled: event.target.checked })}
                    />
                    <span>Enable</span>
                  </label>
                </div>
                <div>
                  <label className="block text-[9px] uppercase tracking-[0.25em] text-white/25 mb-2">
                    Sleep after (minutes)
                  </label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="lux-input"
                    value={generalSettings.mirrorTimeoutMinutes ?? 5}
                    onChange={(event) => {
                      const parsedValue = Number(event.target.value);
                      const safeValue = Number.isFinite(parsedValue) ? Math.max(1, Math.round(parsedValue)) : 1;
                      handleGeneralSettingChange({ mirrorTimeoutMinutes: safeValue });
                    }}
                    disabled={!generalSettings.mirrorTimeoutEnabled}
                  />
                </div>
              </div>

              <div>
                <p className="text-[9px] uppercase tracking-[0.28em] text-white/25 mb-3">Language / Dil</p>
                <div className="flex gap-3">
                  {LANGUAGES.map(lang => {
                    const isActive = (generalSettings.language || 'en') === lang.id;
                    return (
                      <button
                        key={lang.id}
                        type="button"
                        onClick={() => handleGeneralSettingChange({ language: lang.id })}
                        className="flex-1 rounded-xl px-4 py-3 text-left transition-all duration-200"
                        style={{
                          border: isActive ? '1px solid rgba(255,255,255,0.25)' : '1px solid rgba(255,255,255,0.07)',
                          background: isActive ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                          boxShadow: isActive ? '0 0 30px var(--mirror-accent-soft)' : undefined
                        }}
                      >
                        <div className="text-sm font-medium text-white/80">{lang.nativeLabel}</div>
                        <div className="text-xs text-white/30">{lang.label}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Users section ─────────────────────────────────────────────────── */}
        <div className="mb-10">
          <div className="rounded-2xl p-6" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.025)' }}>

            {/* ── Current session status ──────────────────────────────────────── */}
            {guestMode ? (
              <div className="mb-6 flex items-center justify-between gap-4 rounded-xl px-4 py-3"
                style={{ border: '1px solid rgba(251,191,36,0.2)', background: 'rgba(251,191,36,0.05)' }}>
                <div className="flex items-center gap-3">
                  <svg className="w-4 h-4 text-amber-400/70 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                  </svg>
                  <div>
                    <p className="text-xs font-medium text-amber-400/80">Guest mode</p>
                    <p className="text-[10px] text-white/30">No account linked — limited to local widgets</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Link
                    to="/pairing"
                    className="rounded-lg px-3 py-1.5 text-xs text-white/60 transition-all hover:text-white/90"
                    style={{ border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.04)' }}
                  >
                    Sign in
                  </Link>
                  <button
                    onClick={exitGuest}
                    className="rounded-lg px-3 py-1.5 text-xs text-amber-400/70 transition-all hover:text-amber-300/90"
                    style={{ border: '1px solid rgba(251,191,36,0.2)' }}
                  >
                    Exit guest
                  </button>
                </div>
              </div>
            ) : (
              <div className="mb-6 flex items-center justify-between gap-4 rounded-xl px-4 py-3"
                style={{ border: '1px solid rgba(52,211,153,0.15)', background: 'rgba(52,211,153,0.04)' }}>
                <div className="flex items-center gap-3">
                  <svg className="w-4 h-4 text-emerald-400/70 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div>
                    <p className="text-xs font-medium text-emerald-400/70">
                      {backendActiveId !== null
                        ? `Signed in as ${backendProfiles.find(p => p.id === backendActiveId)?.name || 'user'}`
                        : 'Mirror linked'}
                    </p>
                    <p className="text-[10px] text-white/30">Account connected via mobile app</p>
                  </div>
                </div>
                <Link
                  to="/pairing"
                  className="rounded-lg px-3 py-1.5 text-xs text-white/40 transition-all hover:text-white/70 flex-shrink-0"
                  style={{ border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  Pairing
                </Link>
              </div>
            )}

            <div className="mb-6">
              <p className="text-[9px] uppercase tracking-[0.28em] text-white/25 mb-1">Identity</p>
              <h2
                className="text-xl font-normal text-white/80"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >Users</h2>
              <p className="text-xs text-white/30 mt-1">
                Users are set from the mobile app. No login needed on the mirror.
              </p>
            </div>

            {/* Mirror ID */}
            <div className="mb-6">
              <p className="text-[9px] uppercase tracking-[0.28em] text-white/25 mb-3">Mirror ID</p>
              <div className="flex flex-col md:flex-row items-start gap-5">
                {/* QR code for quick phone linking */}
                <div className="rounded-xl overflow-hidden flex-shrink-0" style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)', padding: '10px' }}>
                  <MirrorIdQRCode mirrorId={backendApi.getMirrorId()} size={140} />
                </div>
                <div className="flex-1 min-w-0 w-full">
                  <p className="text-xs text-white/35 mb-2">Scan with the mobile app to link instantly, or copy the ID below.</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-lg px-3 py-2 text-xs text-white/50 font-mono tracking-wider break-all select-all" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                      {backendApi.getMirrorId()}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyMirrorId}
                      className="text-xs rounded-lg px-3 py-2 text-white/35 transition-all duration-150 hover:text-white/65 whitespace-nowrap"
                      style={{
                        border: '1px solid rgba(255,255,255,0.07)',
                        color: mirrorIdCopied ? 'var(--mirror-accent-color,#38bdf8)' : undefined
                      }}
                    >
                      {mirrorIdCopied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-[10px] text-white/20 mt-2">
                    Open the mobile app → profile → "Show on Mirror".
                  </p>
                </div>
              </div>
            </div>

            {/* ── Account switcher — always visible ─────────────────────────── */}
            <div className="space-y-3">
              <p className="text-[9px] uppercase tracking-[0.28em] text-white/25">Switch Account</p>

              {/* Dropdown — disabled when no accounts are linked */}
              <div className="relative">
                {/* Avatar bubble inside the select when an account is active */}
                {backendActiveId !== null && (() => {
                  const active = backendProfiles.find(p => p.id === backendActiveId);
                  if (!active) return null;
                  return (
                    <div
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold z-10"
                      style={{ backgroundColor: 'var(--mirror-accent-color,#38bdf8)', color: '#000' }}
                    >
                      {active.name.charAt(0).toUpperCase()}
                    </div>
                  );
                })()}

                <select
                  value={backendActiveId ?? ''}
                  disabled={backendProfiles.length === 0}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    if (id) handleSwitchUser(id);
                  }}
                  className="w-full rounded-xl py-3 pr-10 text-sm appearance-none transition-all duration-150 focus:outline-none"
                  style={{
                    paddingLeft: backendActiveId !== null ? '2.75rem' : '1rem',
                    border: backendProfiles.length === 0
                      ? '1px solid rgba(255,255,255,0.07)'
                      : '1px solid rgba(var(--mirror-accent-rgb,56,189,248),0.35)',
                    background: backendProfiles.length === 0
                      ? 'rgba(255,255,255,0.02)'
                      : 'rgba(var(--mirror-accent-rgb,56,189,248),0.06)',
                    color: backendProfiles.length === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.75)',
                    cursor: backendProfiles.length === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {backendProfiles.length === 0 ? (
                    <option value="" style={{ background: '#111', color: 'rgba(255,255,255,0.3)' }}>
                      No accounts linked yet
                    </option>
                  ) : (
                    <>
                      {backendActiveId === null && (
                        <option value="" disabled style={{ background: '#111' }}>
                          — select an account —
                        </option>
                      )}
                      {backendProfiles.map(profile => (
                        <option key={profile.id} value={profile.id} style={{ background: '#111', color: '#fff' }}>
                          {profile.name}{profile.gmail_connected && profile.email ? ` · ${profile.email}` : ''}
                        </option>
                      ))}
                    </>
                  )}
                </select>

                {/* Chevron icon */}
                <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
                  style={{ color: backendProfiles.length === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.35)' }}>
                  <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 6l4 4 4-4"/>
                  </svg>
                </div>
              </div>

              {/* Empty-state hint */}
              {backendProfiles.length === 0 && (
                <p className="text-xs text-white/25 italic">
                  Open the mobile app → go to a profile → tap "Show on Mirror" to link an account.
                </p>
              )}

              {/* Account list — only rendered when 2+ accounts are linked */}
              {backendProfiles.length > 1 && (
                <div className="space-y-1 pt-1">
                  <p className="text-[9px] uppercase tracking-[0.28em] text-white/20 pb-1">All linked accounts</p>
                  {backendProfiles.map(profile => {
                    const isActive = profile.id === backendActiveId;
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        onClick={() => handleSwitchUser(profile.id)}
                        className="group w-full flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-150 text-left"
                        style={{
                          border: isActive
                            ? '1px solid rgba(var(--mirror-accent-rgb,56,189,248),0.3)'
                            : '1px solid rgba(255,255,255,0.06)',
                          background: isActive
                            ? 'rgba(var(--mirror-accent-rgb,56,189,248),0.06)'
                            : 'rgba(255,255,255,0.01)',
                        }}
                      >
                        <div
                          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
                          style={{
                            backgroundColor: isActive ? 'var(--mirror-accent-color,#38bdf8)' : 'rgba(255,255,255,0.07)',
                            color: isActive ? '#000' : 'rgba(255,255,255,0.35)',
                          }}
                        >
                          {profile.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-white/70 truncate">{profile.name}</div>
                          {profile.gmail_connected && profile.email && (
                            <div className="text-xs text-white/25 truncate">{profile.email}</div>
                          )}
                        </div>
                        <span className="text-[9px] uppercase tracking-widest flex-shrink-0"
                          style={{ color: isActive ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.15)' }}>
                          {isActive ? 'active' : 'switch'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Sign Out + Delete — visible when profiles exist, disabled when none is active */}
              {backendProfiles.length > 0 && (() => {
                const activeName = backendProfiles.find(p => p.id === backendActiveId)?.name || 'User';
                const noActive = backendActiveId === null;
                return (
                  <div className="flex flex-wrap gap-3 pt-3 border-t border-white/[0.06]">
                    <button
                      type="button"
                      disabled={noActive || isSigningOut}
                      onClick={handleSignOut}
                      className="flex items-center gap-2 rounded-lg px-4 py-2 text-xs text-white/50 transition-all duration-150 hover:text-white/80 disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ border: '1px solid rgba(255,255,255,0.1)' }}
                      title={noActive ? 'Select an account first' : undefined}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3M6.5 11 3 8l3.5-3M3 8h8" />
                      </svg>
                      {isSigningOut ? 'Signing out…' : noActive ? 'Sign out' : `Sign out (${activeName})`}
                    </button>

                    <button
                      type="button"
                      disabled={noActive}
                      onClick={() => setShowDeleteConfirm(true)}
                      className="flex items-center gap-2 rounded-lg px-4 py-2 text-xs text-red-400/70 transition-all duration-150 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ border: '1px solid rgba(239,68,68,0.2)' }}
                      title={noActive ? 'Select an account first' : undefined}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-9" />
                      </svg>
                      Delete account
                    </button>

                    {showDeleteConfirm && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.75)' }}>
                        <div className="w-full max-w-sm rounded-2xl p-6 space-y-4" style={{ border: '1px solid rgba(239,68,68,0.25)', background: '#0d0d0d' }}>
                          <div>
                            <p className="text-sm font-medium text-white/85">Delete account?</p>
                            <p className="text-xs text-white/40 mt-1">
                              This will permanently remove <span className="text-white/70 font-medium">{activeName}</span>'s profile, face data, Gmail and Spotify connections. This cannot be undone.
                            </p>
                          </div>
                          <div className="flex gap-3 pt-1">
                            <button
                              type="button"
                              onClick={() => setShowDeleteConfirm(false)}
                              className="flex-1 rounded-lg py-2 text-xs text-white/40 transition-colors hover:text-white/65"
                              style={{ border: '1px solid rgba(255,255,255,0.08)' }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={isDeletingAccount}
                              onClick={handleDeleteAccount}
                              className="flex-1 rounded-lg py-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/30 disabled:opacity-40"
                              style={{ border: '1px solid rgba(239,68,68,0.35)' }}
                            >
                              {isDeletingAccount ? 'Deleting…' : 'Delete account'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        {/* ── AI Assistant section ───────────────────────────────────────────── */}
        <div className="mb-10">
          <div className="rounded-2xl p-6" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.025)' }}>
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-8">
              <div>
                <p className="text-[9px] uppercase tracking-[0.28em] text-white/25 mb-1">Voice</p>
                <h2
                  className="text-xl font-normal text-white/80"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >AI Assistant</h2>
                <p className="text-xs text-white/30 mt-1">
                  Configure the realtime voice assistant that responds when you say "Hey Mirror".
                </p>
              </div>
              <div className="flex items-center justify-between md:justify-end w-full md:w-auto gap-4">
                <div>
                  <p className="text-sm text-white/65">Enable AI Assistant</p>
                  <p className="text-xs text-white/30 mt-0.5">
                    Listens for your custom hotword.
                  </p>
                </div>
                <label className="lux-toggle">
                  <input
                    type="checkbox"
                    checked={aiAssistantSettings.enabled}
                    onChange={(event) => handleToggleAiAssistant(event.target.checked)}
                  />
                  <div className="lux-toggle-track"><div className="lux-toggle-slider" /></div>
                </label>
              </div>
            </div>

            {!assistantSettings.apiKey && (
              <div className="rounded-lg px-4 py-3 text-xs text-amber-200/70 mb-6" style={{ border: '1px solid rgba(245,158,11,0.15)', background: 'rgba(245,158,11,0.06)' }}>
                Add your OpenAI API key to enable the realtime conversation experience.
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-[9px] uppercase tracking-[0.28em] text-white/25 mb-2">Voice (Realtime) Model</label>
                <select
                  value={assistantSettings.realtimeModel || REALTIME_MODELS[0].value}
                  onChange={(e) => handleAiAssistantSettingChange('realtimeModel', e.target.value)}
                  className="lux-select"
                >
                  {REALTIME_MODELS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[9px] uppercase tracking-[0.28em] text-white/25 mb-2">Chat (Text / Fallback) Model</label>
                <select
                  value={assistantSettings.chatModel || CHAT_MODELS[0].value}
                  onChange={(e) => handleAiAssistantSettingChange('chatModel', e.target.value)}
                  className="lux-select"
                >
                  {CHAT_MODELS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[9px] uppercase tracking-[0.28em] text-white/25 mb-2">Voice</label>
                <select
                  value={assistantSettings.voice || VOICE_OPTIONS[0].value}
                  onChange={(e) => handleAiAssistantSettingChange('voice', e.target.value)}
                  className="lux-select"
                >
                  {VOICE_OPTIONS.map(voice => (
                    <option key={voice.value} value={voice.value}>
                      {voice.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-[9px] uppercase tracking-[0.28em] text-white/25 mb-2">OpenAI API Key</label>
                <div className="flex items-center gap-2">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={assistantSettings.apiKey || ''}
                    onChange={(e) => handleAiAssistantSettingChange('apiKey', e.target.value)}
                    placeholder="sk-..."
                    className="lux-input flex-1"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(prev => !prev)}
                    className="text-[10px] uppercase tracking-[0.2em] text-white/30 rounded-lg px-3 py-2 transition-colors hover:text-white/60 whitespace-nowrap"
                    style={{ border: '1px solid rgba(255,255,255,0.07)' }}
                  >
                    {showApiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p className="text-[10px] text-white/20 mt-2">
                  Stored locally — used only to connect directly to OpenAI.
                </p>
              </div>
              <div>
                <label className="block text-[9px] uppercase tracking-[0.28em] text-white/25 mb-2">Assistant Name</label>
                <input
                  type="text"
                  value={assistantSettings.name ?? ''}
                  onChange={(event) => handleAiAssistantSettingChange('name', event.target.value)}
                  className="lux-input"
                  placeholder="Mirror"
                  disabled={!aiAssistantSettings.enabled}
                />
                <p className="text-[10px] text-white/20 mt-2">
                  Listens for <span className="text-white/45">"Hey {assistantSettings.name || 'Mirror'}"</span>.
                </p>
              </div>
              <div>
                <label className="block text-[9px] uppercase tracking-[0.28em] text-white/25 mb-2">ElevenLabs API Key</label>
                <input
                  type="password"
                  value={assistantSettings.elevenLabsKey || ''}
                  onChange={(e) => handleAiAssistantSettingChange('elevenLabsKey', e.target.value)}
                  className="lux-input"
                  placeholder="sk_..."
                  disabled={!aiAssistantSettings.enabled}
                />
                <p className="text-[10px] text-white/20 mt-2">
                  For high-quality voice output. Leave blank to use browser fallback.
                </p>
              </div>
              <div>
                <label className="block text-[9px] uppercase tracking-[0.28em] text-white/25 mb-2">ElevenLabs Voice ID</label>
                <input
                  type="text"
                  value={assistantSettings.elevenLabsVoiceId || ''}
                  onChange={(e) => handleAiAssistantSettingChange('elevenLabsVoiceId', e.target.value)}
                  className="lux-input"
                  placeholder="JBFqnCBsd6RMkjVDRZzb"
                  disabled={!aiAssistantSettings.enabled}
                />
                <p className="text-[10px] text-white/20 mt-2">
                  Find IDs at elevenlabs.io/voice-lab. Default: George (British).
                </p>
              </div>
              <div className="md:col-span-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assistantSettings.showRawTranscripts || false}
                    onChange={(event) => handleAiAssistantSettingChange('showRawTranscripts', event.target.checked)}
                    className="lux-checkbox"
                    disabled={!aiAssistantSettings.enabled}
                  />
                  <span className="text-sm text-white/55">Show raw speech-to-text for debugging</span>
                </label>
                <p className="text-[10px] text-white/20 mt-1.5 ml-[19px]">
                  Displays the live transcript to confirm hotword detection.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Integrations section (Replicate / virtual try-on) ───────────────── */}
        <div className="mb-10">
          <div className="rounded-2xl p-6" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.025)' }}>
            <div className="mb-6">
              <p className="text-[9px] uppercase tracking-[0.28em] text-white/25 mb-1">Wardrobe</p>
              <h2
                className="text-xl font-normal text-white/80"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >Integrations</h2>
              <p className="text-xs text-white/30 mt-1">
                Connect Replicate to enable virtual try-on renders in the Wardrobe widget.
              </p>
            </div>

            <div className="md:col-span-2">
              <div className="flex items-center justify-between mb-2">
                <label className="block text-[9px] uppercase tracking-[0.28em] text-white/25">Replicate API Key</label>
                {integrations?.replicate?.configured ? (
                  <span className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/70">Configured</span>
                ) : (
                  <span className="text-[10px] uppercase tracking-[0.2em] text-amber-200/60">Not set</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type={showReplicateKey ? 'text' : 'password'}
                  value={replicateKeyInput}
                  onChange={(e) => setReplicateKeyInput(e.target.value)}
                  placeholder={integrations?.replicate?.configured ? '•••••••• (enter a new key to replace)' : 'r8_...'}
                  className="lux-input flex-1"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowReplicateKey((prev) => !prev)}
                  className="text-[10px] uppercase tracking-[0.2em] text-white/30 rounded-lg px-3 py-2 transition-colors hover:text-white/60 whitespace-nowrap"
                  style={{ border: '1px solid rgba(255,255,255,0.07)' }}
                >
                  {showReplicateKey ? 'Hide' : 'Show'}
                </button>
                <button
                  type="button"
                  onClick={handleSaveReplicate}
                  disabled={savingReplicate || !replicateKeyInput.trim()}
                  className="text-[10px] uppercase tracking-[0.2em] text-white/70 rounded-lg px-4 py-2 transition-colors hover:text-white disabled:opacity-30 whitespace-nowrap"
                  style={{ border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)' }}
                >
                  {savingReplicate ? 'Saving…' : replicateSaved ? 'Saved ✓' : 'Save'}
                </button>
              </div>
              <p className="text-[10px] text-white/20 mt-2">
                Stored securely on the mirror's backend (never in the browser). Get a key at replicate.com/account/api-tokens.
                Live try-on also needs the backend reachable from the internet (PUBLIC_BASE_URL).
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* App List */}
        <div className="lg:col-span-1">
          <p className="text-[9px] uppercase tracking-[0.3em] text-white/25 mb-1">Modules</p>
          <h2
            className="text-xl font-normal text-white/80 mb-5"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >Apps</h2>
            <div className="space-y-2">
              {apps.map(app => (
                <div
                  key={app.id}
                  className="p-4 rounded-xl cursor-pointer transition-all duration-200"
                  style={{
                    border: selectedApp?.id === app.id
                      ? '1px solid rgba(255,255,255,0.20)'
                      : '1px solid rgba(255,255,255,0.07)',
                    background: selectedApp?.id === app.id
                      ? 'rgba(255,255,255,0.06)'
                      : 'rgba(255,255,255,0.02)'
                  }}
                  onClick={() => setSelectedApp(app)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm text-white/80">{app.name}</p>
                      <p className="text-xs text-white/30 mt-0.5">{app.description}</p>
                    </div>
                    <label className="lux-toggle" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isAppEnabled(app.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          handleToggleApp(app.id, e.target.checked);
                        }}
                      />
                      <div className="lux-toggle-track"><div className="lux-toggle-slider" /></div>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* App Settings */}
          <div className="lg:col-span-2">
            {selectedApp ? (
              <div>
                <p className="text-[9px] uppercase tracking-[0.3em] text-white/25 mb-1">Configure</p>
                <h2
                  className="text-xl font-normal text-white/80 mb-5"
                  style={{ fontFamily: "'Playfair Display', serif" }}
                >{selectedApp.name}</h2>
                <div className="rounded-2xl p-6" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.025)' }}>
                  {isAppEnabled(selectedApp.id) ? (
                    renderAppSettings(selectedApp)
                  ) : (
                    <div className="text-center py-10">
                      <p className="text-xs text-white/25">Enable this app to configure its settings</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl p-6 flex items-center justify-center" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.025)', minHeight: '200px' }}>
                <p className="text-xs text-white/20">Select an app to configure its settings</p>
              </div>
            )}
          </div>
        </div>

        {/* Device pairing section */}
        <div className="mt-8 rounded-2xl p-6" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
          <p className="text-[9px] uppercase tracking-[0.28em] text-white/25 mb-1">Device</p>
          <p className="text-sm text-white/55 mb-1">Pairing &amp; account</p>
          <p className="mb-4 text-xs text-white/28">
            {guestMode
              ? 'Open the pairing screen to sign in with the mobile app and link an account.'
              : 'View pairing QR, check link status, or unlink this mirror from its current account.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/pairing"
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs transition-all duration-150"
              style={{
                border: guestMode ? '1px solid rgba(56,189,248,0.35)' : '1px solid rgba(255,255,255,0.1)',
                color: guestMode ? 'rgba(56,189,248,0.85)' : 'rgba(255,255,255,0.5)',
                background: guestMode ? 'rgba(56,189,248,0.06)' : 'transparent',
              }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="1" width="5" height="5" rx="0.5"/>
                <rect x="10" y="1" width="5" height="5" rx="0.5"/>
                <rect x="1" y="10" width="5" height="5" rx="0.5"/>
                <rect x="2.5" y="2.5" width="2" height="2" fill="currentColor" stroke="none"/>
                <rect x="11.5" y="2.5" width="2" height="2" fill="currentColor" stroke="none"/>
                <rect x="2.5" y="11.5" width="2" height="2" fill="currentColor" stroke="none"/>
                <path d="M10 10h2v2h-2zM12 12h3M12 10h3v2"/>
              </svg>
              {guestMode ? 'Sign in / Pair device' : 'Open pairing screen'}
            </Link>
            {guestMode && (
              <button
                onClick={exitGuest}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs text-amber-400/70 transition-all duration-150 hover:text-amber-300/90"
                style={{ border: '1px solid rgba(251,191,36,0.2)' }}
              >
                Exit guest mode
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

export default Settings;
