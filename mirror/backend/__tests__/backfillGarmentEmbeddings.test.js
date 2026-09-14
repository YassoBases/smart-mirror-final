// Backfill script: enrolls pre-existing wardrobe items (created before the
// recognition feature, or via the normal manual upload since) into
// garment_embeddings, using the same insertion enrollRecognizedGarment uses.
//
// Each test gets its own profile — the backfill query scopes by profile, but
// the shared test DB doesn't otherwise isolate items/embeddings across tests,
// and this suite plants leftover un-backfilled items (dry run) and multiple
// gallery entries on purpose, so cross-test bleed would silently corrupt
// later assertions (an earlier item's embedding winning a similarity match
// meant for this test's item, or a leftover item failing to embed because an
// earlier test's mock got reset).

jest.mock("../lib/wardrobe_identity_client", () => ({
  isConfigured: jest.fn(() => true),
  getEmbedding: jest.fn(),
}));

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../src/app");
const { getDb } = require("../src/config/database");
const wardrobeDb = require("../db/wardrobe");
const identityClient = require("../lib/wardrobe_identity_client");
const { backfillMissingEmbeddings } = require("../scripts/backfill_garment_embeddings");
const { seedHousehold, seedProfile, tokenFor, jpegBuffer } = require("./helpers");

describe("backfillMissingEmbeddings", () => {
  let img;

  beforeAll(async () => { img = await jpegBuffer(); });
  beforeEach(() => { identityClient.getEmbedding.mockReset(); });

  // Fresh household + profile per test, so each test's gallery starts empty.
  async function newProfile() {
    const house = await seedHousehold("BackfillHouse");
    const token = tokenFor(house);
    const profileId = await seedProfile(house.householdId, "Backfill");
    return { token, profileId };
  }
  const auth = (token, r) => r.set("Authorization", `Bearer ${token}`);
  const createManualItem = async (token, profileId) => {
    // Real pipeline (bg-remove/thumbnail/classify), same as any item added
    // before the recognition feature existed — identityClient is mocked, but
    // nothing here touches it, matching how items were actually created pre-feature.
    const res = await auth(token, request(app).post(`/api/profiles/${profileId}/wardrobe/items`)).attach("image", img, "item.jpg");
    return res.body.item;
  };
  const embeddingRow = async (db, itemId) => db.get("SELECT * FROM garment_embeddings WHERE item_id = ?", itemId);

  test("backfills only items missing a row, leaves existing embeddings alone, and reports accurate counts", async () => {
    const db = await getDb();
    const { token, profileId } = await newProfile();
    const itemA = await createManualItem(token, profileId);
    const itemB = await createManualItem(token, profileId);
    const itemC = await createManualItem(token, profileId); // pre-enrolled before the backfill runs

    // Simulate itemC already having gone through the real recognition-enroll
    // path at some point (e.g. testing, or a prior partial backfill run).
    await wardrobeDb.upsertGarmentEmbedding(db, itemC.id, profileId, [1, 0, 0, 0], true);

    identityClient.getEmbedding
      .mockResolvedValueOnce({ embedding: [0.1, 0.2, 0.3, 0.4], dim: 4, projected: false })
      .mockResolvedValueOnce({ embedding: [0.5, 0.6, 0.7, 0.8], dim: 4, projected: false });

    const summary = await backfillMissingEmbeddings(db, { profile: profileId });
    expect(summary).toMatchObject({ backfilled: 2, alreadyHadEmbedding: 1, skippedNoFile: 0, failed: 0, total: 2 });
    expect(identityClient.getEmbedding).toHaveBeenCalledTimes(2);

    // Every pre-existing item now has exactly one row.
    for (const item of [itemA, itemB, itemC]) {
      const row = await embeddingRow(db, item.id);
      expect(row).toBeDefined();
    }
    // itemC's original (pre-existing) embedding was left untouched, not re-fetched.
    const rowC = await embeddingRow(db, itemC.id);
    expect(JSON.parse(rowC.embedding)).toEqual([1, 0, 0, 0]);
  });

  test("re-running is a no-op once everything is backfilled — no duplicate rows, backfilled: 0", async () => {
    const db = await getDb();
    const { token, profileId } = await newProfile();
    const item = await createManualItem(token, profileId);
    identityClient.getEmbedding.mockResolvedValue({ embedding: [0.2, 0.2, 0.2, 0.2], dim: 4, projected: false });

    const first = await backfillMissingEmbeddings(db, { profile: profileId });
    expect(first.backfilled).toBe(1);

    identityClient.getEmbedding.mockClear();
    const second = await backfillMissingEmbeddings(db, { profile: profileId });
    expect(second.backfilled).toBe(0);
    expect(identityClient.getEmbedding).not.toHaveBeenCalled();

    const rows = await db.all("SELECT * FROM garment_embeddings WHERE item_id = ?", item.id);
    expect(rows).toHaveLength(1); // never duplicated
  });

  test("dry run reports what it would do without writing anything", async () => {
    const db = await getDb();
    const { token, profileId } = await newProfile();
    const item = await createManualItem(token, profileId);
    identityClient.getEmbedding.mockResolvedValue({ embedding: [0.3, 0.3, 0.3, 0.3], dim: 4, projected: false });

    const summary = await backfillMissingEmbeddings(db, { profile: profileId, dryRun: true });
    expect(summary.backfilled).toBe(1);
    expect(await embeddingRow(db, item.id)).toBeUndefined();
  });

  test("an item whose stored photo is missing on disk is skipped, not failed", async () => {
    const db = await getDb();
    const { token, profileId } = await newProfile();
    const item = await createManualItem(token, profileId);
    const nobgPath = path.join(wardrobeDb.itemDir(profileId, item.id), "nobg.png");
    fs.unlinkSync(nobgPath);

    const summary = await backfillMissingEmbeddings(db, { profile: profileId });
    expect(summary).toMatchObject({ backfilled: 0, skippedNoFile: 1, failed: 0 });
    expect(identityClient.getEmbedding).not.toHaveBeenCalled();
  });

  test("a backfilled item is recognizable from a fresh photo of the same garment, above threshold", async () => {
    const db = await getDb();
    const { token, profileId } = await newProfile();
    const item = await createManualItem(token, profileId);
    identityClient.getEmbedding.mockResolvedValueOnce({ embedding: [0, 1, 0, 0], dim: 4, projected: true });
    const backfill = await backfillMissingEmbeddings(db, { profile: profileId });
    expect(backfill.backfilled).toBe(1);

    // A DIFFERENT capture of the same physical garment — not the stored photo,
    // a fresh one — happens to embed close to (not identical to) the stored one.
    identityClient.getEmbedding.mockResolvedValueOnce({ embedding: [0.02, 0.999, 0.01, 0], dim: 4, projected: true });
    const res = await auth(token, request(app).post(`/api/profiles/${profileId}/wardrobe/recognize`)).attach("images", img, "fresh.jpg");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("recognized");
    expect(res.body.item.id).toBe(item.id);
    expect(res.body.similarity).toBeGreaterThanOrEqual(0.8);
  });
});
