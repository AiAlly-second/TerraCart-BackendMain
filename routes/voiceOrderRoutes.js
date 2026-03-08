const express = require("express");
const multer = require("multer");
const { optionalProtect } = require("../middleware/authMiddleware");
const {
  parseTapToOrderVoice,
  transcribeTapToOrderAudio,
} = require("../controllers/voiceOrderController");

const router = express.Router();
const uploadTapToOrderAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file?.mimetype || "").toLowerCase();
    const allowed = [
      "audio/webm",
      "audio/ogg",
      "audio/wav",
      "audio/x-wav",
      "audio/mpeg",
      "audio/mp4",
      "audio/aac",
    ];
    if (allowed.includes(mime)) return cb(null, true);
    return cb(new Error("Unsupported audio format"), false);
  },
});
const tapToOrderAudioUploadMiddleware = (req, res, next) => {
  uploadTapToOrderAudio.single("audio")(req, res, (err) => {
    if (!err) return next();
    return res.status(400).json({
      message: err.message || "Invalid audio upload",
    });
  });
};

router.post(
  "/tap-to-order/transcribe",
  optionalProtect,
  tapToOrderAudioUploadMiddleware,
  transcribeTapToOrderAudio,
);
router.post("/tap-to-order", optionalProtect, parseTapToOrderVoice);

module.exports = router;
