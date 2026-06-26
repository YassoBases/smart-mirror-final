const request = require("supertest");
const app = require("../src/app");
const { seedHousehold, seedProfile, tokenFor, jpegBuffer } = require("./helpers");

describe("wardrobe items routes (JWT)", () => {
  let house, token, profileId, img;

  beforeAll(async () => {
    house = await seedHousehold("Alpha");
    token = tokenFor(house);
    profileId = await seedProfile(house.householdId, "Alex");
    img = await jpegBuffer();
  });

  const base = () => `/api/profiles/${profileId}`;
  const auth = (r) => r.set("Authorization", `Bearer ${token}`);

  test("POST creates an item, runs the pipeline, returns full attributes", async () => {
    const res = await auth(request(app).post(`${base()}/wardrobe/items`)).attach(
      "image",
      img,
      { filename: "shirt.jpg", contentType: "image/jpeg" },
    );
    expect(res.status).toBe(201);
    expect(res.body.item).toBeDefined();
    expect(res.body.item.id).toEqual(expect.any(Number));
    expect(res.body.item.profileId).toBe(profileId);
    // images derived from request host + /wardrobe static path
    expect(res.body.item.imageUrl).toContain(`/wardrobe/${profileId}/`);
    expect(res.body.item.thumbnailUrl).toContain("/thumb.jpg");
    // BLIP-2 unset in tests -> stub fallback flag is false
    expect(res.body.aiAttributesAvailable).toBe(false);
    expect(["top", "bottom", "outerwear", "footwear", "accessory"]).toContain(
      res.body.item.category,
    );
  });

  test("POST without a file is 400", async () => {
    const res = await auth(request(app).post(`${base()}/wardrobe/items`));
    expect(res.status).toBe(400);
  });

  test("GET lists items and filters by category/season", async () => {
    // create a top and patch it so filters have something deterministic
    const created = await auth(
      request(app).post(`${base()}/wardrobe/items`),
    ).attach("image", img, { filename: "x.jpg", contentType: "image/jpeg" });
    await auth(request(app).patch(`${base()}/wardrobe/items/${created.body.item.id}`))
      .send({ category: "bottom", seasons: ["winter"] });

    const all = await auth(request(app).get(`${base()}/wardrobe/items`));
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body.items)).toBe(true);
    expect(all.body.items.length).toBeGreaterThanOrEqual(2);

    const bottoms = await auth(
      request(app).get(`${base()}/wardrobe/items?category=bottom`),
    );
    expect(bottoms.body.items.every((i) => i.category === "bottom")).toBe(true);

    const winter = await auth(
      request(app).get(`${base()}/wardrobe/items?season=winter`),
    );
    expect(winter.body.items.length).toBeGreaterThanOrEqual(1);
    expect(winter.body.items.every((i) => i.seasons.includes("winter"))).toBe(true);
  });

  test("PATCH updates editable attributes", async () => {
    const created = await auth(
      request(app).post(`${base()}/wardrobe/items`),
    ).attach("image", img, { filename: "x.jpg", contentType: "image/jpeg" });
    const id = created.body.item.id;

    const res = await auth(request(app).patch(`${base()}/wardrobe/items/${id}`)).send({
      category: "outerwear",
      formality: 4,
      tags: ["formal", "wool"],
      secondaryColors: ["#000000"],
      bogusKey: "ignored",
    });
    expect(res.status).toBe(200);
    expect(res.body.item.category).toBe("outerwear");
    expect(res.body.item.formality).toBe(4);
    expect(res.body.item.tags).toEqual(["formal", "wool"]);
    expect(res.body.item).not.toHaveProperty("bogusKey");
  });

  test("PATCH with invalid attr is 400 (zod)", async () => {
    const created = await auth(
      request(app).post(`${base()}/wardrobe/items`),
    ).attach("image", img, { filename: "x.jpg", contentType: "image/jpeg" });
    const res = await auth(
      request(app).patch(`${base()}/wardrobe/items/${created.body.item.id}`),
    ).send({ formality: 99, category: "spaceship" });
    expect(res.status).toBe(400);
  });

  test("DELETE soft-deletes (204) and item disappears from list", async () => {
    const created = await auth(
      request(app).post(`${base()}/wardrobe/items`),
    ).attach("image", img, { filename: "x.jpg", contentType: "image/jpeg" });
    const id = created.body.item.id;

    const del = await auth(request(app).delete(`${base()}/wardrobe/items/${id}`));
    expect(del.status).toBe(204);

    const list = await auth(request(app).get(`${base()}/wardrobe/items`));
    expect(list.body.items.find((i) => i.id === id)).toBeUndefined();
  });

  test("no Authorization header is 401", async () => {
    const res = await request(app).get(`${base()}/wardrobe/items`);
    expect(res.status).toBe(401);
  });
});

describe("household scoping guard", () => {
  test("a profile from another household is 403", async () => {
    const houseA = await seedHousehold("ScopeA");
    const houseB = await seedHousehold("ScopeB");
    const tokenA = tokenFor(houseA);
    const profileB = await seedProfile(houseB.householdId, "Bob");

    // caller from household A tries to touch household B's profile
    const res = await request(app)
      .get(`/api/profiles/${profileB}/wardrobe/items`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(403);

    const img = await jpegBuffer();
    const post = await request(app)
      .post(`/api/profiles/${profileB}/wardrobe/items`)
      .set("Authorization", `Bearer ${tokenA}`)
      .attach("image", img, { filename: "x.jpg", contentType: "image/jpeg" });
    expect(post.status).toBe(403);
  });
});
