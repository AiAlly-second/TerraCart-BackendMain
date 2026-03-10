const express = require("express");
const { optionalProtect } = require("../middleware/authMiddleware");
const { detectVoiceCommandIntent } = require("../controllers/voiceCommandController");

const router = express.Router();

router.post("/intent", optionalProtect, detectVoiceCommandIntent);

module.exports = router;
