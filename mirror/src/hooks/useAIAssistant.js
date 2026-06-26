import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getAiAssistantSettings } from '../data/aiAssistant';
import { mirrorDataStore } from '../services/mirrorDataStore';
import { backendApi } from '../services/backendApi';

const MIRROR_API = (process.env.REACT_APP_API_URL || 'http://localhost:3000').replace(/\/$/, '');

// ── Free web tools (no extra API keys needed) ─────────────────────────────

async function toolWebSearch(query) {
  try {
    // DuckDuckGo Instant Answers — free, no key
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(6000) }
    );
    const d = await res.json();
    const text = d.AbstractText || d.Answer || '';
    if (text) return text;
    const related = (d.RelatedTopics || [])
      .slice(0, 4)
      .map(t => t.Text)
      .filter(Boolean)
      .join(' | ');
    return related || `No instant answer for "${query}". Try rephrasing.`;
  } catch (e) {
    return `Search failed: ${e.message}`;
  }
}

async function toolWikipedia(topic) {
  try {
    const slug = encodeURIComponent(topic.trim().replace(/ /g, '_'));
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) throw new Error('not found');
    const d = await res.json();
    return d.extract || 'No summary available.';
  } catch {
    return await toolWebSearch(topic);
  }
}

async function toolWeather(location) {
  try {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&format=json`,
      { signal: AbortSignal.timeout(6000) }
    );
    const geo = await geoRes.json();
    const place = geo.results?.[0];
    if (!place) return `Could not find location: "${location}"`;

    const { latitude, longitude, name, country } = place;
    const wRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,relative_humidity_2m,precipitation` +
      `&temperature_unit=celsius&windspeed_unit=kmh`,
      { signal: AbortSignal.timeout(6000) }
    );
    const w = await wRes.json();
    const c = w.current;
    const cond = wmoDescription(c.weathercode);
    return (
      `${name}, ${country}: ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C), ` +
      `${cond}. Wind ${c.windspeed_10m} km/h, humidity ${c.relative_humidity_2m}%, ` +
      `precipitation ${c.precipitation} mm.`
    );
  } catch (e) {
    return `Weather lookup failed: ${e.message}`;
  }
}

function wmoDescription(code) {
  if (code === 0) return 'clear sky';
  if (code <= 3) return 'partly cloudy';
  if (code <= 9) return 'foggy conditions';
  if (code <= 29) return 'drizzle';
  if (code <= 39) return 'rain';
  if (code <= 49) return 'snow';
  if (code <= 59) return 'fog';
  if (code <= 69) return 'freezing drizzle';
  if (code <= 79) return 'snow fall';
  if (code <= 84) return 'rain showers';
  if (code <= 94) return 'thunderstorm';
  return 'severe thunderstorm';
}

function toolDatetime() {
  const now = new Date();
  return now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  });
}

// ── Mirror data tools (read from apps currently shown on the mirror) ──────

function toolMirrorEmails() {
  const gmail = mirrorDataStore.getSnapshot().gmail;
  if (!gmail) return 'Gmail data is not loaded on the mirror yet — it may not be enabled or connected.';
  if (!gmail.messages?.length) return 'No emails are currently showing on the mirror.';
  const unread = gmail.unreadCount ?? gmail.messages.filter(m => m.unread).length;
  return JSON.stringify({
    unread_count: unread,
    emails: gmail.messages.map(m => ({
      from:     m.from,
      subject:  m.subject,
      preview:  m.snippet || '',
      received: m.timestamp ? new Date(m.timestamp).toLocaleString() : 'Unknown',
      unread:   m.unread ?? false,
    })),
  }, null, 2);
}

function toolMirrorNews() {
  const news = mirrorDataStore.getSnapshot().news;
  if (!news?.length) return 'No news headlines are loaded on the mirror right now.';
  return JSON.stringify({
    articles: news.map(n => ({
      title:     n.title,
      summary:   n.summary || '',
      source:    n.source,
      published: n.publishedAt ? new Date(n.publishedAt).toLocaleString() : 'Unknown',
    })),
  }, null, 2);
}

function toolMirrorWeather() {
  const w = mirrorDataStore.getSnapshot().weather;
  if (!w) return 'Weather data is not loaded on the mirror right now.';
  const u = w.units === 'fahrenheit' ? '°F' : '°C';
  return JSON.stringify({
    location:    w.location,
    temperature: `${w.temperature}${u}`,
    feels_like:  `${w.feelsLike}${u}`,
    wind_speed:  `${w.windspeed} km/h`,
    condition:   wmoDescription(w.weathercode),
    forecast:    (w.forecast || []).map(f => ({
      date: f.date,
      high: `${f.high}${u}`,
      low:  `${f.low}${u}`,
    })),
  }, null, 2);
}

function toolMirrorNowPlaying() {
  const spotify = mirrorDataStore.getSnapshot().spotify;
  if (!spotify?.connected) return 'Spotify is not connected on this mirror.';
  const p = spotify.playback;
  if (!p?.isPlaying) return 'Nothing is playing on Spotify right now.';
  return JSON.stringify({
    title:    p.title,
    artist:   p.artist,
    progress: p.durationMs
      ? `${Math.round((p.progressMs || 0) / 1000)}s / ${Math.round(p.durationMs / 1000)}s`
      : undefined,
  }, null, 2);
}

