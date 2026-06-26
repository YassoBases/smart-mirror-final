// Wardrobe routes — defined once and exposed two ways (see the dual-route
// decision in docs/wardrobe/00_backend_findings.md):
//
//   jwtRouter    mounted at /api/profiles/:profileId   (Flutter app, Bearer JWT)
//   mirrorRouter mounted at /api/mirrors/wardrobe       (mirror widget, ?mid=)
//
// Both call the same controllers; only the profile-resolution middleware differs
// and the path shape (JWT spreads endpoints under the profile; the mirror groups
// them under its /wardrobe mount). The single ENDPOINTS table keeps them in sync.

const express = require("express");
const multer = require("multer");

const { authenticate } = require("../middleware/auth");
const {
  requireProfileJwt,
  requireProfileMid,
} = require("../middleware/wardrobeProfile");
const ctrl = require("../controllers/wardrobeController");

// In-memory upload: the pipeline transforms the bytes (resize / bg-removal /
// thumbnail) before writing, so we never persist the raw multipart file as-is.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12 MB cap
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) return cb(null, true);
    cb(Object.assign(new Error("Only image uploads are allowed"), { status: 400 }));
  },
});

// One row per endpoint. `jwt` / `mirror` are the path under each router's mount;
// `file` names the multipart field (single upload) when present.
const ENDPOINTS = [
  { method: "post",   jwt: "/wardrobe/items",      mirror: "/items",      file: "image", handler: "createItem" },
  { method: "get",    jwt: "/wardrobe/items",      mirror: "/items",                     handler: "listItems" },
  { method: "patch",  jwt: "/wardrobe/items/:id",  mirror: "/items/:id",                 handler: "patchItem" },
  { method: "delete", jwt: "/wardrobe/items/:id",  mirror: "/items/:id",                 handler: "deleteItem" },
  { method: "post",   jwt: "/body-photo",          mirror: "/body-photo", file: "photo", handler: "postBodyPhoto" },
  { method: "get",    jwt: "/body-photo",          mirror: "/body-photo",                handler: "getBodyPhoto" },

  { method: "post",   jwt: "/outfit/suggest",      mirror: "/outfit/suggest",            handler: "suggestOutfit" },
  { method: "post",   jwt: "/outfit/generate",     mirror: "/outfit/generate",           handler: "generateOutfit" },
  { method: "post",   jwt: "/outfit/render",       mirror: "/outfit/render",             handler: "renderOutfit" },
  { method: "post",   jwt: "/outfit/feedback",     mirror: "/outfit/feedback",           handler: "postFeedback" },
  { method: "get",    jwt: "/outfit/feedback",     mirror: "/outfit/feedback",           handler: "getFeedback" },
  { method: "get",    jwt: "/context",             mirror: "/context",                   handler: "getContext" },
  { method: "get",    jwt: "/metrics/acceptance",  mirror: "/metrics/acceptance",        handler: "getAcceptanceMetrics" },
];

function build(router, guard, pathKey) {
  for (const ep of ENDPOINTS) {
    const mws = [guard];
    if (ep.file) mws.push(upload.single(ep.file));
    router[ep.method](ep[pathKey], ...mws, ctrl[ep.handler]);
  }
  return router;
}

// JWT router: authenticate THEN resolve + household-scope the profile.
const jwtRouter = express.Router({ mergeParams: true });
jwtRouter.use(authenticate);
build(jwtRouter, requireProfileJwt, "jwt");

// Mirror router: resolve the active profile from ?mid (no JWT).
const mirrorRouter = express.Router({ mergeParams: true });
build(mirrorRouter, requireProfileMid, "mirror");

module.exports = { jwtRouter, mirrorRouter, ENDPOINTS, upload, build };
