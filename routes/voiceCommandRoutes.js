const express = require("express");
const {
  optionalProtect,
  requireAiCustomerOrStaff,
} = require("../middleware/authMiddleware");
const { rateLimiters } = require("../middleware/securityMiddleware");
const { detectVoiceCommandIntent } = require("../controllers/voiceCommandController");

const router = express.Router();

router.post(
  "/intent",
  optionalProtect,
  requireAiCustomerOrStaff,
  rateLimiters.aiVoice,
  detectVoiceCommandIntent,
);

module.exports = router;
