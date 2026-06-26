/**
 * Gmail API service abstraction.
 *
 * Expected backend endpoints:
 *   GET /api/gmail/status
 *     Response: { connected: boolean, email: string }
 *
 *   GET /api/gmail/messages?limit=N&profileId=X
 *     Response: { unreadCount: number, messages: GmailMessage[] }
 *
 * When REACT_APP_GMAIL_USE_MOCK=true (or the endpoint returns a network error
 * in development), mock data is used so the widget can be worked on without
 * a live backend.
 *
 * Multi-user note:
 *   Pass `profileId` to each call. The backend can use it to look up the
 *   OAuth tokens for the active mirror profile.  When profileId is null the
 *   backend should fall back to the default / single-user account.
 */

// ---------------------------------------------------------------------------
// Types (JSDoc only – no TypeScript required)
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} GmailStatus
 * @property {boolean} connected
 * @property {string}  email
 */

/**
 * @typedef {Object} GmailMessage
 * @property {string}  id
 * @property {string}  from
 * @property {string}  subject
 * @property {string}  snippet
 * @property {string}  timestamp  ISO-8601
 * @property {boolean} unread
 */

/**
 * @typedef {Object} GmailMessagesResponse
 * @property {number}         unreadCount
 * @property {GmailMessage[]} messages
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Only use mock when explicitly requested — never auto-enable in dev.
const USE_MOCK = process.env.REACT_APP_GMAIL_USE_MOCK === 'true';

// Prefer the Gmail-specific base URL; fall back to the shared API URL.
const BASE_URL = (
  process.env.REACT_APP_API_BASE_URL ||
  process.env.REACT_APP_API_URL ||
  'http://localhost:3000'
).replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const MOCK_STATUS = {
  connected: true,
  email: 'demo@example.com',
};

const MOCK_MESSAGES = {
  unreadCount: 4,
  messages: [
    {
      id: 'mock_1',
      from: 'Alice Johnson',
      subject: 'Weekend Plans',
      snippet: "Hey! Are we still on for Saturday? Let me know if the time works for you.",
      timestamp: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
      unread: true,
    },
    {
      id: 'mock_2',
      from: 'GitHub',
      subject: '[smart-mirror] Pull request #42 merged',
      snippet: "Your pull request 'Add Gmail widget' was successfully merged into main.",
      timestamp: new Date(Date.now() - 1000 * 60 * 55).toISOString(),
      unread: true,
    },
    {
      id: 'mock_3',
      from: 'Notion',
      subject: 'Your weekly digest is ready',
      snippet: "Here's a summary of activity across your Notion workspace from the past 7 days.",
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
      unread: false,
    },
    {
      id: 'mock_4',
      from: 'Bob Martinez',
      subject: 'Re: Project proposal',
      snippet: "Thanks for sending that over. I'll review it tonight and get back to you tomorrow.",
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 7).toISOString(),
      unread: true,
    },
    {
      id: 'mock_5',
      from: 'Netflix',
      subject: 'New episodes available',
      snippet: "New episodes of your favourite shows are now available to stream.",
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 22).toISOString(),
      unread: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Response normalizers
// Absorb snake_case / camelCase / field-name variations from different backends.
// ---------------------------------------------------------------------------

function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object') return { connected: false, email: null };
  return {
    connected: !!(raw.connected ?? raw.gmail_connected ?? raw.isConnected ?? false),
    email:     raw.email ?? raw.gmail_email ?? raw.emailAddress ?? raw.gmailEmail ?? null,
  };
}

function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  return {
    id:        String(msg.id ?? msg.message_id ?? msg.messageId ?? ''),
    from:      msg.from ?? msg.sender ?? msg.fromName ?? msg.from_name ?? '',
    subject:   msg.subject ?? '',
    snippet:   msg.snippet ?? msg.preview ?? msg.body ?? '',
    timestamp: msg.timestamp ?? msg.date ?? msg.received_at ?? msg.receivedAt ?? new Date().toISOString(),
    unread:    msg.unread !== undefined
                 ? !!msg.unread
                 : msg.is_unread !== undefined
                   ? !!msg.is_unread
                   : msg.read !== undefined
                     ? !msg.read
                     : false,
  };
}

function normalizeMessages(raw) {
  if (!raw || typeof raw !== 'object') return { connected: true, unreadCount: 0, messages: [] };
  const rawMessages = raw.messages ?? raw.emails ?? raw.data ?? [];
  return {
    connected:   raw.connected !== false,
    unreadCount: raw.unreadCount ?? raw.unread_count ?? raw.unread ?? 0,
    messages:    rawMessages.map(normalizeMessage).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with status ${response.status}`);
  }
  return response.json();
}

function buildQuery(params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch connection status for the given profile.
 *
 * @param {object}      [opts]
 * @param {string|null} [opts.profileId]  Active mirror profile ID (multi-user).
 * @returns {Promise<GmailStatus>}
 */
