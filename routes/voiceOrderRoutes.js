const express = require("express");
const { optionalProtect } = require("../middleware/authMiddleware");
const { parseTapToOrderVoice } = require("../controllers/voiceOrderController");

const router = express.Router();

router.post("/tap-to-order", optionalProtect, parseTapToOrderVoice);

module.exports = router;
