// Shared test helpers: seed households/accounts/profiles directly in the DB and
// mint JWTs the same way the real auth flow does.
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const { getDb } = require("../src/config/database");

async function seedHousehold(name = "House") {
  const db = await getDb();
  const h = await db.run("INSERT INTO households (name) VALUES (?)", name);
  const householdId = h.lastID;
  const a = await db.run(
    "INSERT INTO accounts (household_id, email, password_hash) VALUES (?, ?, ?)",
    householdId,
    `${name}-${Date.now()}@example.com`,
    "x",
  );
  return { householdId, accountId: a.lastID, email: `${name}@example.com` };
}

async function seedProfile(householdId, name = "Alex") {
  const db = await getDb();
  const p = await db.run(
    "INSERT INTO profiles (household_id, name) VALUES (?, ?)",
    householdId,
    name,
  );
  return p.lastID;
}

function tokenFor({ accountId, householdId, email }) {
  return jwt.sign(
    { accountId, householdId, email: email || "a@b.c" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

// A small valid JPEG buffer for upload tests.
function jpegBuffer(w = 64, h = 64) {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 120, g: 140, b: 160 } },
  })
    .jpeg()
    .toBuffer();
}

module.exports = { seedHousehold, seedProfile, tokenFor, jpegBuffer };