export async function fetchGmailStatus({ profileId = null } = {}) {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 400));
    return { ...MOCK_STATUS };
  }

  const qs = buildQuery({ profileId });
  return fetchJson(`${BASE_URL}/api/gmail/status${qs}`);
}

/**
 * Fetch recent messages for the given profile.
 *
 * @param {object}      [opts]
 * @param {number}      [opts.limit]      Max messages to return.
 * @param {string|null} [opts.profileId]  Active mirror profile ID (multi-user).
 * @returns {Promise<GmailMessagesResponse>}
 */
export async function fetchGmailMessages({ limit = 5, profileId = null } = {}) {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 700));
    return {
      unreadCount: MOCK_MESSAGES.unreadCount,
      messages: MOCK_MESSAGES.messages.slice(0, limit),
    };
  }

  const qs = buildQuery({ limit, profileId });
  return fetchJson(`${BASE_URL}/api/gmail/messages${qs}`);
}

// ---------------------------------------------------------------------------
// Mirror-scoped API  (uses mirrorId instead of profileId)
// The backend resolves which profile is active for the given mirror.
// ---------------------------------------------------------------------------

/**
 * Fetch Gmail connection status for the mirror's currently active profile.
 *
 * @param {object} opts
 * @param {string} opts.mirrorId  The mirror's UUID (from backendApi.getMirrorId()).
 * @returns {Promise<GmailStatus>}
 */
export async function fetchGmailStatusForMirror({ mirrorId } = {}) {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 400));
    return { ...MOCK_STATUS };
  }

  const url = `${BASE_URL}/api/mirrors/gmail/status?mid=${encodeURIComponent(mirrorId)}`;
  console.log('[GmailService] Fetching Gmail status for mirror:', url);
  const raw = await fetchJson(url);
  console.log('[GmailService] Gmail status raw response:', raw);
  const result = normalizeStatus(raw);
  console.log('[GmailService] Gmail status normalized:', result);
  return result;
}

/**
 * Fetch recent Gmail messages for the mirror's currently active profile.
 *
 * @param {object} opts
 * @param {string} opts.mirrorId  The mirror's UUID (from backendApi.getMirrorId()).
 * @param {number} [opts.limit]   Max messages to return.
 * @returns {Promise<GmailMessagesResponse>}
 */
export async function fetchGmailMessagesForMirror({ mirrorId, limit = 5 } = {}) {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 700));
    return {
      unreadCount: MOCK_MESSAGES.unreadCount,
      messages: MOCK_MESSAGES.messages.slice(0, limit),
    };
  }

  const url = `${BASE_URL}/api/mirrors/gmail/messages?mid=${encodeURIComponent(mirrorId)}&${buildQuery({ limit }).replace(/^\?/, '')}`;
  console.log('[GmailService] Fetching Gmail messages for mirror:', url);
  const raw = await fetchJson(url);
  console.log('[GmailService] Gmail messages raw response:', raw);
  const result = normalizeMessages(raw);
  console.log('[GmailService] Gmail messages normalized:', result);
  return result;
}
