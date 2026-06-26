// Phase 3: outfit suggest (mocked OpenAI), render (mocked Replicate + cache),
// feedback → train threshold, context, and metrics.

jest.mock("../lib/openai", () => ({
  isConfigured: jest.fn(async () => true),
  suggestOutfits: jest.fn(),
  generateOutfits: jest.fn(),
  resolveKey: jest.fn(async () => "test-key"),
  MODEL: "test-model",
}));
jest.mock("../lib/replicate", () => ({
  isConfigured: jest.fn(() => false),
  isImageGenConfigured: jest.fn(() => false),
  tryOn: jest.fn(),
  generateImage: jest.fn(),
}));
jest.mock("../lib/pref_client", () => ({
  score: jest.fn(async () => null),
  train: jest.fn(async () => true),
  health: jest.fn(async () => null),
}));

const request = require("supertest");
const app = require("../src/app");
const openai = require("../lib/openai");
const replicate = require("../lib/replicate");
const prefClient = require("../lib/pref_client");
const { crossesTrainThreshold } = require("../src/controllers/wardrobeController");
const { seedHousehold, seedProfile, tokenFor, jpegBuffer } = require("./helpers");

let house, token, profileId, img;
const base = () => `/api/profiles/${profileId}`;
const auth = (r) => r.set("Authorization", `Bearer ${token}`);

async function makeItem(category) {
  const created = await auth(request(app).post(`${base()}/wardrobe/items`)).attach(
    "image",
    img,
    { filename: "x.jpg", contentType: "image/jpeg" },
  );
  await auth(request(app).patch(`${base()}/wardrobe/items/${created.body.item.id}`)).send({
    category,
  });
  return created.body.item.id;
}

beforeAll(async () => {
  house = await seedHousehold("Outfit");
  token = tokenFor(house);
  profileId = await seedProfile(house.householdId, "Olivia");
  img = await jpegBuffer();
});

afterEach(() => jest.clearAllMocks());

describe("outfit/suggest", () => {
  test("returns Claude candidates and drops hallucinated item ids", async () => {
    const topId = await makeItem("top");
    const bottomId = await makeItem("bottom");

    openai.suggestOutfits.mockResolvedValueOnce({
      candidates: [
        { itemIds: [topId, bottomId, 99999], reasoning: "henley + chinos", confidence: 0.9 },
      ],
    });

    const res = await auth(request(app).post(`${base()}/outfit/suggest`)).send({ count: 1 });
    expect(res.status).toBe(200);
    expect(openai.suggestOutfits).toHaveBeenCalledTimes(1);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].itemIds).toEqual([topId, bottomId]); // 99999 dropped
    expect(res.body.context).toHaveProperty("season");
    expect(res.body.context).toHaveProperty("timeOfDay");
  });

  test("falls back to local heuristic when Claude throws", async () => {
    openai.suggestOutfits.mockRejectedValueOnce(new Error("boom"));
    const res = await auth(request(app).post(`${base()}/outfit/suggest`)).send({});
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.candidates)).toBe(true);
    expect(res.body.candidates.length).toBeGreaterThanOrEqual(1);
  });

  test("re-ranks by pref score when available", async () => {
    const topId = await makeItem("top");
    const bottomId = await makeItem("bottom");
    openai.suggestOutfits.mockResolvedValueOnce({
      candidates: [
        { itemIds: [topId], reasoning: "a", confidence: 0.5 },
        { itemIds: [bottomId], reasoning: "b", confidence: 0.5 },
      ],
    });
    // second candidate scores higher → should be reordered first
    prefClient.score.mockResolvedValueOnce([0.1, 0.9]);
    const res = await auth(request(app).post(`${base()}/outfit/suggest`)).send({ count: 2 });
    expect(res.body.candidates[0].itemIds).toEqual([bottomId]);
  });

  test("threads the chosen occasion into context", async () => {
    const topId = await makeItem("top");
    const bottomId = await makeItem("bottom");
    openai.suggestOutfits.mockResolvedValueOnce({
      candidates: [{ itemIds: [topId, bottomId], reasoning: "r", confidence: 0.9 }],
    });
    const res = await auth(request(app).post(`${base()}/outfit/suggest`)).send({
      count: 1,
      occasion: "formal",
    });
    expect(res.status).toBe(200);
    // The stylist receives the occasion in its context...
    const arg = openai.suggestOutfits.mock.calls[0][0];
    expect(arg.context.occasion).toBe("formal");
    // ...and it is echoed back so the app can show it / store it in feedback.
    expect(res.body.context.occasion).toBe("formal");
  });
});

