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
router.post("/", authorize(["admin", "franchise_admin", "super_admin"]), createInventoryItem);

// Update inventory item
router.patch("/:id", authorize(["admin", "franchise_admin", "super_admin"]), updateInventoryItem);

// Update stock quantity
router.patch("/:id/stock", authorize(["admin", "franchise_admin", "super_admin"]), updateStock);

// Delete inventory item
router.delete("/:id", authorize(["admin", "franchise_admin", "super_admin"]), deleteInventoryItem);

module.exports = router;











