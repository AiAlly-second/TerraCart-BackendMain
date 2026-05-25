const express = require("express");
const { rateLimiters } = require("../middleware/securityMiddleware");
const { issueAiSessionToken } = require("../controllers/aiSessionController");

const router = express.Router();

router.post("/token", rateLimiters.aiSessionIssue, issueAiSessionToken);

module.exports = router;
