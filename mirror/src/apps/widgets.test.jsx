import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import Clock from './ClockApp';
import DateApp from './DateApp';
import DateTime from './DateTimeApp';
import Weather from './WeatherApp';
import News from './NewsApp';
import Gmail from './gmail/GmailApp';
import Spotify from './spotify/App';
jest.mock('../hooks/useResponsiveFontScale', () => () => 1);
jest.mock('../contexts/ProfileContext', () => ({ useProfile: () => ({ activeProfile: null }) }));
jest.mock('../services/backendApi', () => ({ backendApi: { getMirrorId: () => 'widget-test' } }));
const response = data => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
beforeAll(() => { if (!AbortSignal.timeout) AbortSignal.timeout = () => new AbortController().signal; });
afterEach(() => { cleanup(); jest.restoreAllMocks(); });
test.each([Clock, DateApp, DateTime])('local date/time widget renders without network data', Component => {
  global.fetch = jest.fn(); const { container } = render(<Component />);
  expect(container.textContent.length).toBeGreaterThan(3); expect(fetch).not.toHaveBeenCalled();
});
test.each(['data', 'empty', 'error'])('Gmail %s state', async mode => {
  global.fetch = jest.fn(async url => {
    if (mode === 'error') throw new Error('Backend unreachable');
    return response(String(url).includes('/status') ? { connected: true, email: 'fixture@example.com' } : {
      messages: mode === 'empty' ? [] : [{ id: '1', from: 'Alex', subject: 'Meeting tomorrow', timestamp: new Date().toISOString() }], unreadCount: 0,
    });
  });
  render(<Gmail />);
  expect(await screen.findByText(mode === 'data' ? 'Meeting tomorrow' : mode === 'empty' ? 'No emails available' : 'Backend unreachable')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalled();
});
test.each(['data', 'empty', 'error'])('Spotify %s state', async mode => {
  global.fetch = jest.fn(async () => {
    if (mode === 'error') throw new Error('Backend unreachable');
    return response({ connected: true, track: mode === 'data' ? { name: 'Fixture song', artist: 'Artist', durationMs: 200000 } : null, devices: [] });
  });
  render(<Spotify />);
  expect(await screen.findByText(mode === 'data' ? 'Fixture song' : mode === 'empty' ? 'Nothing playing' : 'Backend unreachable')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalled();
});
test.each(['data', 'empty', 'error'])('Weather %s state', async mode => {
  global.fetch = jest.fn(async url => {
    if (mode === 'error') throw new Error('Offline');
    if (String(url).includes('geocoding')) return response({ results: mode === 'empty' ? [] : [{ name: 'Fixture City', latitude: 1, longitude: 1 }] });
    return response({ current: { temperature_2m: 23, apparent_temperature: 23, weathercode: 0, wind_speed_10m: 5 }, daily: { time: [], weathercode: [], temperature_2m_max: [], temperature_2m_min: [] } });
  });
  render(<Weather />);
  expect(await screen.findByText(mode === 'data' ? 'Fixture City' : 'Unable to fetch weather data')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalled();
});
test.each(['data', 'empty', 'error'])('News %s state', async mode => {
  global.fetch = jest.fn(async () => {
    if (mode === 'error') throw new Error('Offline');
    return { ok: true, text: async () => `<rss><channel>${mode === 'data' ? '<item><title>Fixture headline</title><link>https://example.com/story</link><pubDate>Fri, 11 Sep 2026 00:00:00 GMT</pubDate></item>' : ''}</channel></rss>` };
  });
  render(<News />);
  if (mode === 'data') expect((await screen.findAllByText('Fixture headline')).length).toBeGreaterThan(0);
  else expect(await screen.findByText(/no news|could not|unable|failed/i)).toBeInTheDocument();
  expect(fetch).toHaveBeenCalled();
});
