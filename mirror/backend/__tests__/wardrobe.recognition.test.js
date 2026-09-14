// Garment-identity recognition: /wardrobe/recognize (never persists) and
// /wardrobe/recognize/enroll (only path that creates anything). The identity
// service is mocked — this tests the backend's contract (threshold matching,
// averaging frames, non-persistence, and app-facing shape parity with a
// manually-created item), not the CLIP model itself.

jest.mock("../lib/wardrobe_identity_client", () => ({
  isConfigured: jest.fn(() => true),
  getEmbedding: jest.fn(),
}));

const request = require("supertest");
const app = require("../src/app");
const identityClient = require("../lib/wardrobe_identity_client");
const { seedHousehold, seedProfile, tokenFor, jpegBuffer } = require("./helpers");

describe("garment-identity recognition (JWT)", () => {
  let house, token, profileId, img;

  beforeEach(async () => {
    identityClient.isConfigured.mockReturnValue(true);
    identityClient.getEmbedding.mockReset();
  });

  beforeAll(async () => {
    house = await seedHousehold("RecogHouse");
    token = tokenFor(house);
    profileId = await seedProfile(house.householdId, "Sam");
    img = await jpegBuffer();
  });

  const base = () => `/api/profiles/${profileId}`;
  const auth = (r) => r.set("Authorization", `Bearer ${token}`);
  const itemCount = async () => (await auth(request(app).get(`${base()}/wardrobe/items`))).body.items.length;

  test("POST /recognize with no images is 400", async () => {
    const res = await auth(request(app).post(`${base()}/wardrobe/recognize`));
    expect(res.status).toBe(400);
  });

  test("POST /recognize reports unavailable (not unknown) when the identity service isn't configured", async () => {
    identityClient.isConfigured.mockReturnValue(false);
    const res = await auth(request(app).post(`${base()}/wardrobe/recognize`)).attach("images", img, "frame.jpg");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unavailable");
    expect(identityClient.getEmbedding).not.toHaveBeenCalled();
  });

  test("POST /recognize against an empty gallery is unknown, and persists nothing", async () => {
    identityClient.getEmbedding.mockResolvedValue({ embedding: [1, 0, 0, 0], dim: 4, projected: true });
    const before = await itemCount();
    const res = await auth(request(app).post(`${base()}/wardrobe/recognize`)).attach("images", img, "frame.jpg");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unknown");
    expect(res.body.item).toBeUndefined();
    expect(await itemCount()).toBe(before); // nothing was created just by asking
  });

  test("POST /recognize/enroll creates an item through the same pipeline as a manual upload, then /recognize finds it", async () => {
    identityClient.getEmbedding.mockResolvedValue({ embedding: [0, 1, 0, 0], dim: 4, projected: true });

    const enrolled = await auth(request(app).post(`${base()}/wardrobe/recognize/enroll`)).attach("image", img, "shirt.jpg");
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.recognitionEnrolled).toBe(true);
    expect(enrolled.body.item.id).toEqual(expect.any(Number));
    // Same pipeline as manual creation -> real attributes, not a stub shape.
    expect(["top", "bottom", "outerwear", "footwear", "accessory"]).toContain(enrolled.body.item.category);

    const recognized = await auth(request(app).post(`${base()}/wardrobe/recognize`)).attach("images", img, "frame.jpg");
    expect(recognized.status).toBe(200);
    expect(recognized.body.status).toBe("recognized");
    expect(recognized.body.item.id).toBe(enrolled.body.item.id);
    expect(recognized.body.similarity).toBeGreaterThanOrEqual(0.8);
  });

  test("an auto-enrolled item is indistinguishable from a manually-created one in GET /items", async () => {
    identityClient.getEmbedding.mockResolvedValue({ embedding: [0, 0, 1, 0], dim: 4, projected: true });
    const enrolled = await auth(request(app).post(`${base()}/wardrobe/recognize/enroll`)).attach("image", img, "jeans.jpg");
    const manual = await auth(request(app).post(`${base()}/wardrobe/items`)).attach("image", img, "jeans2.jpg");

    const list = await auth(request(app).get(`${base()}/wardrobe/items`));
    const autoItem = list.body.items.find((i) => i.id === enrolled.body.item.id);
    const manualItem = list.body.items.find((i) => i.id === manual.body.item.id);
    expect(Object.keys(autoItem).sort()).toEqual(Object.keys(manualItem).sort());
    for (const key of Object.keys(manualItem)) {
      expect(typeof autoItem[key]).toBe(typeof manualItem[key]);
    }
    // The recognition gallery is never part of the item's own API shape.
    expect(autoItem.embedding).toBeUndefined();
  });

  test("recognition averages a short burst of frames before matching (not just the last one)", async () => {
    // Plant a gallery item exactly at the midpoint of two very different
    // single-frame embeddings, then confirm sending those two frames together
    // (not either one alone) is what matches it.
    const midpoint = Math.SQRT1_2;
    identityClient.getEmbedding.mockResolvedValueOnce({ embedding: [midpoint, midpoint], dim: 2, projected: true });
    const planted = await auth(request(app).post(`${base()}/wardrobe/recognize/enroll`)).attach("image", img, "planted.jpg");
    expect(planted.body.recognitionEnrolled).toBe(true);

    identityClient.getEmbedding
      .mockResolvedValueOnce({ embedding: [1, 0], dim: 2, projected: true })
      .mockResolvedValueOnce({ embedding: [0, 1], dim: 2, projected: true });
    const res = await auth(request(app).post(`${base()}/wardrobe/recognize`))
      .attach("images", img, "f1.jpg").attach("images", img, "f2.jpg");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("recognized");
    expect(res.body.item.id).toBe(planted.body.item.id);
    expect(res.body.similarity).toBeCloseTo(1, 4);
  });
});
