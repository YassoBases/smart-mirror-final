// The mirror widget has no JWT; it calls /api/mirrors/wardrobe/*?mid=<mirrorId>
// and the route resolves the active profile from the active-user mechanism.
const request = require("supertest");
const app = require("../src/app");
const { getDb } = require("../src/config/database");
const { seedHousehold, seedProfile, jpegBuffer } = require("./helpers");

describe("mirror wardrobe routes (?mid=, no JWT)", () => {
  let profileId;
  const mid = "mirror-uuid-123";

  beforeAll(async () => {
    const house = await seedHousehold("Mirror");
    profileId = await seedProfile(house.householdId, "Mira");
    // link this profile to the mirror, as setActiveMirrorUser / pairing would
    const db = await getDb();
    await db.run("UPDATE profiles SET mirror_id = ? WHERE id = ?", mid, profileId);
  });

  test("missing mid is 400", async () => {
    const res = await request(app).get("/api/mirrors/wardrobe/items");
    expect(res.status).toBe(400);
  });

  test("unknown mid is 404 (no active profile)", async () => {
    const res = await request(app).get("/api/mirrors/wardrobe/items?mid=nope");
    expect(res.status).toBe(404);
  });

  test("create + list via mid resolves to the active profile", async () => {
    const img = await jpegBuffer();
    const post = await request(app)
      .post(`/api/mirrors/wardrobe/items?mid=${mid}`)
      .attach("image", img, { filename: "x.jpg", contentType: "image/jpeg" });
    expect(post.status).toBe(201);
    expect(post.body.item.profileId).toBe(profileId);

    const list = await request(app).get(`/api/mirrors/wardrobe/items?mid=${mid}`);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
  });
});
