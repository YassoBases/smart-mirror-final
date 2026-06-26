const request = require("supertest");
const app = require("../src/app");
const { seedHousehold, seedProfile, tokenFor, jpegBuffer } = require("./helpers");

describe("body photo routes", () => {
  let house, token, profileId, img;

  beforeAll(async () => {
    house = await seedHousehold("Body");
    token = tokenFor(house);
    profileId = await seedProfile(house.householdId, "Sam");
    img = await jpegBuffer(80, 160);
  });

  const base = () => `/api/profiles/${profileId}`;
  const auth = (r) => r.set("Authorization", `Bearer ${token}`);

  test("GET returns null before any upload", async () => {
    const res = await auth(request(app).get(`${base()}/body-photo`));
    expect(res.status).toBe(200);
    expect(res.body.bodyPhotoUrl).toBeNull();
  });

  test("POST stores the body photo and GET returns its URL", async () => {
    const post = await auth(request(app).post(`${base()}/body-photo`)).attach(
      "photo",
      img,
      { filename: "me.jpg", contentType: "image/jpeg" },
    );
    expect(post.status).toBe(200);
    expect(post.body.bodyPhotoUrl).toContain(`/wardrobe/${profileId}/body/base.jpg`);

    const get = await auth(request(app).get(`${base()}/body-photo`));
    expect(get.body.bodyPhotoUrl).toContain("/body/base.jpg");
  });

  test("POST without a file is 400", async () => {
    const res = await auth(request(app).post(`${base()}/body-photo`));
    expect(res.status).toBe(400);
  });
});
