/**
 * mirrorDataStore — module-level singleton shared between mirror apps and the AI assistant.
 *
 * Apps call update() when their data refreshes.
 * The AI assistant calls getSnapshot() and buildContextSummary() when building prompts,
 * and the get_mirror_* tool functions read directly from this store.
 */

const _store = {
  weather: null,  // { temperature, feelsLike, weathercode, windspeed, location, units, forecast }
  news:    null,  // [{ id, title, summary, publishedAt, source }]
  gmail:   null,  // { unreadCount, messages: [{ from, subject, snippet, timestamp, unread }] }
  spotify: null,  // { connected, displayName, playback: { isPlaying, title, artist, ... } }
};

export const mirrorDataStore = {
  /** Called by each mirror app whenever its data refreshes. */
  update(key, data) {
    _store[key] = data;
  },

  /** Returns a shallow copy of the full store. */
  getSnapshot() {
    return { ..._store };
  },

  /**
   * Returns a compact human-readable summary for injection into system prompts.
   * Returns an empty string when no data is available.
   */
  buildContextSummary() {
    const parts = [];

    if (_store.weather) {
      const w = _store.weather;
      const u = w.units === 'fahrenheit' ? '°F' : '°C';
      parts.push(
        `Weather on mirror: ${w.temperature}${u} (feels like ${w.feelsLike}${u}), ` +
        `wind ${w.windspeed} km/h — ${w.location}`
      );
    }

    if (_store.gmail?.messages?.length > 0) {
      const g = _store.gmail;
      const count = g.unreadCount ?? g.messages.filter(m => m.unread).length;
      const preview = g.messages.slice(0, 3)
        .map(m => `"${m.subject}" from ${_firstName(m.from)}`)
        .join('; ');
      parts.push(`Gmail on mirror: ${count} unread — ${preview}`);
    }

    if (_store.news?.length > 0) {
      const headlines = _store.news.slice(0, 3)
        .map(n => `"${n.title}" (${n.source})`)
        .join('; ');
      parts.push(`News on mirror: ${headlines}`);
    }

    if (_store.spotify?.connected && _store.spotify?.playback?.isPlaying) {
      const p = _store.spotify.playback;
      parts.push(`Spotify on mirror: playing "${p.title}" by ${p.artist}`);
    }

    return parts.length > 0
      ? `\n\nData currently on this mirror:\n${parts.join('\n')}`
      : '';
  },
};

/** Returns the first name or display name from an email "From" string. */
function _firstName(from = '') {
  const name = from.replace(/<.*>/, '').trim().split(/\s+/)[0];
  return name || from;
}
