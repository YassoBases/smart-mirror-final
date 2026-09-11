// Real SQLite, HTTP/WebSocket handlers, and real Python models. Only hosted
// OpenAI/Replicate and Firebase delivery are intercepted at their boundaries.
jest.setTimeout(180000);
jest.mock('firebase-admin', () => ({
  credential: { cert: jest.fn(value => value) }, initializeApp: jest.fn(() => ({})),
  messaging: () => ({ sendEachForMulticast: mockPush }),
}));
const mockPush = jest.fn(async ({ tokens }) => ({ responses: tokens.map(() => ({ success: true })), successCount: tokens.length, failureCount: 0 }));
const request = require('supertest');
const WebSocket = require('ws');
const { once } = require('events');
const { startService, stopServices } = require('../test-support/pythonServices');
const { jpegBuffer } = require('./helpers');
const nativeFetch = global.fetch;
let app, token, profileId, otherId, mirrorId = 'e2e-mirror', wss, ws, img, ids = [], candidates = [];
const externalCalls = [], localCalls = [];
const auth = r => r.set('Authorization', `Bearer ${token}`);
const base = () => `/api/profiles/${profileId}`;
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
beforeAll(async () => {
  process.env.WARDROBE_ATTR_ENDPOINT_URL = await startService('wardrobe_attr', 'serve_clip');
  process.env.BG_REMOVER_URL = await startService('bg_remover', 'app');
  process.env.PREF_RANKER_URL = await startService('pref_ranker', 'app');
  process.env.OPENAI_API_KEY = 'test-external-boundary';
  process.env.REPLICATE_API_TOKEN = 'test-external-boundary';
  process.env.FIREBASE_SERVICE_ACCOUNT_B64 = Buffer.from('{}').toString('base64');
  img = await jpegBuffer(256, 256);
  global.fetch = jest.fn(async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1:')) { localCalls.push({ url: target, options }); return nativeFetch(url, options); }
    externalCalls.push({ url: target, options });
    if (target === 'https://api.openai.com/v1/chat/completions') return json({ choices: [{ message: { content: JSON.stringify({ candidates }) } }] });
    if (target.endsWith('/files')) return json({ urls: { get: 'https://fixture.example/input.png' } });
    if (target.includes('/models/')) return json({ latest_version: { id: 'fixture-version' } });
    if (target.endsWith('/predictions')) return json({ urls: { get: 'https://api.replicate.com/v1/predictions/fixture' } });
    if (target.endsWith('/predictions/fixture')) return json({ status: 'succeeded', output: ['https://fixture.example/output.jpg'] });
    if (target === 'https://fixture.example/output.jpg') return new Response(img);
    throw new Error(`Unexpected external request: ${target}`);
  });
  app = require('../src/app');
});
afterAll(async () => {
  global.fetch = nativeFetch;
  if (ws) ws.terminate();
  if (wss) await new Promise(resolve => wss.close(resolve));
  await stopServices();
});

