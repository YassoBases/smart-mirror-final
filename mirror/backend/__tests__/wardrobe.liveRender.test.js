// POST /outfit/render/live — the hosted ("Live+") keyframe. Covers the contract
// and guard rails without a real Replicate call: input validation, the
// not-configured path, the per-profile spacing guard, and a mocked hosted render.

jest.mock("../lib/replicate", () => ({
  isConfigured: jest.fn(() => false),
  isImageGenConfigured: jest.fn(() => false),
  tryOn: jest.fn(),
  generateImage: jest.fn(),
  composeOutfit: jest.fn(),
  editImageWithRef: jest.fn(),
  uploadFile: jest.fn(async ({ filename }) => `https://replicate.test/uploads/${filename}`),
}));
jest.mock("../lib/pref_client", () => ({
  score: jest.fn(async () => null),
  train: jest.fn(async () => true),
  health: jest.fn(async () => null),
}));

const request = require("supertest");
const app = require("../src/app");
const replicate = require("../lib/replicate");
const settings = require("../src/services/settingsService");
const { seedHousehold, seedProfile, tokenFor, jpegBuffer } = require("./helpers");

describe("POST /api/profiles/:id/outfit/render/live", () => {
  let token, profileId, itemId, frame;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    const house = await seedHousehold("LiveHouse");
    token = tokenFor(house);
    profileId = await seedProfile(house.householdId, "Live");
    frame = await jpegBuffer(320, 240);
    const res = await request(app)
      .post(`/api/profiles/${profileId}/wardrobe/items`)
      .set("Authorization", `Bearer ${token}`)
      .attach("image", frame, "shirt.jpg");
    itemId = res.body.item.id;
  });
  afterAll(() => { global.fetch = originalFetch; });

  const post = () => request(app)
    .post(`/api/profiles/${profileId}/outfit/render/live`)
    .set("Authorization", `Bearer ${token}`);

  test("rejects a request without a camera frame", async () => {
    const res = await post().field("itemIds", JSON.stringify([itemId]));
    expect(res.status).toBe(400);
  });

  test("rejects malformed itemIds", async () => {
    const res = await post().field("itemIds", "not-json").attach("frame", frame, "frame.jpg");
    expect(res.status).toBe(400);
  });

  test("reports not-configured instead of silently returning the frame", async () => {
    const res = await post().field("itemIds", JSON.stringify([itemId])).attach("frame", frame, "frame.jpg");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("HOSTED_LIVE_UNSET");
    expect(replicate.composeOutfit).not.toHaveBeenCalled();
  });

  test("renders the live frame through the hosted composer and spaces repeat requests", async () => {
    await settings.setSetting("replicate_api_token", "r8_test");
    replicate.composeOutfit.mockResolvedValue("https://replicate.test/out.jpg");
    global.fetch = jest.fn(async () => ({ ok: true, arrayBuffer: async () => frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) }));

    const res = await post().field("itemIds", JSON.stringify([itemId])).attach("frame", frame, "frame.jpg");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fromCache: false, hostedRenderCount: 1, imagesSent: 2 });
    expect(res.body.renderUrl).toMatch(/\/renders\/live_[0-9a-f-]+\.jpg$/);
    // The FIRST image handed to the composer is the uploaded live frame, not the body photo.
    const { imageUrls } = replicate.composeOutfit.mock.calls[0][0];
    expect(imageUrls[0]).toBe("https://replicate.test/uploads/live-frame.jpg");

    const again = await post().field("itemIds", JSON.stringify([itemId])).attach("frame", frame, "frame.jpg");
    expect(again.status).toBe(429);
    expect(again.body.retryAfterMs).toBeGreaterThan(0);
    await settings.setSetting("replicate_api_token", "");
  });
});
