const express = require("express");
const router = express.Router();
const { adminLogin, verifyAdminToken, logoutFromAllDevices } = require("../controllers/adminAuthController");
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

// Logout from all devices
router.post("/logout-all", protect, logoutFromAllDevices);

module.exports = router;