async function toolSpotifyControl(action) {
  const mid = backendApi.getMirrorId();
  try {
    const res = await fetch(`${MIRROR_API}/api/mirrors/spotify/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mid, action }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return err.error || `Spotify control failed (${res.status})`;
    }
    return `Done — ${action} sent to Spotify.`;
  } catch (e) {
    return `Spotify control failed: ${e.message}`;
  }
}

async function toolSpotifyPlayTrack(query) {
  const mid = backendApi.getMirrorId();
  try {
    const res = await fetch(`${MIRROR_API}/api/mirrors/spotify/play-track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mid, query }),
    });
    const data = await res.json();
    if (!res.ok) return data.error || `Play failed (${res.status})`;
    return `Now playing "${data.track.name}" by ${data.track.artist}.`;
  } catch (e) {
    return `Spotify play track failed: ${e.message}`;
  }
}

// ── Tool registry ─────────────────────────────────────────────────────────

const TOOLS_OPENAI = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the internet for current information, news, or any facts you are unsure about. Use this whenever the question involves recent events or real-world data.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather conditions for any city or location in the world.',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', description: 'City or place name' } },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Get the current date and time.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wikipedia_search',
      description: 'Look up detailed background information about any topic on Wikipedia.',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string', description: 'Topic to search' } },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_mirror_emails',
      description: "Get the user's Gmail emails currently shown on this mirror. Use this whenever they ask about their inbox, emails, messages, or anything Gmail-related.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_mirror_news',
      description: 'Get the news headlines currently displayed on this mirror. Use this when the user asks about news, headlines, or what is in the news today.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_mirror_weather',
      description: "Get the weather currently shown on this mirror for the user's location. Prefer this over fetching weather externally when the user asks about their local weather.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_mirror_now_playing',
      description: 'Get what is currently playing on Spotify as shown on this mirror.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spotify_control',
      description: 'Control Spotify playback on this mirror: play, pause, skip to next or go back to the previous track.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'next', 'previous'],
            description: 'Playback action to perform',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spotify_play_track',
      description: 'Search Spotify for a song or artist and start playing the top result.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Song name, artist name, or both — e.g. "Blinding Lights The Weeknd"',
          },
        },
        required: ['query'],
      },
    },
  },
];

// Realtime API uses a flatter tool schema
const TOOLS_REALTIME = TOOLS_OPENAI.map(t => ({
  type: 'function',
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
}));

async function executeTool(name, args) {
  switch (name) {
    case 'web_search':           return await toolWebSearch(args.query || '');
    case 'get_weather':          return await toolWeather(args.location || '');
    case 'get_datetime':         return toolDatetime();
    case 'wikipedia_search':     return await toolWikipedia(args.topic || '');
    case 'get_mirror_emails':    return toolMirrorEmails();
    case 'get_mirror_news':      return toolMirrorNews();
    case 'get_mirror_weather':   return toolMirrorWeather();
    case 'get_mirror_now_playing': return toolMirrorNowPlaying();
    case 'spotify_control':        return await toolSpotifyControl(args.action || 'pause');
    case 'spotify_play_track':     return await toolSpotifyPlayTrack(args.query || '');
    default:                       return `Unknown tool: ${name}`;
  }
}

// ── Lightweight RAG (conversation memory) ────────────────────────────────

const HISTORY_KEY = 'sm_ai_conversation';
const MAX_STORED   = 40; // turns to persist in localStorage
const MAX_CONTEXT  = 8;  // turns to include in each request

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function saveHistory(history) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_STORED))); }
  catch {}
}

/** Simple keyword retrieval: find past turns most relevant to the current query. */
function retrieveContext(history, query) {
  if (!history.length || !query) return [];
  const keywords = query.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  if (!keywords.length) return [];
  const scored = history
    .map((h, idx) => ({
      ...h,
      score: keywords.filter(kw => (h.content || '').toLowerCase().includes(kw)).length,
      idx,
    }))
    .filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score || b.idx - a.idx)
    .slice(0, 4);
  return scored.map(({ score, idx, ...h }) => h);
}

// ── Main hook ─────────────────────────────────────────────────────────────

