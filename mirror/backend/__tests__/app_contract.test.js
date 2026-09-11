// Contract tests between the backend's real HTTP responses and the fields
// app/lib (the Flutter client, read-only from this repo's perspective) is
// actually written to read. app/lib/models/profile.dart and
// app/lib/services/api_service.dart decode defensively — multiple key
// conventions, JSON-string-or-object — which was a pragmatic response to past
// backend field-naming churn rather than a design choice. That defensiveness
// hides drift unless something checks both sides against each other.
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../src/app");
const { seedHousehold, seedProfile, tokenFor } = require("./helpers");

// Fields app/lib/models/profile.dart's Profile.fromJson reads off the raw
// response (see that file for the full list).
const PROFILE_LIST_FIELDS = [
  "id", "household_id", "name", "email", "google_sub", "mirror_id",
  "face_filename", "face_filenames", "created_at", "widgets_config",
];
const PROFILE_SINGLE_ONLY_FIELDS = ["spotify_connected", "spotify_display_name"];

describe("app/lib Profile contract", () => {
  let house, token, profileId;

  beforeAll(async () => {
    house = await seedHousehold("ContractHouse");
    token = tokenFor(house);
    profileId = await seedProfile(house.householdId, "Contract Test Profile");
  });

  test("GET /api/profiles (list) returns every field the client's Profile.fromJson reads, except the documented spotify gap", async () => {
    const res = await request(app)
      .get("/api/profiles")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const profile = res.body.profiles.find((p) => p.id === profileId);
    expect(profile).toBeDefined();
    for (const field of PROFILE_LIST_FIELDS) {
      expect(profile).toHaveProperty(field);
    }
    // Known gap, not a bug to silently fix here: listProfiles() doesn't join
    // spotify_connections, so these two fields the client also reads are
    // simply absent from the list response. app/lib/screens/profile_screen.dart
    // masks this by always re-fetching via GET /api/profiles/:id (which does
    // include them, see the test below) before rendering Spotify status, so
    // this is not a live bug today — but it means Profile objects sourced
    // from the list endpoint can never answer `hasSpotify` correctly on
    // their own. If this test starts failing because the fields showed up
    // here, the profile_screen.dart workaround may no longer be needed.
    for (const field of PROFILE_SINGLE_ONLY_FIELDS) {
      expect(profile).not.toHaveProperty(field);
    }
  });

  test("GET /api/profiles/:id (single) additionally returns the Spotify fields the list omits", async () => {
    const res = await request(app)
      .get(`/api/profiles/${profileId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    for (const field of [...PROFILE_LIST_FIELDS, ...PROFILE_SINGLE_ONLY_FIELDS]) {
      expect(res.body.profile).toHaveProperty(field);
    }
  });
});

describe("app/lib renderGeneratedOutfit contract", () => {
  // api_service.dart reads both camelCase and snake_case for these two
  // fields (`tryOnUrl ?? try_on_url`, `generationId ?? generation_id`) —
  // defensiveness left over from prior backend naming. Confirm the backend
  // only ever emits one convention, so the snake_case branch is documented
  // dead code rather than a live fallback path, per this session's
  // instruction to flag such dead code as a finding instead of removing it
  // silently (app/ is read-only for this work).
  test("wardrobeController's generated-render response uses camelCase only, matching one of the client's two accepted conventions", () => {
    const controllerSource = fs.readFileSync(
      path.join(__dirname, "../src/controllers/wardrobeController.js"),
      "utf8",
    );
    const returnBlock = controllerSource.slice(
      controllerSource.indexOf("generationId: id,"),
      controllerSource.indexOf("generationId: id,") + 200,
    );
    expect(returnBlock).toMatch(/generationId:\s*id/);
    expect(returnBlock).toMatch(/tryOnUrl:/);
    expect(returnBlock).not.toMatch(/generation_id/);
    expect(returnBlock).not.toMatch(/try_on_url/);
  });
});