test('household → account → profiles → single-use pairing → mirror polling', async () => {
  const house = await request(app).post('/api/households').send({ name: 'Journey household' }).expect(201);
  await request(app).post('/api/auth/register').send({ householdId: house.body.household.id, email: 'journey@example.com', password: 'journey-password' }).expect(201);
  const login = await request(app).post('/api/auth/login').send({ email: 'journey@example.com', password: 'journey-password' }).expect(200);
  token = login.body.token;
  expect(token).toEqual(expect.any(String));
  profileId = (await auth(request(app).post('/api/profiles')).send({ name: 'Alex' }).expect(201)).body.profile.id;
  otherId = (await auth(request(app).post('/api/profiles')).send({ name: 'Sam' }).expect(201)).body.profile.id;
  wss = require('../src/services/mirrorSync').start(0); await once(wss, 'listening');
  ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`); await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', mirror_public_key: mirrorId, short_code: 'JOURNY' }));
  const session = JSON.parse((await next)[0]); expect(session.type).toBe('pairing_session');
  next = once(ws, 'message');
  const paired = await auth(request(app).post('/api/mirrors/pair')).send({ sid: session.sid, shortCode: 'JOURNY' }).expect(200);
  console.log('E2E pair HTTP returned');
  expect(JSON.parse((await next)[0]).type).toBe('linked');
  console.log('E2E linked received'); expect(paired.body.mirrorId).toBe(mirrorId);
  await auth(request(app).post('/api/mirrors/pair')).send({ sid: session.sid, shortCode: 'JOURNY' }).expect(404);
  console.log('E2E code reuse checked');
  const sync = await request(app).get(`/api/mirrors/active-user?mid=${mirrorId}`).expect(200);
  expect(sync.body.profile).toMatchObject({ id: profileId, name: 'Alex' });
  const householdProfiles = await request(app).get(`/api/mirror/${mirrorId}/household-profiles`).expect(200);
  expect(householdProfiles.body.profiles.map(p => p.id)).toEqual(expect.arrayContaining([profileId, otherId]));
});

test('real garment classifier/removal → stored attributes → manual correction → retrieval', async () => {
  for (const warmth of [1, 5]) {
    const uploaded = await auth(request(app).post(`${base()}/wardrobe/items`)).attach('image', img, 'garment.jpg').expect(201);
    expect(uploaded.body.aiAttributesAvailable).toBe(true);
    const id = uploaded.body.item.id; ids.push(id);
    await auth(request(app).patch(`${base()}/wardrobe/items/${id}`)).send({ category: 'top', warmth, formality: warmth, seasons: warmth === 1 ? ['summer'] : ['winter'] }).expect(200);
  }
  console.log('E2E real images uploaded');
  const items = await auth(request(app).get(`${base()}/wardrobe/items`)).expect(200);
  expect(items.body.items.find(item => item.id === ids[1]).warmth).toBe(5);
  expect(localCalls.filter(call => call.url === process.env.WARDROBE_ATTR_ENDPOINT_URL)).toHaveLength(2);
  expect(localCalls.filter(call => call.url.endsWith('/remove'))).toHaveLength(2);
});

test('suggest → actual feedback threshold → real learned preference ranking', async () => {
  candidates = ids.map(id => ({ itemIds: [id], reasoning: 'fixture external stylist', confidence: .5 }));
  const context = { temperature: 25, season: 'summer', timeOfDay: 'day', weather: 'Clear' };
  await auth(request(app).post(`${base()}/outfit/suggest`)).send({ count: 2 }).expect(200);
  for (let i = 0; i < 10; i++) await auth(request(app).post(`${base()}/outfit/feedback`)).send({ itemIds: [ids[i % 2]], rating: i % 2 ? 'up' : 'down', context }).expect(200);
  const end = Date.now() + 15000;
  let health;
  do { health = await (await nativeFetch(`${process.env.PREF_RANKER_URL}/health`)).json(); if (JSON.stringify(health).includes(String(profileId))) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < end);
  const result = await auth(request(app).post(`${base()}/outfit/suggest`)).send({ count: 2 }).expect(200);
  expect(localCalls.some(call => call.url.endsWith('/train'))).toBe(true);
  expect(result.body.candidates[0].itemIds).toEqual([ids[1]]);
  expect(externalCalls.filter(call => call.url.includes('openai.com')).length).toBeGreaterThanOrEqual(2);
});

test('hosted render is cached and served as an accessible image without another upstream request', async () => {
  await auth(request(app).post(`${base()}/body-photo`)).attach('photo', img, 'body.jpg').expect(200);
  const first = await auth(request(app).post(`${base()}/outfit/render`)).send({ itemIds: [ids[0]] }).expect(200);
  expect(first.body).toMatchObject({ fromCache: false, hostedRenderCount: 1, imagesSent: 2 });
  const count = externalCalls.length;
  const second = await auth(request(app).post(`${base()}/outfit/render`)).send({ itemIds: [ids[0]] }).expect(200);
  expect(second.body).toMatchObject({ fromCache: true, hostedRenderCount: 0, imagesSent: 0 });
  expect(externalCalls).toHaveLength(count);
  expect(externalCalls.some(call => call.url.endsWith('/predictions'))).toBe(true);
  await request(app).get(new URL(second.body.renderUrl).pathname).expect(200).expect('Content-Type', /image/);
});

test('unknown face persists an alert and sends to the paired household devices', async () => {
  for (const token of ['device-one', 'device-two']) await auth(request(app).post('/api/devices/token')).send({ token, platform: 'android' }).expect(200);
  const alert = await request(app).post(`/api/mirrors/${mirrorId}/unknown-face`).send({ confidence: .72 }).expect(200);
  const list = await auth(request(app).get('/api/alerts')).expect(200);
  expect(list.body.alerts[0]).toMatchObject({ id: alert.body.alertId, mirrorId, alertType: 'UNKNOWN_FACE_DETECTED', imageUrl: null });
  expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ tokens: ['device-one', 'device-two'], data: expect.objectContaining({ alertId: String(alert.body.alertId) }) }));
});

test('phone widget changes reach mirror polling and switching changes wardrobe scope', async () => {
  await auth(request(app).patch(`/api/profiles/${otherId}/widgets`)).send({ widgets: { weather: false, wardrobe: true } }).expect(200);
  await request(app).post('/api/mirrors/active-user').send({ mirrorId, profileId: otherId }).expect(200);
  const state = await request(app).get(`/api/mirrors/active-user?mid=${mirrorId}`).expect(200);
  expect(state.body.profile).toMatchObject({ id: otherId, settings: { weather: false, wardrobe: true } });
  const empty = await request(app).get(`/api/mirrors/wardrobe/items?mid=${mirrorId}`).expect(200);
  expect(empty.body.items).toEqual([]);
  await request(app).post('/api/mirrors/active-user').send({ mirrorId, profileId }).expect(200);
  const restored = await request(app).get(`/api/mirrors/wardrobe/items?mid=${mirrorId}`).expect(200);
  expect(restored.body.items.map(item => item.id)).toEqual(expect.arrayContaining(ids));
});
