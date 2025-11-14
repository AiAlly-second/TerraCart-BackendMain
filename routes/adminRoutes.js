const express = require("express");
const router = express.Router();
const { adminLogin, verifyAdminToken } = require("../controllers/adminAuthController");
const { protect } = require("../middleware/authMiddleware");

// Admin authentication routes
router.post("/login", adminLogin);
router.get("/verify", protect, verifyAdminToken);

module.exports = router;