describe("outfit/generate", () => {
  test("invents outfits with shopping links; no image when gen unconfigured", async () => {
    openai.generateOutfits.mockResolvedValueOnce({
      candidates: [
        {
          items: [
            {
              category: "top",
              subcategory: "henley",
              primaryColor: "#223344",
              description: "navy waffle henley",
              imagePrompt: "navy waffle henley",
            },
          ],
          reasoning: "Layered for a cool evening.",
          confidence: 0.8,
        },
      ],
    });
    const res = await auth(request(app).post(`${base()}/outfit/generate`)).send({
      count: 1,
      occasion: "casual",
    });
    expect(res.status).toBe(200);
    expect(openai.generateOutfits).toHaveBeenCalledTimes(1);
    const item = res.body.candidates[0].items[0];
    expect(item.searchUrl).toContain("tbm=shop");
    expect(item.searchUrl.toLowerCase()).toContain("navy");
    expect(item.imageUrl).toBeNull(); // image gen unconfigured -> concept only
    expect(res.body.context).toHaveProperty("season");
  });

  test("503 when the stylist is not configured", async () => {
    openai.isConfigured.mockReturnValueOnce(false);
    const res = await auth(request(app).post(`${base()}/outfit/generate`)).send({});
    expect(res.status).toBe(503);
  });
});

describe("generated-outfit feedback", () => {
  test("accepts item attributes (no ids) and trains on them", async () => {
    const h = await seedHousehold("Gen");
    const tk = tokenFor(h);
    const pid = await seedProfile(h.householdId, "Gina");
    const a = (r) => r.set("Authorization", `Bearer ${tk}`);
    const genItem = {
      category: "top",
      subcategory: "henley",
      primaryColor: "#223344",
      pattern: "solid",
      formality: 2,
      warmth: 2,
      seasons: ["spring"],
    };
    for (let i = 0; i < 10; i++) {
      const res = await a(
        request(app).post(`/api/profiles/${pid}/outfit/feedback`),
      ).send({
        items: [genItem],
        rating: i % 2 === 0 ? "up" : "down",
        reasoningShown: "because",
        context: { season: "spring", occasion: "casual" },
      });
      expect(res.status).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(prefClient.train).toHaveBeenCalledWith(pid, expect.any(Array));
    const samples = prefClient.train.mock.calls[0][1];
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0].items.length).toBeGreaterThan(0);
    expect(samples[0].items[0]).toHaveProperty("category", "top");
  });
});

describe("outfit/render", () => {
  test("400 when no body photo is set", async () => {
    const res = await auth(request(app).post(`${base()}/outfit/render`)).send({ itemIds: [1] });
    expect(res.status).toBe(400);
  });

  test("renders (fallback) then serves a cache hit", async () => {
    const topId = await makeItem("top");
    const bottomId = await makeItem("bottom");
    await auth(request(app).post(`${base()}/body-photo`)).attach("photo", img, {
      filename: "me.jpg",
      contentType: "image/jpeg",
    });

    const first = await auth(request(app).post(`${base()}/outfit/render`)).send({
      itemIds: [topId, bottomId],
    });
    expect(first.status).toBe(200);
    expect(first.body.fromCache).toBe(false);
    expect(first.body.renderUrl).toContain(`/wardrobe/${profileId}/renders/`);

    // same outfit + same body photo → cache hit (order-independent)
    const second = await auth(request(app).post(`${base()}/outfit/render`)).send({
      itemIds: [bottomId, topId],
    });
    expect(second.body.fromCache).toBe(true);
    // supertest binds a fresh ephemeral port per request, so only the path is stable
    const pathOf = (u) => new URL(u).pathname;
    expect(pathOf(second.body.renderUrl)).toBe(pathOf(first.body.renderUrl));
  });

  test("uses Replicate VTON when configured", async () => {
    const topId = await makeItem("top");
    await auth(request(app).post(`${base()}/body-photo`)).attach("photo", img, {
      filename: "me2.jpg",
      contentType: "image/jpeg",
    });

    replicate.isConfigured.mockReturnValue(true);
    replicate.tryOn.mockResolvedValue("https://replicate.test/out.png");
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => (await jpegBuffer()).buffer,
    }));

    try {
      const res = await auth(request(app).post(`${base()}/outfit/render`)).send({
        itemIds: [topId],
      });
      expect(res.status).toBe(200);
      expect(replicate.tryOn).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith("https://replicate.test/out.png");
    } finally {
      global.fetch = realFetch;
      replicate.isConfigured.mockReturnValue(false);
    }
  });
});

