const STORAGE_KEY = 'smartMirrorSettings';

const SETTINGS_VERSION = 2;

const DEFAULT_SETTINGS = {
  enabled: true,
  settingsVersion: SETTINGS_VERSION,
  settings: {
    name: 'Alex',
    showRawTranscripts: false,
    apiKey: '',
    model: 'gpt-4o-mini-realtime-preview',
    voice: 'alloy'
  }
};

const readSettings = () => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (error) {
    console.warn('Unable to read smart mirror settings from storage', error);
    return {};
  }
};

const writeSettings = (settings) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};

const ensureAssistant = (settings) => {
  if (!settings.aiAssistant) {
    settings.aiAssistant = {
      ...DEFAULT_SETTINGS,
      settings: { ...DEFAULT_SETTINGS.settings }
    };
    return settings;
  }

  const needsMigration = !settings.aiAssistant.settingsVersion;
  const oldSettings = settings.aiAssistant.settings || {};

  settings.aiAssistant = {
    // If migrating from v1 (old default was false), upgrade to true
    enabled: needsMigration
      ? true
      : (settings.aiAssistant.enabled ?? DEFAULT_SETTINGS.enabled),
    settingsVersion: SETTINGS_VERSION,
    settings: {
      ...DEFAULT_SETTINGS.settings,
      ...oldSettings,
      // If migrating and name was still the old default, upgrade to 'Alex'
      ...(needsMigration && oldSettings.name === 'Mirror' ? { name: 'Alex' } : {}),
    }
  };

  if (needsMigration) settings._migrated = true;
  return settings;
};

export const getAiAssistantSettings = () => {
  const settings = ensureAssistant(readSettings());
  if (settings._migrated) {
    delete settings._migrated;
    writeSettings(settings);
  }
  return settings.aiAssistant;
};

export const setAiAssistantEnabled = (enabled) => {
  const settings = ensureAssistant(readSettings());
  settings.aiAssistant.enabled = enabled;
  writeSettings(settings);
};

export const saveAiAssistantSettings = (newSettings) => {
  const settings = ensureAssistant(readSettings());
  settings.aiAssistant.settings = {
    ...settings.aiAssistant.settings,
    ...newSettings
  };
  writeSettings(settings);
};

export const DEFAULT_AI_ASSISTANT_SETTINGS = DEFAULT_SETTINGS;
