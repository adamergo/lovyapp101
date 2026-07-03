const express = require("express");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, "..", "uploads"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
  },
});

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/ogg"]);
const ALLOWED_AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/webm", "audio/x-m4a", "audio/mp4"]);
const ALLOWED_MEDIA_TYPES = new Set([...ALLOWED_TYPES, ...ALLOWED_VIDEO_TYPES, ...ALLOWED_AUDIO_TYPES]);

function mediaKind(mimetype) {
  if (ALLOWED_VIDEO_TYPES.has(mimetype)) return "video";
  if (ALLOWED_AUDIO_TYPES.has(mimetype)) return "audio";
  return "image";
}

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, GIF, or WebP images are allowed"));
    }
    cb(null, true);
  },
});

const uploadMedia = multer({
  storage,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MEDIA_TYPES.has(file.mimetype)) {
      return cb(new Error("Only image, video, or audio files are allowed"));
    }
    cb(null, true);
  },
});

router.post("/", requireAuth, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image file provided" });
  res.status(201).json({ url: `/uploads/${req.file.filename}` });
});

router.post("/media", requireAuth, uploadMedia.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  res.status(201).json({ url: `/uploads/${req.file.filename}`, kind: mediaKind(req.file.mimetype) });
});

router.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || "Upload failed" });
});

module.exports = router;
