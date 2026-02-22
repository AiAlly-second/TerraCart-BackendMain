const express = require("express");
const {
  getNearbyCarts,
  getAvailableCarts,
  getCartById,
  updateCartSettings,
  getMyCartSettings,
  getCartByAdminId,
  getCartContactPublic,
} = require("../controllers/cartController");
const { optionalProtect, protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

// Public routes for customer frontend
router.get("/nearby", optionalProtect, getNearbyCarts);
router.get("/available", optionalProtect, getAvailableCarts);
router.get("/public-contact", getCartContactPublic);

// Protected routes for cart admins - MUST come before /:id route
router.get("/my-settings", protect, authorize(["admin", "cart_admin"]), getMyCartSettings);
router.put("/my-settings", protect, authorize(["admin", "cart_admin"]), updateCartSettings);
router.get("/by-admin/:userId", protect, authorize(["admin", "cart_admin", "franchise_admin", "super_admin"]), getCartByAdminId);

// Public route for getting cart by ID - MUST come after specific routes
router.get("/:id", optionalProtect, getCartById);

module.exports = router;

