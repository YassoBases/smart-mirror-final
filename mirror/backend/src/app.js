const express = require("express");
const cors = require("cors");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const fs = require("fs");

const authRoutes = require("./routes/auth");
const householdRoutes = require("./routes/households");
const profileRoutes = require("./routes/profiles");
const gmailRoutes = require("./routes/gmail");
const spotifyRoutes = require("./routes/spotify");
const mirrorsRoutes = require("./routes/mirrors");
const devicesRoutes    = require("./routes/devices");
const alertsRoutes     = require("./routes/alerts");
const newsRoutes       = require("./routes/news");
const provisioningRoutes = require("./routes/provisioning");
const wardrobeRoutes = require("./routes/wardrobe");
const settingsRoutes = require("./routes/settings");
const { getByMirrorId } = require("./controllers/profileController");

const app = express();

// Open CORS for development — allows:
//   - Mirror UI on the same machine (localhost:3001)
//   - Mirror UI served from the Pi over the LAN (192.168.x.x:3001)
//   - Flutter web preview (localhost:8080)
// Lock this down to specific origins before any public deployment.
app.use(cors());
app.use(express.json());

// Serve uploaded faces statically at http://127.0.0.1:3000/faces/filename.jpg
app.use("/faces", express.static(path.join(__dirname, "../data/faces")));

// Serve alert snapshot images at http://<host>:3000/alert-snapshots/filename.jpg
app.use("/alert-snapshots", express.static(path.join(__dirname, "../data/alert-snapshots")));

// Serve wardrobe item / body / render images, same mechanism as faces.
// e.g. http://<host>:3000/wardrobe/<profileId>/<itemId>/nobg.png
app.use("/wardrobe", express.static(path.join(__dirname, "../data/wardrobe")));

// Demo acceptance dashboard (admin/defense): self-contained page that plots the
// acceptance metrics. http://<host>:3000/admin/wardrobe/?mid=demo-mirror
app.use("/admin/wardrobe", express.static(path.join(__dirname, "../../tools/acceptance_dashboard")));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/households", householdRoutes);
app.use("/api/profiles", profileRoutes);
// Household shared settings (keys + AI config) for the phone app (JWT).
app.use("/api/settings", settingsRoutes);
// Wardrobe (Flutter, JWT) — nested under each profile, e.g.
// /api/profiles/:profileId/wardrobe/items. Mounted after profileRoutes; its
// deeper paths never collide with the profiles router's /:id routes.
app.use("/api/profiles/:profileId", wardrobeRoutes.jwtRouter);
// Gmail OAuth callback — Google calls this directly, no JWT
app.use("/api/gmail", gmailRoutes);
// Spotify OAuth callback — Spotify calls this directly, no JWT
app.use("/api/spotify", spotifyRoutes);

// Public mirror endpoint — no auth, used by the mirror display (profile list)
app.get("/api/mirror/:mirrorId/profiles", getByMirrorId);

// Mirror routes — active user polling, Gmail status, Gmail messages
app.use("/api/mirrors", mirrorsRoutes);
// Wardrobe for the mirror widget — no JWT, resolves the active profile from
// ?mid=<mirrorId>. Distinct /wardrobe prefix, so it never overlaps the routes above.
app.use("/api/mirrors/wardrobe", wardrobeRoutes.mirrorRouter);

// FCM device token registration (authenticated)
app.use("/api/devices", devicesRoutes);

// Security alerts — store & fetch unknown-face alerts (authenticated)
app.use("/api/alerts", alertsRoutes);

// RSS proxy — server-side fetch avoids client CORS issues (no auth, allowlisted hosts)
app.use("/api/news", newsRoutes);

// BLE WiFi re-provisioning — start/stop "Change WiFi" setup mode (authenticated)
app.use("/api/provisioning", provisioningRoutes);

