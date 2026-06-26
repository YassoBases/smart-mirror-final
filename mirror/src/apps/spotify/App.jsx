import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useFullscreen from '../../hooks/useFullscreen'
import { backendApi } from '../../services/backendApi'
import { mirrorDataStore } from '../../services/mirrorDataStore'
import './styles.css'

const API_URL = (process.env.REACT_APP_API_URL || 'http://localhost:3000').replace(/\/$/, '')

// ── Mirror device hook ─────────────────────────────────────────────────────
// Polls Spotify's device list every 10 s and finds the "Smart Mirror" device
// created by the librespot service running on the Pi.

function useSpotifyMirrorDevice(mirrorId, connected) {
  const [mirrorDeviceId, setMirrorDeviceId] = useState(null)
  const [isMirrorActive, setIsMirrorActive] = useState(false)

  const fetchMirrorDevice = useCallback(async () => {
    if (!connected || !mirrorId) return
    try {
      const data = await fetchJson(
        `${API_URL}/api/mirrors/spotify/devices?mid=${encodeURIComponent(mirrorId)}`
      )
      const device = (data.devices || []).find(d => d.name === 'Smart Mirror')
      setMirrorDeviceId(device?.id ?? null)
      setIsMirrorActive(device?.is_active ?? false)
    } catch (e) {
      console.error('[MirrorDevice] fetch failed:', e.message)
    }
  }, [connected, mirrorId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!connected) return
    fetchMirrorDevice()
    const id = setInterval(fetchMirrorDevice, 10000)
    return () => clearInterval(id)
  }, [connected, fetchMirrorDevice])

  return { mirrorDeviceId, isMirrorActive, fetchMirrorDevice }
}

// ── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000

// Natural-looking amplitude envelope for waveform bars
const BAR_AMPLITUDES = [
  0.30, 0.45, 0.65, 0.80, 0.95, 1.00, 0.85, 0.70, 0.90, 0.60,
  0.75, 1.00, 0.88, 0.55, 0.78, 0.92, 0.65, 0.82, 0.50, 0.70,
  0.88, 0.60, 0.40, 0.55,
]

// ── Utilities ──────────────────────────────────────────────────────────────

function formatTime(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '--:--'
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

async function fetchJson(url, options) {
  const response = await fetch(url, options)
  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')

  if (!response.ok) {
    if (isJson) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `Request failed with status ${response.status}`)
    }
    throw new Error(`Spotify service unavailable (${response.status})`)
  }

  // Server returned 200 but with HTML (e.g. dev-server fallback) — not a real error
  if (!isJson) throw new Error('Spotify service is not running')

  return response.json()
}

// ── Response normalizer ────────────────────────────────────────────────────
// Handles both our shaped format AND raw Spotify API pass-through.
// Shaped:    { connected, isPlaying, track: { name, artist, albumArtUrl, durationMs, progressMs } }
// Raw Spotify pass-through: { connected, is_playing, item: { name, artists, album, duration_ms }, progress_ms }

function normalizePlayerResponse(data) {
  console.log('[Spotify] raw response to normalize:', JSON.stringify(data, null, 2))

  if (!data || typeof data !== 'object') {
    console.warn('[Spotify] normalizer: received null/non-object data')
    return { connected: false, displayName: '', playback: null }
  }

  const connected = Boolean(data.connected)
  const displayName = data.displayName || data.display_name || ''

  // Some backends wrap playback data under a "playback" key
  // e.g. { connected: true, playback: { is_playing: true, item: {...} } }
  const root = (data.playback && typeof data.playback === 'object') ? data.playback : data

  // is_playing: camelCase, snake_case, on root or nested
  const isPlaying =
    root.isPlaying !== undefined ? Boolean(root.isPlaying) :
    root.is_playing !== undefined ? Boolean(root.is_playing) :
    data.isPlaying !== undefined ? Boolean(data.isPlaying) :
    Boolean(data.is_playing)

  // Track source — try every known key name across all known backend shapes
  const trackSource =
    root.track ||          // shaped: { track: { name, artist, albumArtUrl, ... } }
    root.item  ||          // Spotify raw: { item: { name, artists, album, ... } }
    data.track ||          // top-level fallback
    data.item  ||          // top-level fallback
    data.currentlyPlaying || // custom key some backends use
    null

  // progress — top-level on root takes priority (Spotify puts it there)
  const progressMs = Number(
    root.progress_ms  ||
    root.progressMs   ||
    data.progress_ms  ||
    data.progressMs   ||
    (trackSource && trackSource.progress_ms) ||
    0
  )

  console.log('[Spotify] normalizer: connected=%s isPlaying=%s trackSource=%s progressMs=%s',
    connected, isPlaying, trackSource ? trackSource.name : 'null', progressMs)
  console.log('[Spotify] normalizer: top-level keys in response:', Object.keys(data).join(', '))

  if (!connected || !trackSource) {
    console.warn('[Spotify] normalizer: no playback —',
      !connected ? 'not connected' : `connected=true but no track/item found. Keys: ${Object.keys(data).join(', ')}`)
    return { connected, displayName, playback: null }
  }

  // artist: string (shaped) or array (Spotify raw)
  const artist = typeof trackSource.artist === 'string'
    ? trackSource.artist
    : Array.isArray(trackSource.artists)
      ? trackSource.artists.map(a => a.name).join(', ')
      : ''

  // album art
  const albumCover =
    trackSource.albumArtUrl ||
    trackSource.album?.images?.[0]?.url ||
    null

  // duration
  const durationMs = Number(trackSource.durationMs || trackSource.duration_ms) || 0

  const playback = { isPlaying, albumCover, title: trackSource.name || '', artist, durationMs, progressMs, updatedAt: Date.now() }
  console.log('[Spotify] normalizer: resolved —', playback.title, 'by', playback.artist, '| playing:', playback.isPlaying)
  return { connected, displayName, playback }
}

