const express = require("express");
const {
  optionalProtect,
  requireAiCustomerOrStaff,
} = require("../middleware/authMiddleware");
const { rateLimiters } = require("../middleware/securityMiddleware");
const { translateMenuPageTexts } = require("../controllers/translationController");

const router = express.Router();

router.post(
  "/menu-page",
  optionalProtect,
  requireAiCustomerOrStaff,
  rateLimiters.aiTranslate,
  translateMenuPageTexts,
);

module.exports = router;
