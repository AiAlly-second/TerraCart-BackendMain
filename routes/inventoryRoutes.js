const express = require("express");
const {
  getAllInventory,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  updateStock,
  getInventoryStats,
} = require("../controllers/inventoryController");
const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

// All routes require authentication
router.use(protect);

// Get inventory statistics
router.get("/stats", getInventoryStats);

// Get all inventory items
router.get("/", getAllInventory);

// Get single inventory item
router.get("/:id", getInventoryItem);

// Create inventory item
// Only managers (store managers) and web admins can add new items
router.post(
  "/",
  authorize(["admin", "franchise_admin", "super_admin", "manager"]),
  createInventoryItem
);

// Update inventory item (name, unit, thresholds, etc.) - manager + web admins
router.patch(
  "/:id",
  authorize(["admin", "franchise_admin", "super_admin", "manager"]),
  updateInventoryItem
);

// Update stock quantity - allow manager and cook, plus web admins
router.patch(
  "/:id/stock",
  authorize(["admin", "franchise_admin", "super_admin", "manager", "cook"]),
  updateStock
);

// Delete inventory item - manager + web admins
router.delete(
  "/:id",
  authorize(["admin", "franchise_admin", "super_admin", "manager"]),
  deleteInventoryItem
);

module.exports = router;











