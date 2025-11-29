const express = require("express");
const router = express.Router();
const { adminLogin, verifyAdminToken } = require("../controllers/adminAuthController");
const { protect } = require("../middleware/authMiddleware");
const { rateLimiters } = require("../middleware/securityMiddleware");
const { validateRequired, validateEmail } = require("../middleware/validationMiddleware");

// Admin login with rate limiting and validation
router.post(
  "/login",
  rateLimiters.login,
  validateRequired(['email', 'password']),
  validateEmail('email'),
  adminLogin
);

// Token verification
router.get("/verify", protect, verifyAdminToken);

module.exports = router;