describe("feedback → train threshold", () => {
  test("crossesTrainThreshold fires at 10, 50, 100, every 100", () => {
    const hits = [];
    for (let n = 1; n <= 320; n++) if (crossesTrainThreshold(n)) hits.push(n);
    expect(hits).toEqual([10, 50, 100, 200, 300]);
  });

  test("posting the 10th feedback triggers a train call; GET lists feedback", async () => {
    const h = await seedHousehold("Fb");
    const tk = tokenFor(h);
    const pid = await seedProfile(h.householdId, "Fred");
    const fbBase = `/api/profiles/${pid}`;
    const a = (r) => r.set("Authorization", `Bearer ${tk}`);

    // Real items so feedback resolves to training samples with attributes.
    const mk = async () => {
      const c = await a(request(app).post(`${fbBase}/wardrobe/items`)).attach(
        "image",
        img,
        { filename: "x.jpg", contentType: "image/jpeg" },
      );
      return c.body.item.id;
    };
    const t1 = await mk();
    const b1 = await mk();

    for (let i = 0; i < 10; i++) {
      const res = await a(request(app).post(`${fbBase}/outfit/feedback`)).send({
        itemIds: [t1, b1],
        rating: i % 2 === 0 ? "up" : "down",
        reasoningShown: "because",
        context: { season: "winter" },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
    // train fires on the 10th insert (fire-and-forget) — give the microtask a tick
    await new Promise((r) => setTimeout(r, 20));
    expect(prefClient.train).toHaveBeenCalledWith(pid, expect.any(Array));
    // samples should carry resolved item attributes + a 1/0 label
    const samples = prefClient.train.mock.calls[0][1];
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]).toHaveProperty("label");

    const list = await a(request(app).get(`${fbBase}/outfit/feedback?limit=5`));
    expect(list.status).toBe(200);
    expect(list.body.feedback.length).toBe(5);
    expect(list.body.feedback[0]).toHaveProperty("rating");
  });
});

describe("context + metrics", () => {
  test("GET /context returns time/season", async () => {
    const res = await auth(request(app).get(`${base()}/context`));
    expect(res.status).toBe(200);
    expect(["winter", "spring", "summer", "autumn"]).toContain(res.body.season);
    expect(["morning", "afternoon", "evening", "night"]).toContain(res.body.timeOfDay);
  });

  test("GET /metrics/acceptance buckets feedback by week", async () => {
    const h = await seedHousehold("Metrics");
    const tk = tokenFor(h);
    const pid = await seedProfile(h.householdId, "Mae");
    const a = (r) => r.set("Authorization", `Bearer ${tk}`);
    for (let i = 0; i < 4; i++) {
      await a(request(app).post(`/api/profiles/${pid}/outfit/feedback`)).send({
        itemIds: [1],
        rating: i < 3 ? "up" : "down",
      });
    }
    const res = await a(request(app).get(`/api/profiles/${pid}/metrics/acceptance`));
    expect(res.status).toBe(200);
    expect(res.body.buckets.length).toBeGreaterThanOrEqual(1);
    const total = res.body.buckets.reduce((s, b) => s + b.total, 0);
    const accepted = res.body.buckets.reduce((s, b) => s + b.accepted, 0);
    expect(total).toBe(4);
    expect(accepted).toBe(3);
    expect(res.body).toHaveProperty("modelTrainedAt");
  });
});