export function useAIAssistant() {
  // ── Settings ─────────────────────────────────────────────────────────
  const [rawSettings, setRawSettings] = useState(() => getAiAssistantSettings());

  const cfg = useMemo(() => {
    const s = rawSettings.settings || {};
    return {
      enabled:           Boolean(rawSettings.enabled),
      apiKey:            (s.apiKey || '').trim(),
      // Chat model — latest gpt-4o family by default
      chatModel:         s.chatModel || (s.model?.includes('realtime') ? 'gpt-4o' : (s.model || 'gpt-4o')),
      // Realtime WebRTC model
      realtimeModel:     s.realtimeModel || 'gpt-4o-realtime-preview',
      voice:             s.voice || 'alloy',
      name:              s.name || 'Alex',
      elevenLabsKey:     (s.elevenLabsKey || '').trim(),
      elevenLabsVoiceId: (s.elevenLabsVoiceId || '').trim() || 'JBFqnCBsd6RMkjVDRZzb',
    };
  }, [rawSettings]);

  // Keep a ref so callbacks never go stale
  const cfgRef = useRef(cfg);
  useEffect(() => { cfgRef.current = cfg; }, [cfg]);

  // ── UI state ──────────────────────────────────────────────────────────
  const [isOpen,      setIsOpen]      = useState(false);
  const [status,      setStatus]      = useState('idle');
  // idle | connecting | listening | thinking | speaking | error
  const [statusMsg,   setStatusMsg]   = useState('');
  const [errorMsg,    setErrorMsg]    = useState('');
  const [volume,      setVolume]      = useState(0);
  const [userText,    setUserText]    = useState('');   // last user utterance
  const [aiText,      setAiText]      = useState('');   // streaming AI response
  const [history,     setHistory]     = useState(() => loadHistory());
  const [speechOk,    setSpeechOk]    = useState(false);
  const [micError,    setMicError]    = useState('');

  // ── Imperative refs ───────────────────────────────────────────────────
  const isOpenRef       = useRef(false);
  const statusRef       = useRef('idle');
  const cooldownRef     = useRef(false);
  const sessionRef        = useRef(false);  // local Chat+TTS session active
  const pendingMessageRef = useRef(null);   // message queued while Alex is speaking
  const isSpeakingRef     = useRef(false);  // true while TTS audio is playing
  const inactivityRef   = useRef(null);
  const abortRef        = useRef(null);

  // WebRTC
  const pcRef           = useRef(null);
  const dcRef           = useRef(null);
  const micStreamRef    = useRef(null);
  const remoteAudioRef  = useRef(null);  // rendered by SmartMirror as <audio>
  const audioCtxRef     = useRef(null);
  const analyserRef     = useRef(null);
  const volRafRef       = useRef(null);
  const audioUnlockedRef = useRef(false);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const ttsAudioRef     = useRef(null);  // ElevenLabs TTS playback

  // Speech recognition
  const recognitionRef    = useRef(null);
  const lastSpeechMsRef   = useRef(0); // timestamp of last SpeechRecognition result
  const sessionOpenTimeRef = useRef(0); // timestamp when session last opened

  // VAD + Whisper (Pi fallback when webkitSpeechRecognition has no Google key)
  const vadEnabledRef   = useRef(false);
  const vadStreamRef    = useRef(null);
  const vadACtxRef      = useRef(null);
  const vadRafRef       = useRef(null);
  const vadRecorderRef  = useRef(null);
  const vadChunksRef    = useRef([]);
  const vadActiveRef    = useRef(false);
  const vadSilenceRef   = useRef(null);
  const vadBusyRef      = useRef(false);

  // ── Sync refs ─────────────────────────────────────────────────────────
  useEffect(() => { isOpenRef.current  = isOpen;  }, [isOpen]);
  useEffect(() => { statusRef.current  = status;  }, [status]);

  // ── Settings reload ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = () => setRawSettings(getAiAssistantSettings());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────

  const setUiStatus = useCallback((s, msg = '', err = '') => {
    setStatus(s);
    statusRef.current = s;
    setStatusMsg(msg);
    setErrorMsg(err);
  }, []);

  const open = useCallback(() => {
    setIsOpen(true);
    isOpenRef.current = true;
  }, []);

  // ── Audio ─────────────────────────────────────────────────────────────

  const playDing = useCallback(async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AC();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const t = ctx.currentTime;
      osc.frequency.setValueAtTime(880, t);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.65);
    } catch {}
  }, []);

  const speak = useCallback(async (text) => {
    if (!text) return;
    const { elevenLabsKey, elevenLabsVoiceId } = cfgRef.current;

    // Stop any currently playing TTS audio
    if (ttsAudioRef.current) {
      try { ttsAudioRef.current.stop(); } catch {}
      ttsAudioRef.current = null;
    }

    if (elevenLabsKey) {
      try {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': elevenLabsKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text,
              model_id: 'eleven_turbo_v2_5',
              voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            }),
          }
        );
        if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
        const arrayBuffer = await res.arrayBuffer();

        // Play through AudioContext to bypass browser autoplay restrictions
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
          audioCtxRef.current = new AC();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') await ctx.resume();

        const decoded = await ctx.decodeAudioData(arrayBuffer);
        const source = ctx.createBufferSource();
        source.buffer = decoded;
        source.connect(ctx.destination);
        ttsAudioRef.current = source;
        isSpeakingRef.current = true;
        source.start(0);
        await new Promise(resolve => { source.onended = resolve; });
        isSpeakingRef.current = false;
        ttsAudioRef.current = null;
        return;
      } catch (err) {
        isSpeakingRef.current = false;
        console.error('[TTS] ElevenLabs error, falling back to browser TTS:', err);
      }
    }

    // Fallback: browser speechSynthesis
    if (!window.speechSynthesis) return;
    const go = () => {
      // Chrome bug: cancel() + immediate speak() = silence — wait one tick
      window.speechSynthesis.cancel();
      setTimeout(() => {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        const utt = new SpeechSynthesisUtterance(text);
        utt.lang = 'en-US';
        // Pick a real English voice if available (avoids robotic default on Pi)
        const voices = window.speechSynthesis.getVoices();
        const eng = voices.find(v => v.lang.startsWith('en') && v.default)
          || voices.find(v => v.lang.startsWith('en'))
          || voices[0];
        if (eng) utt.voice = eng;
        utt.onerror = (e) => console.error('[TTS] SpeechSynthesis error:', e.error);
        window.speechSynthesis.speak(utt);
      }, 50);
    };
    if (window.speechSynthesis.getVoices().length > 0) {
      go();
    } else {
      // voiceschanged may never fire on embedded Chromium — add a 600ms timeout fallback
      let fired = false;
      const onVoicesChanged = () => { if (!fired) { fired = true; go(); } };
      window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged, { once: true });
      setTimeout(() => { if (!fired) { fired = true; go(); } }, 600);
    }
  }, []);

  // ── VAD + Whisper (Pi wake word fallback) ────────────────────────────

  const transcribeVADChunk = useCallback(async (blob) => {
    const { apiKey } = cfgRef.current;
    console.log(`[Whisper] blob ${blob.size} bytes, apiKey=${apiKey ? 'set' : 'MISSING'}`);
    if (!apiKey) {
      console.warn('[Whisper] No API key — set one in Settings → AI Assistant');
      vadBusyRef.current = false;
      return;
    }
    if (blob.size < 500) {
      console.log('[Whisper] blob too small, skipping');
      vadBusyRef.current = false;
      return;
    }
    try {
      const { name } = cfgRef.current;
      const form = new FormData();
      form.append('file', blob, 'audio.webm');
      form.append('model', 'whisper-1');
      form.append('language', 'en');
      form.append('temperature', '0');
      form.append('prompt', `Hey ${name || 'Alex'}, Hey Mirror.`);
      const whisperAbort = new AbortController();
      const whisperTimer = setTimeout(() => whisperAbort.abort(), 8000);
      let res;
      try {
        res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: whisperAbort.signal,
        });
      } finally {
        clearTimeout(whisperTimer);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[Whisper] API error ${res.status}: ${body}`);
      } else {
        const { text = '' } = await res.json();
        const lower = text.trim().toLowerCase();
        console.log('[Whisper] transcript:', lower || '(empty)');
        if (lower && Date.now() - lastSpeechMsRef.current > 300) {
          speechHandlerRef.current(lower);
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[Whisper VAD] error:', e.message);
    }
    vadBusyRef.current = false;
  }, []);

  const stopVAD = useCallback(() => {
    vadEnabledRef.current = false;
    if (vadRafRef.current) { clearTimeout(vadRafRef.current); vadRafRef.current = null; }
    if (vadSilenceRef.current) { clearTimeout(vadSilenceRef.current); vadSilenceRef.current = null; }
    if (vadRecorderRef.current?.state === 'recording') {
      try { vadRecorderRef.current.stop(); } catch {}
    }
    if (vadStreamRef.current) {
      vadStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
      vadStreamRef.current = null;
    }
    if (vadACtxRef.current) {
      try { vadACtxRef.current.close(); } catch {}
      vadACtxRef.current = null;
    }
    vadChunksRef.current = [];
    vadActiveRef.current = false;
  }, []);

  const startVAD = useCallback(async () => {
    if (vadEnabledRef.current || vadStreamRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
      });
      vadStreamRef.current = stream;
      vadEnabledRef.current = true;

      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('No AudioContext support');
      const ctx = new AC();
      vadACtxRef.current = ctx;

      // Chromium autoplay policy: AudioContext starts suspended without a user gesture.
      // getByteFrequencyData returns all-zeros when suspended → RMS always 0 → voice never detected.
      // Try resume immediately; if it fails, wire a one-shot listener for the next user interaction.
      const tryResume = () => {
        if (vadACtxRef.current?.state === 'suspended') {
          vadACtxRef.current.resume().catch(() => {});
        }
      };
      tryResume();
      if (ctx.state === 'suspended') {
        const events = ['click', 'touchstart', 'keydown', 'pointerdown'];
        const onInteract = () => {
          tryResume();
          events.forEach(e => document.removeEventListener(e, onInteract, true));
        };
        events.forEach(e => document.addEventListener(e, onInteract, { capture: true, once: true }));
      }

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      // Calibration aid: log peak RMS every 8 seconds so threshold can be tuned
      let lastCalLog = 0;
      let peakRms = 0;

      const THRESHOLD = 10;  // RMS of byte-frequency data; lower = more sensitive
      const SILENCE_MS = 700;   // cut recording 700ms after speech ends (was 1400ms)
      const MAX_MS = 7000;
      const TICK_MS = 40;    // setTimeout instead of RAF — RAF is throttled when unfocused on Pi

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(m => {
        try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
      }) || '';

      let recStart = 0;

      const makeRec = () => {
        const r = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        r.ondataavailable = e => { if (e.data?.size > 0) vadChunksRef.current.push(e.data); };
        r.onstop = () => {
          const chunks = [...vadChunksRef.current];
          vadChunksRef.current = [];
          if (chunks.length && !vadBusyRef.current && (Date.now() - recStart) >= 300) {
            vadBusyRef.current = true;
            transcribeVADChunk(new Blob(chunks, { type: mimeType || 'audio/webm' }));
          }
        };
        return r;
      };

      vadRecorderRef.current = makeRec();

      const tick = () => {
        if (!vadEnabledRef.current) return;

        // Skip analysis while AudioContext is not running
        if (ctx.state !== 'running') {
          vadRafRef.current = setTimeout(tick, TICK_MS);
          return;
        }

        analyser.getByteFrequencyData(data);
        const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
        if (rms > peakRms) peakRms = rms;

        // Periodic calibration log
        const now = Date.now();
        if (now - lastCalLog > 8000) {
          console.log(`[VAD] ctx=${ctx.state} peakRMS=${peakRms.toFixed(1)} threshold=${THRESHOLD}`);
          peakRms = 0;
          lastCalLog = now;
        }

        const voice = rms > THRESHOLD;

        if (voice) {
          if (!isSpeakingRef.current && !vadActiveRef.current && vadRecorderRef.current.state === 'inactive' && !vadBusyRef.current) {
            vadActiveRef.current = true;
            vadChunksRef.current = [];
            recStart = Date.now();
            console.log('[VAD] recording started');
            try { vadRecorderRef.current.start(200); } catch {}
          }
          if (vadSilenceRef.current) { clearTimeout(vadSilenceRef.current); vadSilenceRef.current = null; }
          if (vadActiveRef.current && (Date.now() - recStart) > MAX_MS) {
            vadActiveRef.current = false;
            if (vadRecorderRef.current.state === 'recording') {
              try { vadRecorderRef.current.stop(); } catch {}
              vadRecorderRef.current = makeRec();
            }
          }
        } else if (vadActiveRef.current && !vadSilenceRef.current) {
          vadSilenceRef.current = setTimeout(() => {
            vadSilenceRef.current = null;
            if (vadActiveRef.current && vadRecorderRef.current.state === 'recording') {
              vadActiveRef.current = false;
              console.log('[VAD] recording stopped → sending to Whisper');
              try { vadRecorderRef.current.stop(); } catch {}
              vadRecorderRef.current = makeRec();
            }
          }, SILENCE_MS);
        }

        vadRafRef.current = setTimeout(tick, TICK_MS);
      };

      vadRafRef.current = setTimeout(tick, TICK_MS);
      console.log('[VAD] started — ctx state:', ctx.state, '— speak to calibrate');
    } catch (e) {
      vadEnabledRef.current = false;
      if (vadStreamRef.current) {
        vadStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
        vadStreamRef.current = null;
      }
      console.warn('[VAD] Could not start:', e.message);
    }
  }, [transcribeVADChunk]);

  // ── Volume monitor ────────────────────────────────────────────────────

  const stopVolume = useCallback(() => {
    if (volRafRef.current) { cancelAnimationFrame(volRafRef.current); volRafRef.current = null; }
    try { analyserRef.current?.disconnect(); } catch {}
    analyserRef.current = null;
    setVolume(0);
  }, []);

  const startVolume = useCallback((stream) => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream) return;
    stopVolume();
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AC();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const an  = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.6;
      src.connect(an);
      analyserRef.current = an;
      const data = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        an.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length;
        const v = Math.min(Math.pow(avg / 128, 0.6) * 1.4, 1);
        setVolume(p => p * 0.65 + v * 0.35);
        volRafRef.current = requestAnimationFrame(tick);
      };
      volRafRef.current = requestAnimationFrame(tick);
    } catch {}
  }, [stopVolume]);

  // ── Session management ────────────────────────────────────────────────

  const resetInactivity = useCallback(() => {
    if (inactivityRef.current) clearTimeout(inactivityRef.current);
    inactivityRef.current = setTimeout(() => {
      if (!isOpenRef.current) return;
      console.log('[AI] Inactivity timeout — closing');
      // trigger close via endSession which is defined below
      // we call it indirectly via ref to avoid circular dep
      endSessionRef.current?.();
    }, 45000);
  }, []);

  const endSessionRef = useRef(null); // will be set after endSession is defined

  const releaseWebRTC = useCallback(() => {
    if (dcRef.current) {
      try { dcRef.current.close(); } catch {}
      dcRef.current.onmessage = null;
      dcRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => { try { t.stop(); } catch {} });
      micStreamRef.current = null;
    }
    if (remoteAudioRef.current) {
      try { remoteAudioRef.current.pause(); } catch {}
      remoteAudioRef.current.srcObject = null;
    }
    stopVolume();
  }, [stopVolume]);

  const endSession = useCallback(() => {
    sessionRef.current = false;
    if (inactivityRef.current) { clearTimeout(inactivityRef.current); inactivityRef.current = null; }
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (ttsAudioRef.current) { try { ttsAudioRef.current.stop(); } catch {} ttsAudioRef.current = null; }
    pendingMessageRef.current = null;
    window.speechSynthesis?.cancel();
    releaseWebRTC();
    setIsOpen(false);
    isOpenRef.current = false;
    setUiStatus('idle', '');
    setUserText('');
    setAiText('');
    // Short cooldown so wake word doesn't immediately re-trigger
    cooldownRef.current = true;
    setTimeout(() => {
      cooldownRef.current = false;
      // Resume VAD wake word listening after session closes
      startVAD();
    }, 2200);
  }, [releaseWebRTC, setUiStatus, startVAD]);

  // Wire the indirect ref so resetInactivity can call endSession
  useEffect(() => { endSessionRef.current = endSession; }, [endSession]);

  // ── WebRTC Realtime session ───────────────────────────────────────────

  const configureRealtimeSession = useCallback(() => {
    if (!dcRef.current) return;
    const { name, voice } = cfgRef.current;
    dcRef.current.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice,
        instructions:
          `You are ${name}, a personalised AI assistant built into a smart mirror. ` +
          `Be concise, warm, and helpful. ` +
          `You have direct access to the data shown on this mirror — the user's Gmail inbox, news headlines, weather, and Spotify. ` +
          `Always use get_mirror_emails, get_mirror_news, get_mirror_weather, or get_mirror_now_playing when the user asks about those topics. ` +
          `Use spotify_control to play, pause, skip, or go back. Use spotify_play_track to play a specific song or artist. ` +
          `Keep spoken answers to 1-3 sentences unless asked to elaborate.` +
          mirrorDataStore.buildContextSummary(),
        turn_detection: { type: 'server_vad', threshold: 0.45, prefix_padding_ms: 250, silence_duration_ms: 500 },
        input_audio_transcription: { model: 'whisper-1' },
        tools: TOOLS_REALTIME,
        tool_choice: 'auto',
      },
    }));
  }, []);

  const startWebRTC = useCallback(async () => {
    const { apiKey, realtimeModel } = cfgRef.current;
    if (!apiKey) {
      setUiStatus('error', '', 'Add your OpenAI API key in Settings → AI Assistant.');
      return;
    }
    if (statusRef.current === 'connecting') return;

    try {
      setUiStatus('connecting', 'Connecting…');

      if (!micStreamRef.current) {
        micStreamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        });
        // Unlock audio autoplay
        if (remoteAudioRef.current && !audioUnlockedRef.current) {
          const audio = remoteAudioRef.current;
          audio.muted = true;
          const p = audio.play();
          if (p?.then) p.then(() => {
            audio.pause(); audio.muted = false; audio.currentTime = 0;
            audioUnlockedRef.current = true; setAudioUnlocked(true);
          }).catch(() => { audio.muted = false; });
        }
      }

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.ontrack = (ev) => {
        const stream = ev.streams?.[0] || (ev.track ? new MediaStream([ev.track]) : null);
        if (!stream || !remoteAudioRef.current) return;
        const audio = remoteAudioRef.current;
        audio.srcObject = stream;
        // Never mute — we need actual audio output.
        // autoPlay on the element handles the initial play; call play() here as a belt-and-suspenders.
        audio.muted = false;
        audio.volume = 1;
        const tryPlay = (n) => {
          const p = audio.play();
          if (p?.then) {
            p.then(() => {
              audioUnlockedRef.current = true;
              setAudioUnlocked(true);
              console.log('[WebRTC] Audio playing');
            }).catch(err => {
              console.warn(`[WebRTC] play() attempt ${n} failed: ${err.message}`);
              if (n < 8) setTimeout(() => tryPlay(n + 1), 300);
            });
          }
        };
        tryPlay(1);
        startVolume(stream);
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') {
          // WebRTC owns the mic — stop VAD to avoid duplicate Whisper calls
          stopVAD();
          setUiStatus('listening', 'Listening…');
          resetInactivity();
        } else if (s === 'failed' || s === 'closed') {
          endSession();
        }
      };

      micStreamRef.current.getTracks().forEach(t => pc.addTrack(t, micStreamRef.current));

      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      let partialAi = '';
      const pendingCalls = {};

      dc.onopen = () => setStatusMsg('Connecting…');

      dc.onmessage = (ev) => {
        resetInactivity();
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        switch (msg.type) {
          case 'session.created':
            configureRealtimeSession();
            setUiStatus('listening', 'Listening…');
            break;

          case 'input_audio_buffer.speech_started':
            setUiStatus('listening', 'Listening…');
            setUserText('');
            partialAi = '';
            setAiText('');
            break;

          case 'input_audio_buffer.speech_stopped':
            setUiStatus('thinking', 'Processing…');
            break;

          case 'conversation.item.input_audio_transcription.completed': {
            const t = msg.transcript || '';
            setUserText(t);
            if (t) setHistory(prev => { const u = [...prev, { role: 'user', content: t }]; saveHistory(u); return u; });
            break;
          }

          case 'response.audio_transcript.delta':
            partialAi += msg.delta || '';
            setAiText(partialAi);
            setUiStatus('speaking', 'Speaking…');
            break;

          case 'response.audio_transcript.done': {
            const full = msg.transcript || partialAi;
            setAiText(full);
            if (full) setHistory(prev => { const u = [...prev, { role: 'assistant', content: full }]; saveHistory(u); return u; });
            partialAi = '';
            break;
          }

          case 'response.done':
            setUiStatus('listening', 'Listening…');
            break;

          // Tool call handling
          case 'response.output_item.added':
            if (msg.item?.type === 'function_call') {
              pendingCalls[msg.item.call_id] = { name: msg.item.name, args: '' };
            }
            break;

          case 'response.function_call_arguments.delta':
            if (pendingCalls[msg.call_id]) pendingCalls[msg.call_id].args += msg.delta || '';
            break;

          case 'response.function_call_arguments.done': {
            const call = pendingCalls[msg.call_id];
            if (!call) break;
            setUiStatus('thinking', `Looking up: ${call.name.replace(/_/g, ' ')}…`);
            let args = {};
            try { args = JSON.parse(call.args || '{}'); } catch {}
            executeTool(call.name, args).then(result => {
              if (!dcRef.current) return;
              dcRef.current.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'function_call_output', call_id: msg.call_id, output: String(result) },
              }));
              dcRef.current.send(JSON.stringify({ type: 'response.create' }));
            });
            delete pendingCalls[msg.call_id];
            break;
          }

          case 'error': {
            const code = msg.error?.code;
            if (code === 'invalid_api_key') setUiStatus('error', '', 'Invalid API key. Check Settings.');
            else if (code === 'session_expired') endSession();
            break;
          }
          default: break;
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/sdp',
            'OpenAI-Beta': 'realtime=v1',
          },
          body: offer.sdp,
        }
      );

      if (!res.ok) throw new Error(await res.text());
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });

    } catch (err) {
      console.error('[WebRTC] Failed:', err.message);
      releaseWebRTC();
      // Fall through to Chat+TTS mode — restart VAD so mic input still works
      setUiStatus('listening', 'Listening… (Chat mode)');
      sessionRef.current = true;
      resetInactivity();
      startVAD(); // VAD provides mic input when WebRTC is unavailable
    }
  }, [configureRealtimeSession, endSession, releaseWebRTC, resetInactivity, setUiStatus, startVolume, stopVAD, startVAD]);

  // ── openWithVoice: open UI + start WebRTC (used by tap/button) ────────
  // Must be defined after startWebRTC to avoid temporal dead zone in deps array.

  const openWithVoice = useCallback(() => {
    if (isOpenRef.current) return;
    setIsOpen(true);
    isOpenRef.current = true;
    sessionRef.current = true;
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {});
    const { enabled } = cfgRef.current;
    if (!enabled) {
      setUiStatus('error', '', 'AI assistant is disabled. Enable it in Settings → AI Assistant.');
      setTimeout(() => endSessionRef.current?.(), 4000);
      return;
    }
    playDing();
    if (cfgRef.current.elevenLabsKey) {
      setUiStatus('listening', 'Listening…');
    } else {
      startWebRTC();
    }
    resetInactivity();
  }, [playDing, startWebRTC, resetInactivity, setUiStatus]);

  // ── Chat + TTS agentic pipeline ───────────────────────────────────────

  const sendChatMessage = useCallback(async (userMessage) => {
    const { apiKey, chatModel, name } = cfgRef.current;
    if (!apiKey) {
      setUiStatus('error', '', 'Add your OpenAI API key in Settings → AI Assistant.');
      return;
    }

    resetInactivity(); // keep session alive through the full thinking → speaking turn
    setUiStatus('thinking', 'Thinking…');
    setUserText(userMessage);
    setAiText('');

    const newHistory = [...history, { role: 'user', content: userMessage }];
    setHistory(newHistory);
    saveHistory(newHistory);

    const contextTurns = retrieveContext(history, userMessage);
    const recent = newHistory.slice(-MAX_CONTEXT);

    // Merge context + recent, deduplicate
    const allTurns = [...contextTurns, ...recent].reduce((acc, m) => {
      if (!acc.some(e => e.role === m.role && e.content === m.content)) acc.push(m);
      return acc;
    }, []);

    const systemPrompt =
      `You are ${name}, a personalised AI assistant embedded in a smart mirror. ` +
      `Today is ${toolDatetime()}. ` +
      `You have direct access to the data currently shown on this mirror — including the user's Gmail inbox, news headlines, weather, and Spotify playback. ` +
      `Always call get_mirror_emails when the user asks about their email or inbox. ` +
      `Always call get_mirror_news for news questions. ` +
      `Always call get_mirror_weather for local weather questions. ` +
      `Always call get_mirror_now_playing when asked what is playing. ` +
      `Use spotify_control to play, pause, skip, or go back. Use spotify_play_track to play a specific song or artist. ` +
      `For general knowledge, use web_search or wikipedia_search. ` +
      `Be concise — keep spoken answers to 2-3 sentences unless the user asks for more detail.` +
      mirrorDataStore.buildContextSummary();

    const messages = [{ role: 'system', content: systemPrompt }, ...allTurns];

    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    try {
      let currentMessages = messages;

      // Agentic loop — model calls tools until it returns a final response
      for (let iter = 0; iter < 6; iter++) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: abortRef.current.signal,
          body: JSON.stringify({
            model: chatModel,
            messages: currentMessages,
            tools: TOOLS_OPENAI,
            tool_choice: 'auto',
            max_tokens: 600,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`API ${res.status}: ${body}`);
        }

        const data = await res.json();
        const choice = data.choices?.[0];
        if (!choice) throw new Error('No response');

        if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
          currentMessages = [...currentMessages, choice.message];

          const toolResults = await Promise.all(
            choice.message.tool_calls.map(async tc => {
              const label = tc.function.name.replace(/_/g, ' ');
              setUiStatus('thinking', `Looking up: ${label}…`);
              let args = {};
              try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
              const output = await executeTool(tc.function.name, args);
              return { role: 'tool', tool_call_id: tc.id, content: String(output) };
            })
          );

          currentMessages = [...currentMessages, ...toolResults];
          continue;
        }

        // Final text response
        const responseText = (choice.message?.content || '').trim();
        if (!responseText) break;

        setAiText(responseText);
        setUiStatus('speaking', 'Speaking…');
        resetInactivity(); // reset again so a long TTS response doesn't time out mid-word
        await speak(responseText);

        const updatedHistory = [...newHistory, { role: 'assistant', content: responseText }];
        setHistory(updatedHistory);
        saveHistory(updatedHistory);

        setUiStatus('listening', 'Listening…');

        // Send any message that arrived while Alex was speaking
        if (pendingMessageRef.current) {
          const queued = pendingMessageRef.current;
          pendingMessageRef.current = null;
          sendChatRef.current(queued);
        }
        return;
      }

      setUiStatus('listening', 'Listening…');
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[Chat] Error:', err.message);
      setUiStatus('error', '', err.message);
      setTimeout(() => setUiStatus('listening', 'Listening…'), 4000);
    }
  }, [history, resetInactivity, setUiStatus, speak]);

  // Keep a ref so the speech handler can always call the latest sendChatMessage
  const sendChatRef = useRef(sendChatMessage);
  useEffect(() => { sendChatRef.current = sendChatMessage; }, [sendChatMessage]);

  // ── Public send (text input / debug) ─────────────────────────────────

  const sendText = useCallback((text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!isOpenRef.current) { open(); sessionRef.current = true; }
    resetInactivity();

    if (!cfgRef.current.elevenLabsKey && dcRef.current?.readyState === 'open') {
      dcRef.current.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: trimmed }] },
      }));
      dcRef.current.send(JSON.stringify({ type: 'response.create' }));
      setUserText(trimmed);
    } else {
      sendChatRef.current(trimmed);
    }
  }, [open, resetInactivity]);

  // ── Speech recognition ────────────────────────────────────────────────
  // Uses a handler ref pattern so the onresult closure never goes stale.

  const speechHandlerRef = useRef(null);

  // Rebuild the handler whenever key values change
  speechHandlerRef.current = (text) => {
    if (cooldownRef.current) return;

    // Whisper adds punctuation ("Hey, Alex." "Thank you.") — strip it before matching
    const clean = text.replace(/[.,!?;:'"()\[\]]/g, ' ').replace(/\s+/g, ' ').trim();

    const { name, enabled } = cfgRef.current;
    const nameLower = (name || 'mirror').toLowerCase();
    const wakeWords = [`hey ${nameLower}`, 'hey mirror'];
    const isWake = wakeWords.some(w => clean.includes(w));
    const isClose = ['thank you', 'thanks', 'close', 'stop', 'goodbye', 'bye', 'dismiss']
      .some(w => clean.includes(w));

    if (!isOpenRef.current) {
      // ── Idle: only listen for wake word ──────────────────────────────
      if (!isWake) return;

      console.log('[Speech] Wake word →', text);
      // Unlock AudioContext — wake word detection is not a user gesture,
      // so we must resume the context before any audio can play.
      if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      } else if (!audioCtxRef.current) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { audioCtxRef.current = new AC(); } catch {} }
      }
      playDing();
      open();
      sessionRef.current = true;

      if (!enabled) {
        setUiStatus('error', '', 'AI assistant is disabled. Enable it in Settings → AI Assistant.');
        setTimeout(() => endSessionRef.current?.(), 4000);
        return;
      }

      // If ElevenLabs key is set, skip WebRTC and use Chat+ElevenLabs TTS
      if (cfgRef.current.elevenLabsKey) {
        setUiStatus('listening', 'Listening…');
      } else {
        startWebRTC();
      }
      resetInactivity();

    } else {
      // ── Session open: handle commands ─────────────────────────────────
      if (isClose) {
        endSessionRef.current?.();
        return;
      }

      // Ignore the wake word re-trigger inside an active session
      if (isWake) return;

      // Ignore single-word noise
      if (clean.split(/\s+/).length < 2) return;

      resetInactivity();

      // Use Chat+TTS when ElevenLabs is configured, or when WebRTC isn't active
      if (cfgRef.current.elevenLabsKey || !dcRef.current || dcRef.current.readyState !== 'open') {
        // Queue input if Alex is mid-speech; process it once speaking finishes
        if (statusRef.current === 'speaking') {
          pendingMessageRef.current = clean;
        } else {
          sendChatRef.current(clean);
        }
      }
      // When WebRTC is open (and no ElevenLabs), mic stream goes directly to OpenAI
    }
  };

  useEffect(() => {
    const W = window;
    const SR = W.SpeechRecognition || W.webkitSpeechRecognition;
    if (!SR) { setSpeechOk(false); return; }

    setSpeechOk(true);
    const rec = new SR();
    recognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';

    let cancelled = false;

    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (!ev.results[i].isFinal) continue;
        const text = ev.results[i][0].transcript.trim().toLowerCase();
        lastSpeechMsRef.current = Date.now();
        console.log('[Speech]', text);
        speechHandlerRef.current(text);
      }
    };

    rec.onerror = (ev) => {
      console.warn('[Speech] Error:', ev.error);
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        setMicError('Microphone access denied. Allow microphone permissions in your browser.');
        cancelled = true; // Don't restart — permissions need to be granted first
      }
      // network / no-speech / audio-capture: onend will fire and restart automatically
    };

    rec.onend = () => { if (!cancelled) { try { rec.start(); } catch {} } };

    try { rec.start(); } catch (e) { console.error('[Speech] Could not start:', e); }

    return () => {
      cancelled = true;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try { rec.stop(); } catch {}
    };
  }, []); // Run once — handler ref keeps values fresh

  // ── Audio unlock on first interaction ────────────────────────────────
  useEffect(() => {
    const unlock = () => {
      if (audioUnlockedRef.current) return;
      const audio = remoteAudioRef.current;
      if (!audio) return;
      audio.muted = true;
      const p = audio.play();
      if (p?.then) p.then(() => {
        audio.pause(); audio.muted = false; audio.currentTime = 0;
        audioUnlockedRef.current = true; setAudioUnlocked(true);
      }).catch(() => { audio.muted = false; });
    };
    const events = ['click', 'touchstart', 'keydown', 'pointerdown'];
    events.forEach(e => document.addEventListener(e, unlock, { capture: true }));
    return () => events.forEach(e => document.removeEventListener(e, unlock, { capture: true }));
  }, []);

  // ── Start VAD on mount (works silently if mic already permitted) ──────
  useEffect(() => {
    // Try immediately — succeeds if permission was previously granted
    startVAD();
    return () => stopVAD();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (inactivityRef.current) clearTimeout(inactivityRef.current);
      if (abortRef.current) abortRef.current.abort();
      releaseWebRTC();
      stopVAD();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Explicit audio unlock (call on any user gesture) ─────────────────
  const unlockAudio = useCallback(() => {
    // Unlock WebRTC audio element
    if (remoteAudioRef.current && !audioUnlockedRef.current) {
      const audio = remoteAudioRef.current;
      audio.muted = true;
      const p = audio.play();
      if (p?.then) p.then(() => {
        audio.pause();
        audio.muted = false;
        audio.currentTime = 0;
        audioUnlockedRef.current = true;
        setAudioUnlocked(true);
      }).catch(() => { audio.muted = false; });
    }
  }, []);

  // ── Public API ────────────────────────────────────────────────────────
  return {
    // State
    isOpen,
    status,
    statusMsg,
    errorMsg,
    volume,
    userText,
    aiText,
    history,
    speechOk,
    micError,
    audioUnlocked,
    cfg,
    // Refs (for rendering in SmartMirror)
    remoteAudioRef,
    // Actions
    open,
    openWithVoice,
    endSession,
    sendText,
    unlockAudio,
    startVAD,
    clearHistory: () => { setHistory([]); localStorage.removeItem(HISTORY_KEY); },
  };
}
