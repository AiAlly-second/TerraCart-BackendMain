const express = require("express");
const {
  getNearbyCarts,
  getCartById,
  updateCartSettings,
  getMyCartSettings,
} = require("../controllers/cartController");
const { optionalProtect, protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

// Public routes for customer frontend
router.get("/nearby", optionalProtect, getNearbyCarts);

// Protected routes for cart admins - MUST come before /:id route
router.get("/my-settings", protect, authorize(["admin", "cart_admin"]), getMyCartSettings);
router.put("/my-settings", protect, authorize(["admin", "cart_admin"]), updateCartSettings);

// Public route for getting cart by ID - MUST come after specific routes
router.get("/:id", optionalProtect, getCartById);

module.exports = router;

