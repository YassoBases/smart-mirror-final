const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const profileController = require("../controllers/profileController");
const gmailController = require("../controllers/gmailController");
const spotifyController = require("../controllers/spotifyController");
const { authenticate } = require("../middleware/auth");

// --- Set up Multer for Face Image Uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../../data/faces");
    fs.mkdirSync(dir, { recursive: true }); // Creates folder if it doesn't exist
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const rand = Math.floor(Math.random() * 1_000_000);
    cb(null, `profile_${req.params.id}_${Date.now()}_${rand}.jpg`);
  },
});
const upload = multer({ storage });

// Profile CRUD
router.post("/", authenticate, profileController.create);
router.get("/", authenticate, profileController.list);
router.get("/:id", authenticate, profileController.getOne);

// Edit name/email
router.patch("/:id", authenticate, profileController.update);

// Delete profile
router.delete("/:id", authenticate, profileController.remove);

// Face Setup Upload — single image (legacy / backward compat)
router.post(
  "/:id/face",
  authenticate,
  upload.single("face"),
  profileController.uploadFace,
);

// Multi-pose face upload — up to 24 images (3 poses × 4-frame burst)
router.post(
  "/:id/faces",
  authenticate,
  upload.array("faces", 24),
  profileController.uploadFaces,
);

// Mirror linking — set which mirror this profile appears on
router.patch("/:id/mirror", authenticate, profileController.setMirror);

// Widget configuration
router.patch("/:id/widgets", authenticate, profileController.updateWidgets);

// Per-profile AI assistant settings
router.get("/:id/ai-settings", authenticate, profileController.getAiSettings);
router.put("/:id/ai-settings", authenticate, profileController.updateAiSettings);

// Gmail per profile
router.get("/:id/gmail/connect", authenticate, gmailController.connect);
router.get("/:id/gmail/messages", authenticate, gmailController.messages);
router.delete("/:id/gmail", authenticate, gmailController.disconnect);

// Spotify per profile
router.get("/:id/spotify/connect", authenticate, spotifyController.connect);
router.post("/:id/spotify/exchange", authenticate, spotifyController.exchange);
router.get("/:id/spotify/status", authenticate, spotifyController.status);
router.delete("/:id/spotify", authenticate, spotifyController.disconnect);

module.exports = router;