// ── Data hook ──────────────────────────────────────────────────────────────

function useSpotifyStatus() {
  // mirrorId is stable — reads from localStorage, generates once on first call
  const mirrorIdRef = useRef(null)
  if (!mirrorIdRef.current) mirrorIdRef.current = backendApi.getMirrorId()
  const mirrorId = mirrorIdRef.current

  const [state, setState] = useState({
    loading: true,
    error: '',
    status: {
      connected: false,
      displayName: '',
      playback: null,
      playbackError: null,
    },
    lastUpdated: null,
  })

  const load = useCallback(async () => {
    const url = `${API_URL}/api/mirrors/spotify/player?mid=${encodeURIComponent(mirrorId)}`
    try {
      const data = await fetchJson(url)

      // Backend signals a transient network blip — keep existing playback state, don't wipe display
      if (data.networkError) {
        setState((prev) => ({ ...prev, loading: false, error: '' }))
        return
      }

      const { connected, displayName, playback } = normalizePlayerResponse(data)
      setState({
        loading: false,
        error: '',
        status: { connected, displayName, playback, playbackError: null },
        lastUpdated: Date.now(),
      })
      mirrorDataStore.update('spotify', { connected, displayName, playback })
    } catch (error) {
      console.error('[Spotify] load error:', error.message, '— url:', url)
      // On fetch error keep existing state — only show error on first load
      setState((prev) => ({
        ...prev,
        loading: false,
        error: prev.loading ? (error.message || 'Unable to load Spotify status.') : '',
      }))
    }
  }, [mirrorId])

  useEffect(() => {
    let cancelled = false
    let intervalId = null

    async function start() {
      await load()
      if (cancelled) return
      intervalId = setInterval(load, POLL_INTERVAL_MS)
    }

    start()
    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [load])

  return { ...state, reload: load, mirrorId }
}

// ── Sub-components ──────────────────────────────────────────────────────────

function AlbumArt({ src, isPlaying }) {
  return (
    <div className="sg-art-wrap">
      <div className={`sg-art${isPlaying ? ' sg-art--playing' : ''}`}>
        {src ? (
          <img src={src} alt="Album artwork" className="sg-art-img" draggable={false} />
        ) : (
          <div className="sg-art-placeholder">♫</div>
        )}
      </div>
    </div>
  )
}

function TrackInfo({ title, artist, connected }) {
  const displayTitle = connected
    ? title || 'Nothing playing'
    : 'Spotify not connected'

  const displayArtist = connected
    ? artist || ''
    : 'Connect Spotify from the mobile app'

  return (
    <div className="sg-info">
      <div className="sg-title">{displayTitle}</div>
      {displayArtist ? <div className="sg-artist">{displayArtist}</div> : null}
    </div>
  )
}

function Waveform({ isPlaying }) {
  return (
    <div className="sg-wave" aria-hidden="true">
      {BAR_AMPLITUDES.map((amp, i) => (
        <div
          key={i}
          className="sg-wave-bar"
          style={{
            '--bar-amp': amp,
            '--bar-delay': `${(i / BAR_AMPLITUDES.length) * 1.6}s`,
            animationPlayState: isPlaying ? 'running' : 'paused',
          }}
        />
      ))}
    </div>
  )
}

function Controls({ isPlaying, onPrevious, onPlayPause, onNext, disabled }) {
  return (
    <div className="sg-controls">
      {/* Previous */}
      <button
        type="button"
        className="sg-btn"
        onClick={onPrevious}
        disabled={disabled}
        aria-label="Previous track"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
        </svg>
      </button>

      {/* Play / Pause */}
      <button
        type="button"
        className="sg-btn sg-btn--play"
        onClick={onPlayPause}
        disabled={disabled}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {/* Next */}
      <button
        type="button"
        className="sg-btn"
        onClick={onNext}
        disabled={disabled}
        aria-label="Next track"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.9V8.1L8.5 12zM16 6h2v12h-2z" />
        </svg>
      </button>
    </div>
  )
}

function MirrorDeviceButton({ deviceId, isActive, isTransferring, onTransfer }) {
  const speakerIcon = (
    <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
    </svg>
  )

  if (!deviceId) {
    return (
      <div className="sg-mirror-device sg-mirror-device--loading" title="Mirror speaker not detected yet">
        {speakerIcon}
        <span>Mirror speaker…</span>
      </div>
    )
  }

  if (isActive) {
    return (
      <div className="sg-mirror-device sg-mirror-device--active" title="Playing through mirror speaker">
        {speakerIcon}
        <span>Playing on Mirror</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      className="sg-mirror-device sg-mirror-device--ready"
      onClick={onTransfer}
      disabled={isTransferring}
      title="Play audio through the mirror's JBL speaker"
    >
      {speakerIcon}
      <span>{isTransferring ? 'Switching…' : 'Play on Mirror'}</span>
    </button>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export default function SpotifyGlassCard() {
  const { error, status, reload, mirrorId } = useSpotifyStatus()
  const containerRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const [pendingAction, setPendingAction] = useState(null)
  const [controlError, setControlError] = useState('')

  // Mirror device — polls for the librespot "Smart Mirror" Spotify Connect device
  const { mirrorDeviceId, isMirrorActive, fetchMirrorDevice } = useSpotifyMirrorDevice(
    mirrorId,
    status.connected
  )
  const [transferring, setTransferring] = useState(false)

  const playback = status.playback
  const isPlaying = Boolean(playback?.isPlaying)

  const [displayProgress, setDisplayProgress] = useState(0)
  const [displayDuration, setDisplayDuration] = useState(0)
  const playbackStateRef = useRef(null)

  const { isFullscreen, toggleFullscreen, showButton, supported, buttonInteractionProps } =
    useFullscreen(containerRef)

  // ── Container sizing ──────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const updateSize = () => {
      const rect = container.getBoundingClientRect()
      setContainerWidth(Math.floor(Math.max(0, rect.width)))
      setContainerHeight(Math.floor(Math.max(0, rect.height)))
    }

    updateSize()

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateSize)
      observer.observe(container)
      return () => observer.disconnect()
    }

    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [isFullscreen])

  // ── Playback progress tracking (unchanged) ────────────────────────────────

  useEffect(() => {
    if (!playback) {
      playbackStateRef.current = null
      setDisplayDuration(0)
      setDisplayProgress(0)
      return
    }

    const duration = Number(playback.durationMs) || 0
    const progress = Number(playback.progressMs) || 0
    const now = Date.now()
    playbackStateRef.current = {
      duration,
      lastProgress: Math.min(duration || Number.MAX_SAFE_INTEGER, progress),
      lastSync: now,
      isPlaying: Boolean(playback.isPlaying),
    }
    setDisplayDuration(duration)
    setDisplayProgress(Math.min(duration || Number.MAX_SAFE_INTEGER, progress))
  }, [playback?.updatedAt, playback?.durationMs, playback?.progressMs, playback?.isPlaying])

  useEffect(() => {
    const interval = setInterval(() => {
      const state = playbackStateRef.current
      if (!state || !state.duration) return
      if (!state.isPlaying) {
        setDisplayProgress(state.lastProgress)
        return
      }
      const now = Date.now()
      const elapsed = now - state.lastSync
      if (elapsed <= 0) return
      const projected = Math.min(state.duration, state.lastProgress + elapsed)
      state.lastProgress = projected
      state.lastSync = now
      setDisplayProgress(projected)
    }, 200)

    return () => clearInterval(interval)
  }, [])

  // ── Derived values ─────────────────────────────────────────────────────────

  const progressPercent = useMemo(() => {
    if (!displayDuration || displayDuration <= 0) return 0
    return Math.max(0, Math.min(100, (displayProgress / displayDuration) * 100))
  }, [displayProgress, displayDuration])

  const controlsDisabled = !status.connected || Boolean(pendingAction)

  // Compact: height < 280px or width < 260px (and not fullscreen)
  const isCompact =
    !isFullscreen &&
    ((containerHeight > 0 && containerHeight < 280) ||
      (containerWidth > 0 && containerWidth < 260))

  // ── Control handler (unchanged) ────────────────────────────────────────────

  const handleControl = useCallback(
    async (action) => {
      if (controlsDisabled) return
      console.log('[Spotify] control action:', action, '| mirrorId:', mirrorId)
      setControlError('')
      setPendingAction(action)
      try {
        await fetchJson(
          `${API_URL}/api/mirrors/spotify/control`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, mid: mirrorId }),
          },
        )
        await reload()
      } catch (err) {
        console.error('[Spotify] control failed:', err.message)
        setControlError(err.message || 'Control failed')
        setTimeout(() => setControlError(''), 4000)
      } finally {
        setPendingAction(null)
      }
    },
    [controlsDisabled, reload, mirrorId],
  )

  // ── Transfer playback to the mirror device ────────────────────────────────

  const handleTransferToMirror = useCallback(async () => {
    if (!mirrorDeviceId || transferring) return
    setTransferring(true)
    try {
      await fetchJson(`${API_URL}/api/mirrors/spotify/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mid: mirrorId, deviceId: mirrorDeviceId, play: true }),
      })
      await Promise.all([reload(), fetchMirrorDevice()])
    } catch (err) {
      console.error('[Spotify] transfer to mirror failed:', err.message)
      setControlError(err.message || 'Transfer failed')
      setTimeout(() => setControlError(''), 4000)
    } finally {
      setTransferring(false)
    }
  }, [mirrorDeviceId, mirrorId, reload, fetchMirrorDevice, transferring])

  // ── Render ─────────────────────────────────────────────────────────────────

  const cardClass = [
    'sg-card',
    isCompact ? 'sg-card--compact' : '',
    isFullscreen ? 'sg-card--fullscreen' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cardClass} ref={containerRef}>

      {/* Fullscreen toggle */}
      {supported ? (
        <button
          type="button"
          className={`sg-fullscreen-btn${showButton ? ' is-visible' : ''}`}
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          {...buttonInteractionProps}
        >
          {isFullscreen ? (
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
            </svg>
          )}
        </button>
      ) : null}

      {isCompact ? (
        /* ── Compact horizontal layout ── */
        <div className="sg-compact">
          <div className="sg-compact-art">
            {playback?.albumCover ? (
              <img src={playback.albumCover} alt="Album artwork" draggable={false} />
            ) : (
              <div className="sg-art-placeholder">♫</div>
            )}
          </div>

          <div className="sg-compact-body">
            <TrackInfo
              title={playback?.title}
              artist={playback?.artist}
              connected={status.connected}
            />
            <Controls
              isPlaying={isPlaying}
              onPrevious={() => handleControl('previous')}
              onPlayPause={() => handleControl(isPlaying ? 'pause' : 'play')}
              onNext={() => handleControl('next')}
              disabled={controlsDisabled}
            />
            {status.connected && (
              <MirrorDeviceButton
                deviceId={mirrorDeviceId}
                isActive={isMirrorActive}
                isTransferring={transferring}
                onTransfer={handleTransferToMirror}
              />
            )}
          </div>
        </div>
      ) : (
        /* ── Full vertical glass card ── */
        <>
          <AlbumArt src={playback?.albumCover} isPlaying={isPlaying} />

          <TrackInfo
            title={playback?.title}
            artist={playback?.artist}
            connected={status.connected}
          />

          <Waveform isPlaying={isPlaying} />

          {/* Progress bar + time */}
          <div className="sg-progress-wrap">
            <div className="sg-progress" role="progressbar" aria-valuenow={progressPercent}>
              <div className="sg-progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="sg-time">
              <span>{formatTime(displayProgress)}</span>
              <span>{formatTime(displayDuration)}</span>
            </div>
          </div>

          <Controls
            isPlaying={isPlaying}
            onPrevious={() => handleControl('previous')}
            onPlayPause={() => handleControl(isPlaying ? 'pause' : 'play')}
            onNext={() => handleControl('next')}
            disabled={controlsDisabled}
          />

          {/* Mirror device button */}
          {status.connected && (
            <MirrorDeviceButton
              deviceId={mirrorDeviceId}
              isActive={isMirrorActive}
              isTransferring={transferring}
              onTransfer={handleTransferToMirror}
            />
          )}

          {/* Spotify wordmark */}
          <div className="sg-brand" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor" className="sg-brand-icon">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
            </svg>
            <span>Spotify</span>
          </div>
        </>
      )}

      {/* Only show errors once Spotify is configured — before that, the UI already guides the user */}
      {error ? <div className="sg-error">{error}</div> : null}
      {controlError ? <div className="sg-error">{controlError}</div> : null}
    </div>
  )
}