// Health check — useful for the mirror to verify connectivity
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Network info — the mirror UI is a browser and can't read the Pi's LAN IP,
// so the backend surfaces it here. The pairing QR embeds the returned
// apiBaseUrl so the phone self-configures the right host on any network
// (home WiFi or hotspot). See MirrorIdQRCode.jsx.
app.get("/api/mirror/netinfo", (_req, res) => {
  const port = Number(process.env.PORT) || 3000;

  // Explicit override for multi-interface / edge-case hosts (see backend/.env).
  let ip = process.env.MIRROR_LAN_IP || null;

  if (!ip) {
    // Skip virtual/container interfaces — they produce unreachable IPs for phones.
    const VIRTUAL_IFACE = /^(docker|br-|veth|tun|tap|tailscale|zt|wg|virbr)/;
    const candidates = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      if (VIRTUAL_IFACE.test(name)) continue;
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal) {
          candidates.push({ name, address: a.address });
        }
      }
    }

    // Prefer a pinned interface name, else a common private range, else any.
    const pinned = process.env.MIRROR_LAN_IFACE
      ? candidates.find((c) => c.name === process.env.MIRROR_LAN_IFACE)
      : null;
    const isPrivate = (addr) =>
      /^192\.168\./.test(addr) ||
      /^10\./.test(addr) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(addr);
    const preferred = candidates.find((c) => isPrivate(c.address));

    ip = (pinned || preferred || candidates[0] || {}).address || null;
  }

  if (!ip) {
    return res.status(503).json({ error: "No LAN IPv4 address found" });
  }

  res.json({ apiBaseUrl: `http://${ip}:${port}/api`, ip, port });
});

// BLE provisioning state for the mirror UI. The root BLE daemon (provisioning/
// ble-setup.py) writes /run/smartmirror/ble-state.json during setup; we surface it
// so SetupMode shows the real Bluetooth name and PairingCodeOverlay can render the
// live 6-digit pairing code. Unauthenticated like /netinfo — a localhost/LAN read
// with no secrets (the code is a short-lived SMP passkey only useful to someone
// physically at the mirror, and it self-expires below).
const BLE_STATE_FILE = "/run/smartmirror/ble-state.json";
const BLE_PAIRING_TTL_MS = 120000; // hide a stale code if the daemon died mid-pair

app.get("/api/mirror/ble-status", (_req, res) => {
  fs.readFile(BLE_STATE_FILE, "utf8", (err, raw) => {
    if (err) return res.json({}); // daemon not running / no setup in progress
    let s;
    try {
      s = JSON.parse(raw);
    } catch {
      return res.json({});
    }

    // Drop a stale pairing code so the overlay can never get stuck showing one.
    const ageMs = Date.now() - (Number(s.updatedAt) || 0) * 1000;
    let { pairingCode = null, pairingState = "idle" } = s;
    if (pairingState === "pairing" && ageMs > BLE_PAIRING_TTL_MS) {
      pairingCode = null;
      pairingState = "idle";
    }

    res.json({
      btName: s.btName || "",
      state: s.state || "idle",
      pairingCode: pairingCode || null,
      pairingState,
    });
  });
});

// RSS proxy — fetches any RSS feed server-side so the browser avoids CORS.
// Only allows the known news source hostnames to prevent open-proxy abuse.
const RSS_ALLOWED_HOSTS = new Set([
  "feeds.bbci.co.uk",
  "www.aljazeera.com",
  "rss.dw.com",
  "feeds.reuters.com",
]);

app.get("/api/rss-proxy", (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: "Missing url param" });

  let parsed;
  try { parsed = new URL(raw); } catch { return res.status(400).json({ error: "Invalid url" }); }

  if (!RSS_ALLOWED_HOSTS.has(parsed.hostname)) {
    return res.status(403).json({ error: "Host not allowed" });
  }

  const lib = parsed.protocol === "https:" ? https : http;
  const request = lib.get(raw, { headers: { "User-Agent": "SmartMirror/1.0" } }, (upstream) => {
    if (upstream.statusCode >= 400) {
      res.status(502).json({ error: `Upstream returned ${upstream.statusCode}` });
      upstream.resume();
      return;
    }
    res.setHeader("Content-Type", upstream.headers["content-type"] || "application/rss+xml");
    upstream.pipe(res);
  });
  request.setTimeout(10000, () => { request.destroy(); res.status(504).json({ error: "Upstream timeout" }); });
  request.on("error", (err) => { if (!res.headersSent) res.status(502).json({ error: err.message }); });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Central error handler — reads the .status property thrown by services
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || "Internal server error" });
});

module.exports = app;
