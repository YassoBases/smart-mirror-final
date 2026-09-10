const names = ['WARDROBE_ATTR_ENDPOINT_URL', 'WARDROBE_ATTR_ENDPOINT_TOKEN', 'BLIP2_ENDPOINT_URL', 'BLIP2_ENDPOINT_TOKEN'];
const original = Object.fromEntries(names.map(k => [k, process.env[k]]));
const originalFetch = global.fetch;
beforeEach(() => {
  names.forEach(k => delete process.env[k]);
  jest.resetModules();
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ category: 'top' }) }));
});
afterAll(() => {
  names.forEach(k => original[k] === undefined ? delete process.env[k] : process.env[k] = original[k]);
  global.fetch = originalFetch;
});
test.each([
  ['old only', { BLIP2_ENDPOINT_URL: 'https://old.test/', BLIP2_ENDPOINT_TOKEN: 'old' }, 'https://old.test', 'old'],
  ['new only', { WARDROBE_ATTR_ENDPOINT_URL: 'https://new.test/', WARDROBE_ATTR_ENDPOINT_TOKEN: 'new' }, 'https://new.test', 'new'],
  ['both', { BLIP2_ENDPOINT_URL: 'https://old.test/', BLIP2_ENDPOINT_TOKEN: 'old', WARDROBE_ATTR_ENDPOINT_URL: 'https://new.test/', WARDROBE_ATTR_ENDPOINT_TOKEN: 'new' }, 'https://new.test', 'new'],
  ['empty token', { BLIP2_ENDPOINT_TOKEN: 'old', WARDROBE_ATTR_ENDPOINT_URL: 'https://new.test/', WARDROBE_ATTR_ENDPOINT_TOKEN: '' }, 'https://new.test', null],
])('%s configuration', async (_, env, url, token) => {
  Object.assign(process.env, env);
  const client = require('../lib/wardrobe_attr_client');
  expect(client.isConfigured()).toBe(true);
  expect((await client.captionImage(Buffer.from('fixture'))).available).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [actualUrl, options] = global.fetch.mock.calls[0];
  expect(actualUrl).toBe(url);
  expect(options.headers.Authorization).toBe(token ? `Bearer ${token}` : undefined);
});
test('explicitly empty URL disables legacy fallback', async () => {
  process.env.BLIP2_ENDPOINT_URL = 'https://old.test';
  process.env.WARDROBE_ATTR_ENDPOINT_URL = '';
  const client = require('../lib/wardrobe_attr_client');
  expect(client.isConfigured()).toBe(false);
  expect((await client.captionImage(Buffer.from('fixture'))).available).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();
});
