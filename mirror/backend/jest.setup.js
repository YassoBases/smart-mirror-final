// Runs before each test file. Isolates the DB (in-memory), the image output dir
// (a temp folder), and pins JWT_SECRET. Sidecar URLs are left unset so the
// upload pipeline exercises its bg-removal / BLIP-2 fallbacks deterministically.
const os = require("os");
const path = require("path");
const fs = require("fs");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.SMART_MIRROR_DB = ":memory:";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wardrobe-test-"));
process.env.WARDROBE_DATA_DIR = tmp;

delete process.env.BG_REMOVER_URL;
delete process.env.BLIP2_ENDPOINT_URL;
delete process.env.PREF_RANKER_URL;
